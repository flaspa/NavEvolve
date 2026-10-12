"""NavEvolve object memory (hackathon; Final Integration + Priority 2).

Object-level semantic memory in the Atlas `objects` collection, LINKED to the
place graph through stable observation ids and to observations themselves.
Detection reuses teammate Jun Jiang's Gemini LIST prompt, approximate
bearing+range positioning and merge rule (NavEvolve origin/explore-local,
brain/models.py + brain/agent_memory.py), run through our google-genai client.

Object document (field names from the Final Integration, extended in P2):
  scene_id, name (normalised), display_name, description,
  embedding [768]            Gemini Embedding 2 text vector of "name: description"
  embedding_model, embedding_dim
  position [x,y,z] | None, position_confidence, location_method
                             ("splat-bbox-raycast" | "image-center-approx" | "none")
  sightings [ {observation_id, bbox, description, position, method, confidence, seen_at} ]
  sighting_count, obs_ids, last_obs_id, first_seen, last_seen
  place_id                   convenience cache; the authoritative link is derived from the
  associated_place_ids       ACTIVE graph via obs_ids (see place_links / relink)
  embedding_ref              the source observation's existing 768-d image/text vectors

Never generated here: scene descriptions or image embeddings (perception.py owns
those). The only new model calls are detection (one per observation, cached) and
one text embedding per NEW object memory.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from datetime import datetime, timezone

from bson import ObjectId
from google.genai import types

import db
import memory
import perception

OBJECTS = "objects"
MERGE_M = 1.0          # teammate's rule: same name within 1 m is the same object
SAME_DESC_COS = 0.90   # without positions: same name AND near-identical description
LINK_M = 1.5           # viewpoint-to-place-node fallback link distance

# Teammate's prompt, verbatim (brain/models.py LIST).
LIST_PROMPT = """List 6-10 distinct physical objects clearly visible in this image (furniture, fixtures, decor, doors, windows...).
For each give a 1-2 sentence description of the object itself only (appearance, colour, material, shape) - do not
describe the room or where the object is, and its bounding box [x0,y0,x1,y1] as fractions 0..1 of image width/height
(origin top-left). JSON: [{"name": "...", "description": "...", "bbox": [x0,y0,x1,y1]}]"""


def norm_name(name: str) -> str:
    """Teammate's normalisation: lowercase, singular-ish, no punctuation."""
    n = re.sub(r"[^a-z0-9 ]", "", str(name).lower()).strip()
    return n[:-1] if n.endswith("s") and not n.endswith("ss") else n


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Detection (cached per observation) ───────────────────────────────────────
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
    coll.update_one({"_id": doc["_id"]}, {"$set": {"detected_objects": objects, "detected_at": _now(),
                                                   "detection_model": perception.VLM_MODEL}})
    return {"id": obs_id, "scene_id": doc["scene_id"], "objects": objects, "cached": False}


# ── Embeddings (same configured 768-d space as perception.py text vectors) ───
def _embed_text(text: str) -> list[float]:
    client = perception._client()
    r = client.models.embed_content(model=perception.EMBEDDING_MODEL, contents=text,
                                    config=types.EmbedContentConfig(output_dimensionality=perception.EMBEDDING_DIM))
    return perception._vector(r)


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(_unit(a), _unit(b)))


# ── Approximate position without the browser (Jun's agent_memory.object_position) ──
def approx_position(obs: dict, bbox: list[float]) -> list[float] | None:
    """Camera position + bbox-centre bearing × image-centre range. APPROXIMATE: the
    centre-ray range is not the object's depth; flagged 'image-center-approx'."""
    cam = obs.get("camera_snapshot") or {}
    pose = obs.get("pose") or {}
    pos = cam.get("position") or ([pose["x"], pose.get("y", 0), pose["z"]] if "x" in pose else None)
    if pos is None or "headingDeg" not in pose:
        return None
    vfov = math.radians(cam.get("fov", 60))
    aspect = cam.get("aspect", 16 / 9)
    cx = (bbox[0] + bbox[2]) / 2
    off = math.atan((cx - 0.5) * 2 * math.tan(vfov / 2) * aspect)
    h = math.radians(pose["headingDeg"]) - off
    dist = (obs.get("range") or {}).get("distanceM") or 2.0
    return [pos[0] + math.sin(h) * dist, pos[1], pos[2] + math.cos(h) * dist]


