"""Seekr Brain — first milestone: egocentric perception with Liquid AI.

    Seekr ego frame (Body)  →  POST /perceive  →  LiquidAI/LFM2.5-VL-3B  →  text

Run from the `vlmserver` Conda environment:

    conda activate vlmserver
    cd /mnt/c/Flavia/Code/seekr-worlds/brain
    python -m uvicorn app:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health    liveness + model status (loading | ready | failed)
    POST /perceive  { image_data_url, scene_id?, task? } → { model, description, latency_ms }
"""

from __future__ import annotations

import base64
import io
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

# Secrets live in .env (gitignored): brain/.env first, then the repo root .env.
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE / ".env")
load_dotenv(_HERE.parent / ".env")

import memories_ai  # noqa: E402  (needs the environment loaded first)
from liquid import LiquidPerception  # noqa: E402
from navigator import goal_step  # noqa: E402
import discover as discover_mod  # noqa: E402
import postcard as postcard_mod  # noqa: E402

ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "ALLOWED_ORIGINS",
        "http://localhost:5000,http://127.0.0.1:5000",
    ).split(",")
    if origin.strip()
]

MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", "4000000"))

perception = LiquidPerception()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"[brain] Seekr Brain starting — loading {perception.model_id} in the background")
    if not memories_ai.configured():
        print("[brain] WARNING: MEMORIES_API_KEY is not configured — /memories will fail until it is set.")
    perception.load_in_background()
    yield
    print("[brain] Seekr Brain shutting down")


app = FastAPI(
    title="Seekr Brain",
    version="0.1.0",
    description="Seekr Brain, perception milestone: Liquid AI LFM2.5-VL-3B via Transformers.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "seekr-brain",
        "model": perception.model_id,
        "provider": "Liquid AI (Hugging Face Transformers)",
        "status": perception.status,
        "device": perception.device,
        "load_seconds": perception.load_seconds,
        "error": perception.error,
        "memories": "configured" if memories_ai.configured() else "missing MEMORIES_API_KEY",
    }


class PerceiveRequest(BaseModel):
    image_data_url: str = Field(min_length=32, description="JPEG/PNG data URL of Seekr's ego frame")
    scene_id: str | None = None
    task: str | None = Field(default=None, max_length=1000)


_DATA_URL_RE = re.compile(r"^data:image/[A-Za-z0-9.+-]+;base64,(.+)$", re.DOTALL)


def decode_image(data_url: str) -> Image.Image:
    match = _DATA_URL_RE.match(data_url.strip())
    if not match:
        raise HTTPException(status_code=400, detail="image_data_url must be a base64 image data URL")
    try:
        raw = base64.b64decode(match.group(1), validate=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid base64 image: {exc}") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail=f"image larger than {MAX_IMAGE_BYTES} bytes")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        return image
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decode image: {exc}") from exc


@app.post("/perceive")
async def perceive(request: PerceiveRequest) -> dict:
    if perception.status == "loading":
        raise HTTPException(status_code=503, detail="model is still loading")
    if perception.status == "failed":
        raise HTTPException(status_code=503, detail=f"model failed to load: {perception.error}")

    image = decode_image(request.image_data_url)

    # Inference is synchronous GPU work; run it off the event loop so /health
    # stays responsive while a frame is being analysed.
    try:
        result = await anyio.to_thread.run_sync(perception.perceive, image, request.task)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"perception failed: {type(exc).__name__}: {exc}") from exc

    result["scene_id"] = request.scene_id
    result["image_size"] = list(image.size)
    print(
        f"[brain] perceive scene={request.scene_id} size={image.size} "
        f"latency_ms={result['latency_ms']} task={'yes' if request.task else 'no'}"
    )
    return result


class MemoryContext(BaseModel):
    """Seekr context for one remembered egocentric view (the `json` form part)."""

    scene_id: str | None = None
    scene_name: str | None = None
    timestamp: int | None = Field(default=None, description="Unix ms of the capture")
    pose: dict | None = None
    description: str | None = Field(default=None, max_length=2000)
    goal: str | None = Field(default=None, max_length=1000)
    client_id: str | None = Field(default=None, max_length=128)


MAX_CLIP_BYTES = int(os.environ.get("MAX_CLIP_BYTES", "15000000"))


def _memories_error(exc: Exception) -> HTTPException:
    if isinstance(exc, memories_ai.MemoriesConfigError):
        return HTTPException(status_code=500, detail=str(exc))
    if isinstance(exc, memories_ai.MemoriesApiError):
        return HTTPException(status_code=502, detail=str(exc))
    return HTTPException(status_code=500, detail=f"Memories.ai request failed: {type(exc).__name__}: {exc}")


