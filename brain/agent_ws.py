"""WebSocket link to the browser (CONTRACTS.md §1). One browser at a time; newest wins."""

from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

TIMEOUT = 30.0
GOTO_TIMEOUT = 75.0  # > browser's own 60 s goto limit

_ws: WebSocket | None = None
_connected = asyncio.Event()
_pending: dict[str, asyncio.Future] = {}
_events: asyncio.Queue = asyncio.Queue()
scene_id: str | None = None  # from the last hello


def _reset() -> None:
    """Fresh asyncio primitives (tests run each case on a new loop)."""
    global _ws, _connected, _events, scene_id
    _ws, _connected, _events, scene_id = None, asyncio.Event(), asyncio.Queue(), None
    _pending.clear()


class BodyError(RuntimeError):
    pass


async def request(cmd: str, timeout: float | None = None, **args) -> dict:
    await _connected.wait()
    ws = _ws
    rid = uuid.uuid4().hex
    t0 = asyncio.get_running_loop().time()
    fut = asyncio.get_running_loop().create_future()
    _pending[rid] = fut
    try:
        await ws.send_json({"id": rid, "cmd": cmd, **args})
        reply = await asyncio.wait_for(fut, timeout or (GOTO_TIMEOUT if cmd == "goto" else TIMEOUT))
    except asyncio.TimeoutError:
        print(f"[time] body.{cmd} TIMED OUT", flush=True)
        raise BodyError(f"{cmd}: timed out") from None
    finally:
        _pending.pop(rid, None)
    print(f"[time] body.{cmd} {asyncio.get_running_loop().time() - t0:.1f}s ok={reply.get('ok')}"
          f" {reply.get('error') or {k: v for k, v in (reply.get('result') or {}).items() if k in ('status', 'pose', 'coverage')}}", flush=True)
    if not reply.get("ok"):
        raise BodyError(f"{cmd}: {reply.get('error')}")
    return reply.get("result") or {}


async def next_event() -> dict:
    """Next {"event": "goal"|"stop", ...} from the browser."""
    return await _events.get()


async def get_body():
    from body import Body

    await _connected.wait()
    return Body()


@router.websocket("/agent/ws")
async def agent_ws(ws: WebSocket) -> None:
    global _ws, scene_id
    await ws.accept()
    old, _ws = _ws, ws
    print(f"[ws {id(ws) % 1000}] connected, replacing {old and id(old) % 1000}", flush=True)
    if old:
        await old.close(code=4000)  # REPLACED: that tab stays quiet until it's looked at again
    _connected.set()
    try:
        while True:
            msg = await ws.receive_json()
            if "event" in msg:
                print(f"[ws {id(ws) % 1000}] event {msg}", flush=True)
            if "id" in msg:
                fut = _pending.get(msg["id"])
                if fut and not fut.done():
                    fut.set_result(msg)
            elif msg.get("event") == "hello":
                scene_id = msg.get("sceneId")
            elif msg.get("event") in ("goal", "stop"):
                if _ws is not ws:  # goal typed in a tab that isn't the body: it becomes the body
                    old, _ws = _ws, ws
                    if old:
                        await old.close(code=4000)
                    _connected.set()
                _events.put_nowait(msg)
    except WebSocketDisconnect:
        pass
    finally:
        if _ws is ws:
            _ws = None
            _connected.clear()