# ── Place links derived from the ACTIVE graph (observation ids are the stable key) ──
def _latest_graph(scene_id: str) -> dict | None:
    return db.get_db()[memory.GRAPHS].find_one(
        {"scene_id": scene_id}, {"places.place_id": 1, "places.observation_ids": 1, "places.display_xz": 1,
                                 "places.description": 1, "built_at": 1}, sort=[("built_at", -1)])


def _obs_to_place(graph: dict | None) -> dict[str, str]:
    index = {}
    for place in (graph or {}).get("places", []):
        for oid in place.get("observation_ids", []):
            index[oid] = place["place_id"]
    return index


def place_links(scene_id: str, obs_ids: list[str], graph: dict | None = None) -> dict:
    """{place_id, associated_place_ids, graph_id} for a set of supporting observations."""
    graph = graph if graph is not None else _latest_graph(scene_id)
    index = _obs_to_place(graph)
    hits = [index[o] for o in obs_ids if o in index]
    if not hits:
        # Observations not in the graph yet: nearest node within LINK_M of the newest viewpoint.
        places = (graph or {}).get("places", [])
        for oid in reversed(obs_ids):
            obs = db.get_db()[db.OBSERVATIONS].find_one({"_id": ObjectId(oid)}, {"pose": 1})
            pose = (obs or {}).get("pose") or {}
            if "x" in pose and places:
                best = min(((math.hypot(p["display_xz"][0] - pose["x"], p["display_xz"][1] - pose["z"]), p["place_id"])
                            for p in places if p.get("display_xz")), default=None)
                if best and best[0] <= LINK_M:
                    hits = [best[1]]
                break
    counts = Counter(hits)
    return {"place_id": counts.most_common(1)[0][0] if counts else None,
            "associated_place_ids": sorted(counts), "graph_id": str(graph["_id"]) if graph else None}


def place_label(scene_id: str, place_id: str | None, graph: dict | None = None) -> str | None:
    graph = graph if graph is not None else _latest_graph(scene_id)
    for p in (graph or {}).get("places", []):
        if p["place_id"] == place_id:
            return (p.get("description") or "").split(".")[0][:90] or None
    return None


def relink(scene_id: str) -> dict:
    """Refresh cached place links of every object from the active graph (after a rebuild)."""
    graph = _latest_graph(scene_id)
    coll = db.get_db()[OBJECTS]
    n = 0
    for d in coll.find({"scene_id": scene_id}, {"obs_ids": 1}):
        links = place_links(scene_id, d.get("obs_ids", []), graph)
        coll.update_one({"_id": d["_id"]}, {"$set": {**links, "relinked_at": _now()}})
        n += 1
    return {"scene_id": scene_id, "objects": n, "graph_id": links["graph_id"] if n else None}


# ── Ingest: per-sighting evidence, idempotent, merge needs more than a name ──
def _sightings_list(doc: dict) -> list[dict]:
    s = doc.get("sightings")
    if isinstance(s, list):
        return s
    # Pre-P2 record: an integer count; reconstruct minimal evidence from obs_ids (non-destructive).
    return [{"observation_id": o, "bbox": doc.get("bbox_last") if i == len(doc.get("obs_ids", [])) - 1 else None,
             "description": doc.get("description", ""), "position": doc.get("position"),
             "method": doc.get("location_method", "none"), "confidence": doc.get("position_confidence", 0),
             "seen_at": doc.get("last_seen"), "legacy": True} for i, o in enumerate(doc.get("obs_ids", []))]


def _same_object(doc: dict, key: str, pos: list[float] | None, emb: list[float] | None, place_id: str | None) -> bool:
    if doc["name"] != key:
        return False
    if pos is not None and doc.get("position") is not None:
        return math.dist(doc["position"], pos) <= MERGE_M
    # No spatial evidence on one side: require same place AND near-identical description.
    same_place = place_id is not None and (doc.get("place_id") == place_id or place_id in doc.get("associated_place_ids", []))
    similar = emb is not None and doc.get("embedding") and _cos(doc["embedding"], emb) >= SAME_DESC_COS
    return bool(same_place and similar)


