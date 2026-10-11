"""NavEvolve memory: ingest observations into embeddings + world-positioned objects, and search them."""

from __future__ import annotations

import asyncio
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from bson import ObjectId

import db
import models_impl as models

MERGE_M = 0.75
DEFAULT_RANGE_M = 2.0
_queue: asyncio.Queue | None = None
_workers: list[asyncio.Task] = []


async def _worker(q: asyncio.Queue) -> None:
    while True:
        obs_id = await q.get()
        try:
            await ingest(obs_id)
        except Exception:  # noqa: BLE001  (ingest already marks the doc "error")
            pass
        q.task_done()


async def enqueue(obs_id: str) -> None:
    global _queue
    loop_q = _queue
    if loop_q is None or not _workers or _workers[0].get_loop() is not asyncio.get_running_loop():
        _queue = loop_q = asyncio.Queue()
        _workers[:] = [asyncio.create_task(_worker(loop_q)) for _ in range(4)]
    loop_q.put_nowait(obs_id)


def object_position(obs: dict, bbox: list[float]) -> list[float]:
    """Camera position + bbox-centre direction x range. headingDeg = atan2(dir.x, dir.z); +heading = left."""
    cam = obs.get("camera_snapshot") or {}
    pos = cam.get("position") or [obs["pose"]["x"], obs["pose"]["y"], obs["pose"]["z"]]
    vfov = math.radians(cam.get("fov", 60))
    aspect = cam.get("aspect", 16 / 9)
    cx = (bbox[0] + bbox[2]) / 2
    # angle to the right of the optical axis
    off = math.atan((cx - 0.5) * 2 * math.tan(vfov / 2) * aspect)
    h = math.radians(obs["pose"]["headingDeg"]) - off  # right = decreasing heading
    dist = obs.get("rangeM") or (obs.get("range") or {}).get("distanceM") or DEFAULT_RANGE_M
    return [pos[0] + math.sin(h) * dist, pos[1], pos[2] + math.cos(h) * dist]


def _norm(name: str) -> str:
    return " ".join(name.lower().split())


def _merge(scene_id: str, obs_id: str, o: dict, pos: list[float]) -> None:
    coll = db.get_db()["objects"]
    key = _norm(o["name"])
    for d in coll.find({"scene_id": scene_id, "name": key}):
        if math.dist(d["position"], pos) <= MERGE_M:
            n = d["sightings"]
            new = [(a * n + b) / (n + 1) for a, b in zip(d["position"], pos)]
            coll.update_one({"_id": d["_id"]}, {"$set": {
                "position": new, "sightings": n + 1, "confidence": 1 - math.exp(-(n + 1) / 2),
                "obs_ids": d["obs_ids"] + [obs_id]}})
            return
    coll.insert_one({"scene_id": scene_id, "name": key, "description": o.get("description", ""),
                     "emb": o["emb"], "position": pos, "sightings": 1, "obs_ids": [obs_id],
                     "confidence": 1 - math.exp(-0.5)})


def _ingest_sync(obs_id: str) -> None:
    coll = db.get_db()[db.OBSERVATIONS]
    oid = ObjectId(obs_id)
    try:
        obs = coll.find_one({"_id": oid})
        jpeg = bytes(obs["image_jpeg"])
        desc = models.describe(jpeg)
        objs = [{**o, "emb": models.embed_text(f"{o['name']}: {o.get('description', '')}").tolist()}
                for o in models.list_objects(jpeg)]
        coll.update_one({"_id": oid}, {"$set": {
            "img_emb": models.embed_image(jpeg).tolist(), "desc": desc,
            "desc_emb": models.embed_text(desc).tolist(), "objects": objs, "ingest": "done"}})
        for o in objs:
            _merge(obs["scene_id"], obs_id, o, object_position(obs, o["bbox"]))
    except Exception:
        coll.update_one({"_id": oid}, {"$set": {"ingest": "error"}})
        raise


async def ingest(obs_id: str) -> None:
    await asyncio.to_thread(_ingest_sync, obs_id)


def search(scene_id: str, query: str, k: int = 3, verify: bool = True) -> list[dict]:
    q = models.embed_text(query)
    cands = []
    # ponytail: brute-force numpy over the scene; swap for Atlas Vector Search ($vectorSearch) when it grows.
    for d in db.get_db()["objects"].find({"scene_id": scene_id}, {"emb": 1, "position": 1, "obs_ids": {"$slice": -1}, "name": 1}):
        cands.append((float(np.dot(q, d["emb"])), "object", d["position"], d["obs_ids"][-1], d["name"], None))
    for d in db.get_db()[db.OBSERVATIONS].find({"scene_id": scene_id, "desc_emb": {"$exists": True}},
                                              {"desc_emb": 1, "pose": 1}):  # skip images + other vectors
        p = d["pose"]
        cands.append((float(np.dot(q, d["desc_emb"])), "desc", [p["x"], p["y"], p["z"]], str(d["_id"]), query, p["headingDeg"]))
    out = []
    for score, src, pos, obs_id, name, heading in sorted(cands, key=lambda c: -c[0]):
        if any(math.dist(pos, r["position"]) < MERGE_M for r in out):
            continue
        r = {"position": pos, "obs_id": obs_id, "name": name, "score": score, "source": src,
             "verified": False, "reason": "", "headingDeg": heading}
        out.append(r)
        if len(out) == k:
            break
    if verify:
        def check(r):
            v = models.verify(db.get_observation(r["obs_id"], with_image=True), query)
            r["verified"], r["reason"] = bool(v["visible"]), v.get("reason", "")
        with ThreadPoolExecutor(k) as ex:
            list(ex.map(check, out))
    return out


def known_objects(scene_id: str) -> list[dict]:
    return [{"name": d["name"], "position": d["position"], "confidence": d["confidence"]}
            for d in db.get_db()["objects"].find({"scene_id": scene_id})]


def wipe(scene_id: str) -> None:
    d = db.get_db()
    d["objects"].delete_many({"scene_id": scene_id})
    d[db.OBSERVATIONS].update_many({"scene_id": scene_id}, {"$unset": {
        k: "" for k in ("img_emb", "desc", "desc_emb", "objects", "ingest")}})
