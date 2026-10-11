"""Memories.ai Video Datalake — persistent visual episodic memory for Seekr.

Current official API (https://docs.memories.ai/datalake):

    base   https://api.memories.ai/serve/datalake/v1
    auth   Authorization: <MEMORIES_API_KEY>
    POST /collections                    {name}                     -> {id}
    POST /videos   multipart/form-data   json=<JSON string>, file=<video>
                                          -> 202 {video_id, operation, status}
    GET  /operations/{op}                -> {done, progress, error, resource}
    GET  /videos?collection_id=&limit=   -> {videos: [...], next_cursor}

The `json` part carries the common fields: collection_id, fps, captured_at,
metadata {title, tags[], custom{}}, idempotency_key. Seekr context (scene,
Liquid description, pose, goal) travels in metadata.custom. The file is the
short WebM clip the Body records from the egocentric frame; the Datalake
does not ingest still images.

Memories.ai stores and indexes. It makes no cognitive decision here.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_URL = os.environ.get("MEMORIES_BASE_URL", "https://api.memories.ai/serve/datalake/v1")
COLLECTION_NAME = os.environ.get("MEMORIES_COLLECTION_NAME", "seekr-worlds-memories")
# The collection is created ONCE by name and its id cached here, so restarts
# reuse it (MEMORIES_COLLECTION_ID in the environment overrides both).
_COLLECTION_CACHE = Path(__file__).with_name(".memories_collection")
_TIMEOUT = 120


class MemoriesConfigError(RuntimeError):
    """MEMORIES_API_KEY is missing — a configuration error, reported loudly."""


class MemoriesApiError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"Memories.ai HTTP {status}: {body[:300]}")
        self.status = status


def api_key() -> str:
    key = os.environ.get("MEMORIES_API_KEY", "").strip()
    if not key:
        raise MemoriesConfigError(
            "MEMORIES_API_KEY is not configured. Add it to seekr-worlds/.env (or brain/.env)."
        )
    return key


def configured() -> bool:
    return bool(os.environ.get("MEMORIES_API_KEY", "").strip())


def _headers(extra: dict | None = None) -> dict:
    return {"Authorization": api_key(), **(extra or {})}


def _raise_for(response: requests.Response) -> None:
    if not response.ok:
        raise MemoriesApiError(response.status_code, response.text)


_collection_id: str | None = None


def collection_id() -> str:
    """The Seekr collection: env override, cached file, or created by name."""
    global _collection_id
    if _collection_id:
        return _collection_id

    env_id = os.environ.get("MEMORIES_COLLECTION_ID", "").strip()
    if env_id:
        _collection_id = env_id
        return env_id

    if _COLLECTION_CACHE.exists():
        cached = _COLLECTION_CACHE.read_text(encoding="utf-8").strip()
        if cached:
            _collection_id = cached
            return cached

    response = requests.post(
        f"{BASE_URL}/collections",
        headers=_headers({"Content-Type": "application/json"}),
        json={"name": COLLECTION_NAME},
        timeout=_TIMEOUT,
    )
    _raise_for(response)
    created = response.json().get("id")
    if not created:
        raise MemoriesApiError(response.status_code, f"no collection id in {response.text}")
    _COLLECTION_CACHE.write_text(created + "\n", encoding="utf-8")
    _collection_id = created
    print(f"[memories] created Memories.ai collection {COLLECTION_NAME!r}: {created}")
    return created


def _iso(timestamp_ms: int | None) -> str:
    moment = (
        datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
        if timestamp_ms
        else datetime.now(tz=timezone.utc)
    )
    return moment.isoformat(timespec="seconds").replace("+00:00", "Z")


def store_clip(
    video_bytes: bytes,
    *,
    filename: str = "seekr-memory.webm",
    content_type: str = "video/webm",
    scene_id: str | None,
    scene_name: str | None,
    timestamp_ms: int | None,
    pose: dict | None,
    description: str | None,
    goal: str | None,
    client_id: str | None,
) -> dict:
    """Upload one short egocentric clip with Seekr's context in metadata.custom."""
    captured_at = _iso(timestamp_ms)

    custom = {
        "source": "seekr-worlds",
        "scene_id": scene_id,
        "scene_name": scene_name,
        "description": description,
        "pose": pose,
        "goal": goal,
    }
    common = {
        "collection_id": collection_id(),
        "fps": 1.0,
        "captured_at": captured_at,
        "metadata": {
            "title": f"Seekr · {scene_name or scene_id or 'scene'} · {captured_at}",
            "tags": [t for t in ["seekr", scene_id] if t],
            "custom": {k: v for k, v in custom.items() if v is not None},
        },
    }
    if client_id:
        common["idempotency_key"] = str(client_id)[:128]

    # `json` is a plain text form field holding a JSON STRING; `file` is the
    # video. requests builds the multipart boundary itself.
    response = requests.post(
        f"{BASE_URL}/videos",
        headers=_headers(),
        data={"json": json.dumps(common)},
        files={"file": (filename, video_bytes, content_type)},
        timeout=_TIMEOUT,
    )
    _raise_for(response)
    body = response.json()
    return {
        "memory_id": body.get("video_id"),
        "operation": body.get("operation"),
        "status": body.get("status", "processing"),
        "captured_at": captured_at,
    }


def operation_status(operation_id: str) -> dict:
    """Ingest operation: {done, progress, error, resource}. Only trust `done`."""
    response = requests.get(f"{BASE_URL}/operations/{operation_id}", headers=_headers(), timeout=_TIMEOUT)
    _raise_for(response)
    body = response.json()
    return {
        "operation": body.get("operation", operation_id),
        "done": bool(body.get("done")),
        "progress": body.get("progress"),
        "error": body.get("error"),
        "resource": body.get("resource"),
    }


def list_memories(limit: int = 50) -> list[dict]:
    """Newest-first memories in the Seekr collection, for reload after restart."""
    response = requests.get(
        f"{BASE_URL}/videos",
        headers=_headers(),
        params={"collection_id": collection_id(), "limit": max(1, min(100, limit))},
        timeout=_TIMEOUT,
    )
    _raise_for(response)
    items = response.json().get("videos", []) or []
    out = []
    for item in items:
        metadata = item.get("metadata") or {}
        custom = metadata.get("custom") or {}
        out.append(
            {
                "memory_id": item.get("video_id"),
                "status": item.get("status"),
                "captured_at": item.get("captured_at"),
                "image_url": item.get("source_url"),  # 24 h signed URL when present
                "scene_id": custom.get("scene_id"),
                "scene_name": custom.get("scene_name"),
                "description": custom.get("description"),
                "pose": custom.get("pose"),
                "goal": custom.get("goal"),
                "title": metadata.get("title"),
            }
        )
    return out