def ingest(scene_id: str, obs_id: str, sightings: list[dict], embed: bool = True) -> dict:
    """Upserts sightings of one observation into `objects`. Re-running for the same
    observation adds nothing (idempotent). Positions arrive from the browser's splat
    raycast; `approx_position` is used only when none was supplied."""
    coll = db.get_db()[OBJECTS]
    obs_coll = db.get_db()[db.OBSERVATIONS]
    obs = obs_coll.find_one({"_id": ObjectId(obs_id)}, {"pose": 1, "camera_snapshot": 1, "range": 1}) or {}
    obs_coll.update_one({"_id": ObjectId(obs_id)}, {"$set": {"objects_status": "pending"}})
    graph = _latest_graph(scene_id)
    links = place_links(scene_id, [obs_id], graph)
    now = _now()
    out = []
    try:
        for s in sightings:
            key = norm_name(s.get("name", ""))
            if not key:
                continue
            pos = s.get("position")
            pos = [float(v) for v in pos] if isinstance(pos, list) and len(pos) == 3 else None
            method, conf = s.get("method", "none"), float(s.get("confidence", 0.0))
            if pos is None and s.get("bbox") and obs:
                pos, method, conf = approx_position(obs, s["bbox"]), "image-center-approx", 0.2
            desc = s.get("description", "")
            text = f"{s.get('name', key)}: {desc}".strip(": ")
            emb = None
            candidates = list(coll.find({"scene_id": scene_id, "name": key}))
            # Skip exact duplicate work: this observation already recorded as a sighting of this name.
            dup = next((d for d in candidates if obs_id in d.get("obs_ids", [])), None)
            if dup is not None:
                out.append({"id": str(dup["_id"]), "name": key, "duplicate": True})
                continue
            if embed and any(c.get("embedding") for c in candidates) and pos is None:
                emb = _embed_text(text)  # needed to decide a merge without positions
            match = next((d for d in candidates if _same_object(d, key, pos, emb, links["place_id"])), None)
            sighting = {"observation_id": obs_id, "bbox": s.get("bbox"), "description": desc, "position": pos,
                        "method": method, "confidence": conf, "seen_at": now}
            if match:
                prev = _sightings_list(match)
                n = len(prev)
                merged_pos = match.get("position")
                if pos is not None and merged_pos is not None:
                    merged_pos = [(a * n + b) / (n + 1) for a, b in zip(merged_pos, pos)]
                elif pos is not None:
                    merged_pos = pos
                coll.update_one({"_id": match["_id"]}, {"$set": {
                    "sightings": prev + [sighting], "sighting_count": n + 1, "position": merged_pos,
                    "position_confidence": max(match.get("position_confidence", 0), conf),
                    "location_method": match.get("location_method") if match.get("position") is not None else method,
                    "last_seen": now, "last_obs_id": obs_id, "bbox_last": s.get("bbox"), **links},
                    "$addToSet": {"obs_ids": obs_id}})
                out.append({"id": str(match["_id"]), "name": key, "merged": True, "sighting_count": n + 1})
            else:
                if embed and emb is None:
                    emb = _embed_text(text)
                oid = coll.insert_one({
                    "scene_id": scene_id, "name": key, "display_name": s.get("name", key), "description": desc,
                    "embedding": emb, "embedding_model": perception.EMBEDDING_MODEL if emb else None,
                    "embedding_dim": len(emb) if emb else None,
                    "position": pos, "position_confidence": conf, "location_method": method,
                    "sightings": [sighting], "sighting_count": 1, "obs_ids": [obs_id], "last_obs_id": obs_id,
                    "bbox_last": s.get("bbox"), "first_seen": now, "last_seen": now, **links,
                    "embedding_ref": {"observation_id": obs_id, "fields": ["image_embedding", "text_embedding"]},
                }).inserted_id
                out.append({"id": str(oid), "name": key, "merged": False, "sighting_count": 1})
        obs_coll.update_one({"_id": ObjectId(obs_id)}, {"$set": {"objects_status": "done", "objects_ingested_at": now}})
    except Exception:
        obs_coll.update_one({"_id": ObjectId(obs_id)}, {"$set": {"objects_status": "error"}})
        raise
    return {"scene_id": scene_id, "observation_id": obs_id, **links, "objects": out}


