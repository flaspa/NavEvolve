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
    GET  /cognitive-map    latest cognitive graph + harness status/policy
    POST /observations/{id}/enrich   Gemini description for one observation (perception.py)
    POST /talk/verify      {observation_id, goal} → is the goal visible in that JPEG?
    POST /talk             {question, memories[]} → Gemini answer grounded in those memories
    POST /talk/intent      {text} → structured intent {intent, target} for unfamiliar phrasing
    DELETE /observations   local dev only: delete one scene's or all observations
"""

from __future__ import annotations

import asyncio
import base64
import os
from datetime import datetime
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
import memory  # noqa: E402
import perception  # noqa: E402
import talk  # noqa: E402
import agent_memory  # noqa: E402  (the agent's object memory; memory = the place map)

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
    task = asyncio.create_task(_agent_loop()) if "_agent_loop" in globals() else None
    yield
    task and task.cancel()
    db.close()


app = FastAPI(title="NavEvolve Brain", lifespan=lifespan)
import agent_ws  # noqa: E402

app.include_router(agent_ws.router)
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
    await agent_memory.enqueue(obs_id)  # background ingest (embeddings, objects)
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


def _cognitive_map(scene_id: str | None) -> dict:
    status = db.get_db()["harness_runs"].find_one({"_id": "status"}, {"_id": 0}) or {"status": "idle"}
    if isinstance(status.get("updated_at"), datetime):
        status["updated_at"] = status["updated_at"].isoformat()
    return {"graph": memory.latest_graph(scene_id), "harness": status}


@app.get("/cognitive-map")
async def cognitive_map(scene_id: str | None = None) -> dict:
    """Read-only: places (no vectors), traversal edges, policy and harness status."""
    try:
        return await anyio.to_thread.run_sync(_cognitive_map, scene_id)
    except Exception as exc:  # noqa: BLE001
        raise _db_error(exc) from exc


@app.post("/observations/{obs_id}/enrich")
async def enrich_observation(obs_id: str) -> dict:
    """Runs the Milestone 3 pipeline on one observation (idempotent) and returns its description."""
    try:
        await anyio.to_thread.run_sync(perception.enrich_observation, obs_id, False)
        doc = await anyio.to_thread.run_sync(db.get_observation, obs_id, False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"enrichment failed: {type(exc).__name__}: {exc}"[:300]) from exc
    if doc is None:
        raise HTTPException(status_code=404, detail="observation not found")
    return {"id": obs_id, "description": doc.get("description"), "description_text": doc.get("description_text"),
            "perception": doc.get("perception")}


class VerifyRequest(BaseModel):
    observation_id: str
    goal: str = Field(min_length=1, max_length=200)


@app.post("/talk/verify")
async def talk_verify(req: VerifyRequest) -> dict:
    try:
        return await anyio.to_thread.run_sync(talk.verify, req.observation_id, req.goal)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"verify failed: {type(exc).__name__}: {exc}"[:300]) from exc


class TalkRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    memories: list[dict] = Field(default_factory=list)


@app.post("/talk")
async def talk_answer(req: TalkRequest) -> dict:
    try:
        return await anyio.to_thread.run_sync(talk.answer, req.question, req.memories)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"talk failed: {type(exc).__name__}: {exc}"[:300]) from exc


class IntentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


@app.post("/talk/intent")
async def talk_intent(req: IntentRequest) -> dict:
    try:
        return await anyio.to_thread.run_sync(talk.intent, req.text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"intent failed: {type(exc).__name__}: {exc}"[:300]) from exc


# --- agent ---
try:
    import agent, agent_ws, asyncio

    def _report(t, body):
        if t.cancelled():
            print("[agent] cancelled (new goal / stop)", flush=True)
        if t.cancelled() or not t.exception():
            return
        print("[agent] crashed:", repr(t.exception()), flush=True)
        async def tell():
            try:
                await body.thought("error", f"I stopped: {t.exception()}")
            except Exception:  # browser gone too
                pass
        asyncio.create_task(tell())

    async def _agent_loop():
        task = None
        while True:
            ev = await agent_ws.next_event()
            print("[agent] loop got", ev, flush=True)
            if ev.get("event") == "goal":
                task and task.cancel()
                body = await agent_ws.get_body()
                task = asyncio.create_task(agent.find(body, agent_ws.scene_id or "interior_0759_839979", ev["text"]))
                task.add_done_callback(lambda t, b=body: _report(t, b))
            elif ev.get("event") == "stop" and task:
                task.cancel()

except ImportError:  # stream B not merged yet
    pass
# --- agent ---
