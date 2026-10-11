"""NavEvolve Perception (hackathon, Milestone 3): Gemini enrichment of one
stored egocentric observation.

    MongoDB JPEG ─► Gemini VLM ─► description (visible evidence only)
                 ├► Gemini Embedding (image) ─► image_embedding [DIM]
                 └► Gemini Embedding (text of description) ─► text_embedding [DIM]

Results are written back onto the SAME `observations` document; the JPEG,
pose, camera snapshot and range fields are never touched. Idempotent: an
observation whose perception.status is "done" is skipped unless force=True.

Settings come only from brain/.env (never printed):
    GEMINI_API_KEY, GEMINI_VLM_MODEL, GEMINI_EMBEDDING_MODEL, GEMINI_EMBEDDING_DIM

Standalone run (does not touch the API server):
    .venv/Scripts/python perception.py              # next un-enriched observation
    .venv/Scripts/python perception.py --id <obs>   # a specific one
    .venv/Scripts/python perception.py --id <obs> --force
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")

from google import genai  # noqa: E402
from google.genai import types  # noqa: E402

import db  # noqa: E402

VLM_MODEL = os.environ.get("GEMINI_VLM_MODEL", "").strip()
EMBEDDING_MODEL = os.environ.get("GEMINI_EMBEDDING_MODEL", "").strip()
EMBEDDING_DIM = int(os.environ.get("GEMINI_EMBEDDING_DIM", "768"))

DESCRIBE_PROMPT = (
    "You are the visual perception of an embodied agent exploring an indoor space. "
    "This is its first-person view. Describe ONLY what is visibly present; do not guess "
    "at anything outside the frame. Return JSON with keys: "
    '"room_type" (best guess from visible evidence, e.g. "bathroom", "hallway"), '
    '"room_characteristics" (floor, walls, ceiling, lighting, colours, materials), '
    '"doorways" (visible doors/openings and where they are in the frame), '
    '"furniture" (list of visible furniture), '
    '"landmarks" (distinctive, memorable features useful to recognise this place again), '
    '"spatial_layout" (left/centre/right and near/far relationships between items), '
    '"summary" (one or two sentences).'
)


def _client() -> genai.Client:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    missing = [k for k, v in (("GEMINI_API_KEY", key), ("GEMINI_VLM_MODEL", VLM_MODEL),
                              ("GEMINI_EMBEDDING_MODEL", EMBEDDING_MODEL)) if not v]
    if missing:
        raise RuntimeError(f"missing in brain/.env: {', '.join(missing)}")
    return genai.Client(api_key=key)


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def _vector(response) -> list[float]:
    values = list(response.embeddings[0].values)
    if len(values) != EMBEDDING_DIM or not all(math.isfinite(v) for v in values):
        raise ValueError(f"embedding has {len(values)} values (expected {EMBEDDING_DIM} finite)")
    return values


def _usage(response) -> dict | None:
    u = getattr(response, "usage_metadata", None)
    if u is None:
        return None
    return {k: getattr(u, k, None) for k in
            ("prompt_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count")}


def describe_text(description: dict) -> str:
    """Flattens the structured description into the text that gets embedded."""
    parts = []
    for key in ("summary", "room_type", "room_characteristics", "doorways",
                "furniture", "landmarks", "spatial_layout"):
        value = description.get(key)
        if value:
            parts.append(f"{key.replace('_', ' ')}: "
                         f"{', '.join(map(str, value)) if isinstance(value, list) else value}")
    return "\n".join(parts)


def enrich_observation(obs_id: str | None = None, force: bool = False) -> dict:
    """Enriches one observation and returns its timing/usage report."""
    coll = db.get_db()[db.OBSERVATIONS]
    timings: dict[str, float] = {}
    t_total = time.perf_counter()

    t0 = time.perf_counter()
    if obs_id:
        doc = coll.find_one({"_id": ObjectId(obs_id)}, {"image_jpeg": 1, "perception": 1})
    else:
        doc = coll.find_one({"perception.status": {"$ne": "done"}}, {"image_jpeg": 1, "perception": 1},
                            sort=[("stored_at", 1)])
    timings["mongo_fetch_ms"] = _ms(t0)
    if doc is None:
        return {"skipped": True, "reason": "no matching observation"}
    obs_id = str(doc["_id"])
    if not force and (doc.get("perception") or {}).get("status") == "done":
        return {"skipped": True, "reason": "already enriched", "id": obs_id}
    jpeg = bytes(doc["image_jpeg"])
    image_part = types.Part.from_bytes(data=jpeg, mime_type="image/jpeg")

    client = _client()
    try:
        t0 = time.perf_counter()
        vlm = client.models.generate_content(
            model=VLM_MODEL,
            contents=[image_part, DESCRIBE_PROMPT],
            config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.2),
        )
        timings["gemini_describe_ms"] = _ms(t0)
        description = json.loads(vlm.text)
        description_text = describe_text(description)
        if not description_text:
            raise ValueError("empty description")

        embed_config = types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM)
        t0 = time.perf_counter()
        image_embedding = _vector(client.models.embed_content(
            model=EMBEDDING_MODEL, contents=[image_part], config=embed_config))
        timings["gemini_image_embedding_ms"] = _ms(t0)

        t0 = time.perf_counter()
        text_embedding = _vector(client.models.embed_content(
            model=EMBEDDING_MODEL, contents=description_text, config=embed_config))
        timings["gemini_text_embedding_ms"] = _ms(t0)
    except Exception as exc:
        coll.update_one({"_id": doc["_id"]}, {"$set": {"perception": {
            "status": "error", "error": f"{type(exc).__name__}: {exc}"[:500],
            "processed_at": datetime.now(timezone.utc)}}})
        raise

    perception = {
        "status": "done",
        "processed_at": datetime.now(timezone.utc),
        "vlm_model": VLM_MODEL,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dim": EMBEDDING_DIM,
        "usage": _usage(vlm),
        "latency_ms": timings,
    }
    t0 = time.perf_counter()
    coll.update_one({"_id": doc["_id"]}, {"$set": {
        "description": description,
        "description_text": description_text,
        "image_embedding": image_embedding,
        "text_embedding": text_embedding,
        "perception": perception,
    }})
    timings["mongo_update_ms"] = _ms(t0)
    timings["total_ms"] = _ms(t_total)
    # Persist the final timings (update + total are only known after the write).
    coll.update_one({"_id": doc["_id"]}, {"$set": {"perception.latency_ms": timings}})
    return {"id": obs_id, "latency_ms": timings, "usage": perception["usage"], "description": description}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gemini enrichment of one observation")
    parser.add_argument("--id", help="observation _id (default: oldest un-enriched)")
    parser.add_argument("--force", action="store_true", help="re-enrich even if already done")
    args = parser.parse_args()
    print(json.dumps(enrich_observation(args.id, args.force), indent=2, default=str))
