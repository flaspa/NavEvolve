"""Milestone 1 backend tests. Run from brain/: .venv/Scripts/python -m pytest -q

The Atlas tests run only when MONGODB_URI and MONGODB_DB are set in brain/.env.
"""

import os

import pytest
from fastapi.testclient import TestClient

import server

client = TestClient(server.app)
has_db = bool(os.environ.get("MONGODB_URI") and os.environ.get("MONGODB_DB"))


def test_health_needs_no_gpu_or_db():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "no-perception"


def test_db_health_reports_missing_config(monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    r = client.get("/db/health")
    assert r.status_code == 503
    assert "MONGODB_URI" in r.json()["detail"]


@pytest.mark.skipif(not has_db, reason="MONGODB_URI/MONGODB_DB not set in brain/.env")
def test_atlas_ping():
    r = client.get("/db/health")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


@pytest.mark.skipif(not has_db, reason="MONGODB_URI/MONGODB_DB not set in brain/.env")
def test_atlas_write_and_read_back():
    r = client.post("/db/roundtrip")
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


def test_responses_never_contain_uri():
    for path in ("/health", "/db/health"):
        text = client.get(path).text
        assert "mongodb+srv://" not in text and "mongodb://" not in text
