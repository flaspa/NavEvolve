"""NavEvolve object memory (hackathon, final integration).

Object-level semantic memory in the Atlas `objects` collection, LINKED to the
place graph (place_id) and to observations (obs_ids). Detection reuses
teammate Jun Jiang's Gemini LIST prompt and merge rule (NavEvolve PR #1,
brain/models.py + brain/memory.py, commit 5a8b689), run through our own
google-genai client (perception.py). No new embeddings are generated: each
object references the embeddings its source observation already has.

Object 3D positions arrive from the browser, which casts a ray through the
bounding-box centre against the Gaussian-splat surface (egoRange.js). When
that misses, the browser sends an image-centre approximation flagged as such.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone

from bson import ObjectId
from google.genai import types

import db
import memory
import perception

OBJECTS = "objects"
MERGE_M = 1.0  # teammate's rule: same name within 1 m is the same object

# Teammate's prompt, verbatim (brain/models.py LIST).
LIST_PROMPT = """List 6-10 distinct physical objects clearly visible in this image (furniture, fixtures, decor, doors, windows...).
For each give a 1-2 sentence description of the object itself only (appearance, colour, material, shape) - do not
describe the room or where the object is, and its bounding box [x0,y0,x1,y1] as fractions 0..1 of image width/height
(origin top-left). JSON: [{"name": "...", "description": "...", "bbox": [x0,y0,x1,y1]}]"""


def norm_name(name: str) -> str:
    """Teammate's normalisation: lowercase, singular-ish, no punctuation."""
    n = re.sub(r"[^a-z0-9 ]", "", str(name).lower()).strip()
    return n[:-1] if n.endswith("s") and not n.endswith("ss") else n


def detect(obs_id: str) -> dict:
    """Gemini object list for one stored JPEG; cached on the observation (idempotent)."""
    coll = db.get_db()[db.OBSERVATIONS]
    doc = coll.find_one({"_id": ObjectId(obs_id)}, {"image_jpeg": 1, "detected_objects": 1, "scene_id": 1})
    if doc is None:
        raise ValueError("observation not found")
    if doc.get("detected_objects") is not None:
        return {"id": obs_id, "scene_id": doc["scene_id"], "objects": doc["detected_objects"], "cached": True}
    client = perception._client()
    response = client.models.generate_content(
        model=perception.VLM_MODEL,
        contents=[types.Part.from_bytes(data=bytes(doc["image_jpeg"]), mime_type="image/jpeg"), LIST_PROMPT],
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.1),
    )
    raw = json.loads(response.text)
    objects = []
    for o in raw if isinstance(raw, list) else []:
        bbox = o.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox)):
            continue
        objects.append({"name": str(o.get("name", ""))[:80], "description": str(o.get("description", ""))[:300],
                        "bbox": [max(0.0, min(1.0, float(v))) for v in bbox]})
    coll.update_one({"_id": doc["_id"]}, {"$set": {"detected_objects": objects, "detected_at": datetime.now(timezone.utc),
                                                   "detection_model": perception.VLM_MODEL}})
    return {"id": obs_id, "scene_id": doc["scene_id"], "objects": objects, "cached": False}


def _place_for(scene_id: str, obs_id: str) -> str | None:
    """Place whose node contains this observation in the latest graph, if any."""
    graph = db.get_db()[memory.GRAPHS].find_one({"scene_id": scene_id}, {"places.place_id": 1, "places.observation_ids": 1, "places.display_xz": 1},
                                                sort=[("built_at", -1)])
    places = (graph or {}).get("places", [])
    for place in places:
        if obs_id in place.get("observation_ids", []):
            return place["place_id"]
    # Observation not yet in the graph (graphs are rebuilt by the harness):
    # link to the nearest place node within 1.5 m of the viewpoint, if any.
    obs = db.get_db()[db.OBSERVATIONS].find_one({"_id": ObjectId(obs_id)}, {"pose": 1})
    pose = (obs or {}).get("pose") or {}
    if "x" in pose and "z" in pose:
        best = min(((math.hypot(p["display_xz"][0] - pose["x"], p["display_xz"][1] - pose["z"]), p["place_id"])
                    for p in places if p.get("display_xz")), default=None)
        if best and best[0] <= 1.5:
            return best[1]
    return None


def ingest(scene_id: str, obs_id: str, sightings: list[dict]) -> dict:
    """Upserts positioned sightings into `objects` (merge by name within MERGE_M)."""
    coll = db.get_db()[OBJECTS]
    now = datetime.now(timezone.utc)
    place_id = _place_for(scene_id, obs_id)
    out = []
    for s in sightings:
        key = norm_name(s.get("name", ""))
        if not key:
            continue
        pos = s.get("position")
        pos = [float(v) for v in pos] if isinstance(pos, list) and len(pos) == 3 else None
        conf = float(s.get("confidence", 0.0))
        base = {"display_name": s.get("name", key), "description": s.get("description", ""), "bbox_last": s.get("bbox"),
                "location_method": s.get("method", "none"), "last_seen": now, "last_obs_id": obs_id}
        match = None
        if pos is not None:
            for d in coll.find({"scene_id": scene_id, "name": key, "position": {"$ne": None}}):
                if math.dist(d["position"], pos) <= MERGE_M:
                    match = d
                    break
        if match is None and pos is None:
            match = coll.find_one({"scene_id": scene_id, "name": key, "obs_ids": obs_id})
        if match:
            n = match["sightings"]
            new_pos = [(a * n + b) / (n + 1) for a, b in zip(match["position"], pos)] if pos and match.get("position") else (pos or match.get("position"))
            coll.update_one({"_id": match["_id"]}, {
                "$set": {**base, "position": new_pos, "sightings": n + 1,
                         "position_confidence": max(match.get("position_confidence", 0), conf),
                         "place_id": match.get("place_id") or place_id},
                "$addToSet": {"obs_ids": obs_id}})
            oid = match["_id"]
        else:
            oid = coll.insert_one({
                "scene_id": scene_id, "name": key, **base, "position": pos, "position_confidence": conf,
                "sightings": 1, "obs_ids": [obs_id], "place_id": place_id, "first_seen": now,
                # Reuse the source observation's existing 768-d vectors; none are generated here.
                "embedding_ref": {"observation_id": obs_id, "fields": ["image_embedding", "text_embedding"]},
            }).inserted_id
        out.append({"id": str(oid), "name": key, "position": pos, "place_id": place_id})
    return {"scene_id": scene_id, "observation_id": obs_id, "place_id": place_id, "objects": out}


def search(scene_id: str, query: str | None, limit: int = 20) -> list[dict]:
    terms = [t for t in norm_name(query or "").split() if len(t) > 2]
    out = []
    for d in db.get_db()[OBJECTS].find({"scene_id": scene_id}).sort([("sightings", -1), ("position_confidence", -1)]):
        hay = f"{d['name']} {d.get('description', '')}".lower()
        if terms and not all(t in hay for t in terms):
            continue
        d["id"] = str(d.pop("_id"))
        for k in ("first_seen", "last_seen"):
            if isinstance(d.get(k), datetime):
                d[k] = d[k].isoformat()
        out.append(d)
        if len(out) >= limit:
            break
    return out
