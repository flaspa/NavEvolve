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
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
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
