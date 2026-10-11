"""NavEvolve MongoDB Atlas access (hackathon, Milestone 1).

Server-side only. The connection string is read from brain/.env and never
leaves this process: nothing here returns the URI or any part of it.

    MONGODB_URI   mongodb+srv://… (Atlas Sandbox)
    MONGODB_DB    database name
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from bson import Binary, ObjectId
from pymongo import DESCENDING, MongoClient
from pymongo.database import Database

TEST_COLLECTION = "navevolve_healthcheck"
OBSERVATIONS = "observations"
SESSIONS = "capture_sessions"

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


def current_session() -> str:
    """Id of the active capture session (the newest), created on first use."""
    latest = get_db()[SESSIONS].find_one(sort=[("started_at", DESCENDING)])
    return latest["session_id"] if latest else new_session()


def new_session() -> str:
    """Starts a fresh capture run. Existing observations are kept."""
    now = datetime.now(timezone.utc)
    session_id = now.strftime("s-%Y%m%d-%H%M%S-") + f"{now.microsecond // 1000:03d}"
    get_db()[SESSIONS].insert_one({"session_id": session_id, "started_at": now})
    return session_id


def insert_observation(doc: dict, jpeg: bytes) -> str:
    """Stores one egocentric observation; the JPEG is kept as BSON binary."""
    record = {**doc, "session_id": current_session(), "image_jpeg": Binary(jpeg),
              "image_bytes": len(jpeg), "stored_at": datetime.now(timezone.utc)}
    return str(get_db()[OBSERVATIONS].insert_one(record).inserted_id)


def _public(doc: dict) -> dict:
    doc = dict(doc)
    doc["id"] = str(doc.pop("_id"))
    doc.pop("image_jpeg", None)
    doc.pop("image_embedding", None)
    doc.pop("text_embedding", None)
    if isinstance(doc.get("stored_at"), datetime):
        doc["stored_at"] = doc["stored_at"].isoformat()
    return doc


def count_observations(scene_id: str | None = None, session_id: str | None = None) -> int:
    query = {"scene_id": scene_id} if scene_id else {}
    if session_id:
        query["session_id"] = session_id
    return get_db()[OBSERVATIONS].count_documents(query)


def scene_counts() -> list[dict]:
    pipeline = [{"$group": {"_id": "$scene_id", "count": {"$sum": 1}}}, {"$sort": {"_id": 1}}]
    return [{"scene_id": d["_id"], "count": d["count"]} for d in get_db()[OBSERVATIONS].aggregate(pipeline)]


def delete_observations(scene_id: str | None = None) -> int:
    """Deletes observation documents only — one scene, or all when scene_id is None."""
    query = {"scene_id": scene_id} if scene_id else {}
    return get_db()[OBSERVATIONS].delete_many(query).deleted_count


def list_observations(scene_id: str | None = None, limit: int = 20) -> list[dict]:
    query = {"scene_id": scene_id} if scene_id else {}
    # Embedding vectors stay in MongoDB; the gallery list does not need them.
    hidden = {"image_jpeg": 0, "image_embedding": 0, "text_embedding": 0}
    cursor = get_db()[OBSERVATIONS].find(query, hidden).sort("stored_at", DESCENDING).limit(limit)
    return [_public(d) for d in cursor]


def get_observation(obs_id: str, with_image: bool = False) -> dict | bytes | None:
    doc = get_db()[OBSERVATIONS].find_one({"_id": ObjectId(obs_id)})
    if doc is None:
        return None
    return bytes(doc["image_jpeg"]) if with_image else _public(doc)


def close() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


def insert_episode(ep: dict) -> str:
    return str(get_db().episodes.insert_one(ep).inserted_id)
