"""NavEvolve Brain — Milestone 1: minimal backend, no GPU.

The pre-hackathon Seekr Brain (app.py: Liquid VLM perception, Memories.ai,
Discover, Postcards) is kept unchanged but is NOT started here. This server
loads no model and touches no GPU.

Run (from brain/):

    .venv/Scripts/python -m uvicorn server:app --port 8000      (Windows)
    .venv/bin/python -m uvicorn server:app --port 8000          (WSL/Linux)

Endpoints:
    GET  /health           liveness (status "no-perception": the Body keeps
                           Analyze Vision disabled)
    GET  /db/health        real MongoDB Atlas ping
    POST /db/roundtrip     insert → read back → delete one test document
    POST /observations     store one egocentric JPEG + pose + camera + range
    GET  /observations     recent observation metadata (+ count)
    GET  /observations/{id}            metadata
    GET  /observations/{id}/image.jpg  the stored JPEG
"""

from __future__ import annotations

import base64
import os
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")

import db  # noqa: E402  (needs the environment loaded first)

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://localhost:5000,http://127.0.0.1:5000",
    ).split(",")
    if origin.strip()
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    db.close()


app = FastAPI(title="NavEvolve Brain", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "no-perception", "service": "navevolve-brain", "milestone": 1}


def _db_error(exc: Exception) -> HTTPException:
    if isinstance(exc, db.DbNotConfigured):
        return HTTPException(status_code=503, detail=str(exc))
    # Exception type only: driver messages can echo host names.
    return HTTPException(status_code=503, detail=f"MongoDB unavailable: {type(exc).__name__}")


@app.get("/db/health")
async def db_health() -> dict:
    try:
        return await anyio.to_thread.run_sync(db.ping)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc


@app.post("/db/roundtrip")
async def db_roundtrip() -> dict:
    try:
        return await anyio.to_thread.run_sync(db.roundtrip)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc


MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", "4000000"))


class Observation(BaseModel):
    image_data_url: str = Field(min_length=32)
    scene_id: str
    timestamp: int                      # client epoch ms
    trigger: str = "manual"             # "manual" | "auto-distance"
    pose: dict                          # {x, y, z, headingDeg, pitchDeg}
    camera_snapshot: dict               # frameCapture.js cameraSnapshot
    image_width: int | None = None
    image_height: int | None = None
    range: dict | None = None           # egoRange.js centre measurement


def _decode_jpeg(data_url: str) -> bytes:
    header, _, payload = data_url.partition(",")
    if not header.startswith("data:image/jpeg;base64"):
        raise HTTPException(status_code=422, detail="image_data_url must be a base64 JPEG data URL")
    jpeg = base64.b64decode(payload, validate=True)
    if len(jpeg) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image too large")
    return jpeg


@app.post("/observations")
async def create_observation(obs: Observation) -> dict:
    jpeg = _decode_jpeg(obs.image_data_url)
    doc = obs.model_dump(exclude={"image_data_url"})
    try:
        obs_id = await anyio.to_thread.run_sync(db.insert_observation, doc, jpeg)
        total = await anyio.to_thread.run_sync(db.count_observations, None)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {"ok": True, "id": obs_id, "image_bytes": len(jpeg), "total": total}


@app.get("/observations")
async def recent_observations(scene_id: str | None = None, limit: int = 20) -> dict:
    try:
        items = await anyio.to_thread.run_sync(db.list_observations, scene_id, min(limit, 100))
        total = await anyio.to_thread.run_sync(db.count_observations, scene_id)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {"total": total, "items": items}


@app.get("/observations/{obs_id}")
async def observation(obs_id: str) -> dict:
    doc = await anyio.to_thread.run_sync(db.get_observation, obs_id, False)
    if doc is None:
        raise HTTPException(status_code=404, detail="observation not found")
    return doc


@app.get("/observations/{obs_id}/image.jpg")
async def observation_image(obs_id: str) -> Response:
    jpeg = await anyio.to_thread.run_sync(db.get_observation, obs_id, True)
    if jpeg is None:
        raise HTTPException(status_code=404, detail="observation not found")
    return Response(content=jpeg, media_type="image/jpeg")
