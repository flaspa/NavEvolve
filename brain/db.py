"""NavEvolve MongoDB Atlas access (hackathon, Milestone 1).

Server-side only. The connection string is read from brain/.env and never
leaves this process: nothing here returns the URI or any part of it.

    MONGODB_URI   mongodb+srv://… (Atlas Sandbox)
    MONGODB_DB    database name
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from pymongo import MongoClient
from pymongo.database import Database

TEST_COLLECTION = "navevolve_healthcheck"

_client: MongoClient | None = None


class DbNotConfigured(RuntimeError):
    """MONGODB_URI or MONGODB_DB is missing from the environment."""


def _settings() -> tuple[str, str]:
    uri = os.environ.get("MONGODB_URI", "").strip()
    name = os.environ.get("MONGODB_DB", "").strip()
    missing = [k for k, v in (("MONGODB_URI", uri), ("MONGODB_DB", name)) if not v]
    if missing:
        raise DbNotConfigured(f"missing in brain/.env: {', '.join(missing)}")
    return uri, name


def get_db() -> Database:
    """Lazily connects once and returns the configured database."""
    global _client
    uri, name = _settings()
    if _client is None:
        _client = MongoClient(uri, serverSelectionTimeoutMS=8000, appname="navevolve")
    return _client[name]


def ping() -> dict:
    """Real round trip to the cluster."""
    db = get_db()
    db.client.admin.command("ping")
    return {"ok": True, "database": db.name}


def roundtrip() -> dict:
    """Writes one test document, reads it back by _id, then deletes it."""
    db = get_db()
    coll = db[TEST_COLLECTION]
    doc = {"kind": "healthcheck", "created_at": datetime.now(timezone.utc)}
    inserted_id = coll.insert_one(doc).inserted_id
    found = coll.find_one({"_id": inserted_id})
    coll.delete_one({"_id": inserted_id})
    return {
        "ok": found is not None and found["kind"] == "healthcheck",
        "collection": TEST_COLLECTION,
        "inserted_id": str(inserted_id),
    }


def close() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None
