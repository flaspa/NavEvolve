import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import agent_ws
from body import Body


@pytest.fixture
def client():
    agent_ws._reset()
    app = FastAPI()
    app.include_router(agent_ws.router)
    with TestClient(app) as c:
        yield c


def test_roundtrip_and_capture_decode(client):
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({"event": "hello", "sceneId": "s1"})
        fut = client.portal.start_task_soon(Body().capture)
        msg = ws.receive_json()
        assert msg["cmd"] == "capture" and msg["headings"] == 1
        url = "data:image/jpeg;base64,/9j4YWJj"
        ws.send_json({"id": msg["id"], "ok": True, "result": {"frames": [{"frameId": "f", "jpegDataUrl": url}]}})
        frames = fut.result(5)
        assert frames[0]["jpeg"] == b"\xff\xd8\xf8abc"[:0] + b"\xff\xd8\xf8abc"
        assert "jpegDataUrl" not in frames[0]


def test_error_and_timeout(client, monkeypatch):
    monkeypatch.setattr(agent_ws, "TIMEOUT", 0.2)
    with client.websocket_connect("/agent/ws") as ws:
        fut = client.portal.start_task_soon(Body().pose)
        msg = ws.receive_json()
        ws.send_json({"id": msg["id"], "ok": False, "error": "boom"})
        with pytest.raises(agent_ws.BodyError, match="boom"):
            fut.result(5)
        fut = client.portal.start_task_soon(Body().turn, 90)
        ws.receive_json()  # never answered
        with pytest.raises(agent_ws.BodyError, match="timed out"):
            fut.result(5)


def test_events(client):
    with client.websocket_connect("/agent/ws") as ws:
        ws.send_json({"event": "hello", "sceneId": "s1"})
        ws.send_json({"event": "goal", "text": "find mug"})
        ws.send_json({"event": "stop"})
        assert client.portal.call(agent_ws.next_event) == {"event": "goal", "text": "find mug"}
        assert client.portal.call(agent_ws.next_event) == {"event": "stop"}
        assert agent_ws.scene_id == "s1"
