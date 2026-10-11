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
    GET  /gallery          contact-sheet view of stored observations
    POST /sessions         start a new capture session (observations kept)
    DELETE /observations   local dev only: delete one scene's or all observations
"""

from __future__ import annotations

import base64
import os
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
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
        counts = await anyio.to_thread.run_sync(_counts)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {"ok": True, "id": obs_id, "image_bytes": len(jpeg), **counts}


def _counts() -> dict:
    session_id = db.current_session()
    return {
        "total": db.count_observations(),
        "session_id": session_id,
        "session_total": db.count_observations(session_id=session_id),
    }


@app.get("/observations")
async def recent_observations(scene_id: str | None = None, limit: int = 20) -> dict:
    try:
        items = await anyio.to_thread.run_sync(db.list_observations, scene_id, min(limit, 100))
        total = await anyio.to_thread.run_sync(db.count_observations, scene_id)
        counts = await anyio.to_thread.run_sync(_counts)
        scenes = await anyio.to_thread.run_sync(db.scene_counts)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {**counts, "total": total, "all_total": counts["total"], "scenes": scenes, "items": items}


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


@app.get("/gallery", include_in_schema=False)
async def gallery() -> FileResponse:
    """Static contact sheet; it reads the two observation endpoints above."""
    return FileResponse(_HERE / "gallery.html", media_type="text/html")


@app.post("/sessions")
async def start_session() -> dict:
    try:
        session_id = await anyio.to_thread.run_sync(db.new_session)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {"ok": True, "session_id": session_id}


_LOOPBACK = {"127.0.0.1", "::1"}
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


def _require_local_dev(request: Request) -> None:
    """Destructive endpoints answer only loopback clients addressing localhost,
    and only while ALLOW_DEV_DELETE is not "0". Never expose this publicly."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    client = request.client.host if request.client else ""
    if os.environ.get("ALLOW_DEV_DELETE", "1") == "0" or client not in _LOOPBACK or host not in _LOCAL_HOSTS:
        raise HTTPException(status_code=403, detail="deletion is restricted to local development")


@app.delete("/observations")
async def clear_observations(request: Request, expected: int, scene_id: str | None = None) -> dict:
    """Deletes documents in the observations collection only (one scene or all).

    `expected` must equal the current count the user confirmed, so a stale
    confirmation can never delete more than was shown.
    """
    _require_local_dev(request)
    try:
        current = await anyio.to_thread.run_sync(db.count_observations, scene_id)
        if current != expected:
            raise HTTPException(status_code=409, detail=f"count changed: {current} now, {expected} confirmed")
        deleted = await anyio.to_thread.run_sync(db.delete_observations, scene_id)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc
    return {"ok": True, "deleted": deleted, "scene_id": scene_id}