@app.post("/memories")
async def store_memory(
    video: UploadFile = File(..., description="Short egocentric clip (video/webm)"),
    json_part: str = Form(..., alias="json", description="MemoryContext as a JSON string"),
) -> dict:
    """Store one short ego clip in Memories.ai (Video Datalake file upload)."""
    try:
        context = MemoryContext.model_validate_json(json_part)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"json part is not valid MemoryContext: {exc}") from exc

    clip = await video.read()
    if not clip:
        raise HTTPException(status_code=400, detail="video part is empty")
    if len(clip) > MAX_CLIP_BYTES:
        raise HTTPException(status_code=413, detail=f"clip larger than {MAX_CLIP_BYTES} bytes")

    filename = video.filename or "seekr-memory.webm"
    content_type = video.content_type or "video/webm"

    try:
        result = await anyio.to_thread.run_sync(
            lambda: memories_ai.store_clip(
                clip,
                filename=filename,
                content_type=content_type,
                scene_id=context.scene_id,
                scene_name=context.scene_name,
                timestamp_ms=context.timestamp,
                pose=context.pose,
                description=context.description,
                goal=context.goal,
                client_id=context.client_id,
            )
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[brain] memories store failed: {type(exc).__name__}: {exc}")
        raise _memories_error(exc) from exc

    print(
        f"[brain] memory accepted by Memories.ai scene={context.scene_id} clip={len(clip)}B "
        f"id={result['memory_id']} op={result['operation']} status={result['status']}"
    )
    return result


@app.get("/memories/operations/{operation_id}")
async def memory_operation(operation_id: str) -> dict:
    """Ingest progress for a stored memory (poll until `done`)."""
    try:
        return await anyio.to_thread.run_sync(lambda: memories_ai.operation_status(operation_id))
    except Exception as exc:  # noqa: BLE001
        raise _memories_error(exc) from exc


@app.get("/memories")
async def get_memories(limit: int = 50) -> dict:
    """Memories previously stored in the Seekr collection (newest first)."""
    try:
        items = await anyio.to_thread.run_sync(lambda: memories_ai.list_memories(limit))
    except Exception as exc:  # noqa: BLE001
        raise _memories_error(exc) from exc
    return {"memories": items}


class DiscoverRequest(BaseModel):
    image_data_url: str = Field(min_length=32)
    request: str = Field(min_length=1, max_length=500)
    scene_id: str | None = None


@app.post("/discover")
async def discover_endpoint(request: DiscoverRequest) -> dict:
    """Ego frame + 'find X like this online' → Liquid object description → Nimble results."""
    if perception.status != "ready":
        raise HTTPException(status_code=503, detail=f"model not ready (status={perception.status})")
    image = decode_image(request.image_data_url)
    try:
        result = await anyio.to_thread.run_sync(discover_mod.discover, perception, image, request.request)
    except discover_mod.NimbleConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except discover_mod.NimbleApiError as exc:
        raise HTTPException(status_code=502, detail=f"Nimble search failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"discover failed: {type(exc).__name__}: {exc}") from exc
    p = result["perception"]
    print(f"[brain] discover visible={p['visible']} object={p['object']!r} query={result.get('query')!r} results={len(result['results'])}")
    return result


class PostcardRequest(BaseModel):
    images: list[str] = Field(min_length=1, max_length=3, description="1–3 local memory ego frames (data URLs)")
    descriptions: list[str] = Field(default_factory=list)
    scene_name: str | None = None


@app.post("/postcard")
async def postcard_endpoint(request: PostcardRequest) -> dict:
    """1–3 local memories → BFL FLUX.2 [pro] memory postcard (image URL)."""
    for img in request.images:
        decode_image(img)  # validates size/format; the base64 is forwarded as-is
    try:
        result = await anyio.to_thread.run_sync(
            postcard_mod.create_postcard, request.images, request.descriptions, request.scene_name
        )
    except postcard_mod.BflConfigError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except postcard_mod.BflApiError as exc:
        raise HTTPException(status_code=502, detail=f"Black Forest Labs failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"postcard failed: {type(exc).__name__}: {exc}") from exc
    print(f"[brain] postcard refs={result['references']} latency_ms={result['latency_ms']} task={result['task_id']}")
    return result


class BodyReport(BaseModel):
    """Execution facts from the Body for the deterministic rule (navigator.py)."""

    iteration: int = 0
    blocked: bool = False
    blocked_streak: int = 0
    not_visible_streak: int = 0
    last_action: str | None = None


class GoalStepRequest(BaseModel):
    image_data_url: str = Field(min_length=32)
    goal: str = Field(min_length=1, max_length=1000)
    scene_id: str | None = None
    body: BodyReport = Field(default_factory=BodyReport)


@app.post("/goal/step")
async def goal_step_endpoint(request: GoalStepRequest) -> dict:
    """One closed-loop step: ego frame + goal → Liquid perception → ONE action.

    The Brain decides (deterministic rule over perception); the Body executes
    the action on the NavMesh and calls again with a fresh frame.
    """
    if perception.status == "loading":
        raise HTTPException(status_code=503, detail="model is still loading")
    if perception.status == "failed":
        raise HTTPException(status_code=503, detail=f"model failed to load: {perception.error}")

    image = decode_image(request.image_data_url)
    try:
        result = await anyio.to_thread.run_sync(
            goal_step, perception, image, request.goal, request.body.model_dump()
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"goal step failed: {type(exc).__name__}: {exc}") from exc

    result["scene_id"] = request.scene_id
    p, a = result["perception"], result["action"]
    print(
        f"[brain] goal/step #{request.body.iteration} visible={p['target_visible']} "
        f"h={p['horizontal']} d={p['distance']} -> {a['type']} "
        f"({a.get('reason')}) latency_ms={result['latency_ms']}"
    )
    return result