def backfill(scene_id: str, limit: int = 5) -> dict:
    """Bounded: detect + ingest enriched observations that have no object memories yet.
    Positions are approximate (no browser raycast available server-side)."""
    coll = db.get_db()[db.OBSERVATIONS]
    done = []
    query = {"scene_id": scene_id, "perception.status": "done", "objects_status": {"$ne": "done"}}
    for d in coll.find(query, {"_id": 1}).sort("timestamp", 1).limit(limit):
        oid = str(d["_id"])
        det = detect(oid)
        r = ingest(scene_id, oid, det["objects"])
        done.append({"observation_id": oid, "detected": len(det["objects"]), "objects": len(r["objects"])})
    remaining = coll.count_documents(query)
    return {"scene_id": scene_id, "processed": done, "remaining": remaining}


# ── Retrieval ────────────────────────────────────────────────────────────────
def _public(d: dict, graph: dict | None) -> dict:
    d = dict(d)
    d["id"] = str(d.pop("_id"))
    d.pop("embedding", None)
    for k in ("first_seen", "last_seen", "relinked_at"):
        if isinstance(d.get(k), datetime):
            d[k] = d[k].isoformat()
    for s in d.get("sightings", []) if isinstance(d.get("sightings"), list) else []:
        if isinstance(s.get("seen_at"), datetime):
            s["seen_at"] = s["seen_at"].isoformat()
    if isinstance(d.get("sightings"), int):
        d["sighting_count"] = d["sightings"]
    # Links are derived live from the active graph, so a policy change never leaves them dangling.
    d.update(place_links(d["scene_id"], d.get("obs_ids", []), graph))
    d["place_label"] = place_label(d["scene_id"], d.get("place_id"), graph)
    return d


def search(scene_id: str, query: str | None, limit: int = 20) -> list[dict]:
    """Keyword search (every term in name/description)."""
    terms = [t for t in norm_name(query or "").split() if len(t) > 2]
    graph = _latest_graph(scene_id)
    out = []
    for d in db.get_db()[OBJECTS].find({"scene_id": scene_id}).sort([("sighting_count", -1), ("position_confidence", -1)]):
        hay = f"{d['name']} {d.get('description', '')}".lower()
        if terms and not all(t in hay for t in terms):
            continue
        out.append(_public(d, graph))
        if len(out) >= limit:
            break
    return out


def semantic_search(scene_id: str, query: str, k: int = 5, min_score: float = 0.55) -> dict:
    """Embed the query (768-d) and rank object memories by cosine, with a keyword boost.
    Returns evidence only: ids, counts, places; nothing here claims the object is visible."""
    q = _embed_text(query)
    qterms = [t for t in norm_name(query).split() if len(t) > 2]
    graph = _latest_graph(scene_id)
    scored = []
    for d in db.get_db()[OBJECTS].find({"scene_id": scene_id}):
        if not d.get("embedding"):
            continue
        score = _cos(d["embedding"], q)
        hay = f"{d['name']} {d.get('description', '')}".lower()
        if qterms and all(t in hay for t in qterms):
            score += 0.15
        elif qterms and any(t in d["name"] for t in qterms):
            score += 0.08
        scored.append((score, d))
    scored.sort(key=lambda s: -s[0])
    items = []
    for score, d in scored[:k]:
        if score < min_score:
            break
        item = _public(d, graph)
        item["score"] = round(score, 4)
        items.append(item)
    return {"scene_id": scene_id, "query": query, "embedding_dim": len(q), "items": items}


def objects_in_place(scene_id: str, place_id: str) -> list[dict]:
    graph = _latest_graph(scene_id)
    index = _obs_to_place(graph)
    out = []
    for d in db.get_db()[OBJECTS].find({"scene_id": scene_id}):
        if any(index.get(o) == place_id for o in d.get("obs_ids", [])) or place_links(scene_id, d.get("obs_ids", []), graph)["place_id"] == place_id:
            out.append(_public(d, graph))
    out.sort(key=lambda o: -(o.get("sighting_count") or 0))
    return out


def find_places(scene_id: str, query: str) -> list[dict]:
    """Places whose description mentions the query terms (e.g. 'dining area')."""
    terms = [t for t in norm_name(query).split() if len(t) > 2]
    out = []
    for p in (_latest_graph(scene_id) or {}).get("places", []):
        text = (p.get("description") or "").lower()
        if terms and all(t in text for t in terms):
            out.append({"place_id": p["place_id"], "label": place_label(scene_id, p["place_id"]),
                        "observations": len(p.get("observation_ids", []))})
    return out
