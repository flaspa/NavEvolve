"""Run uvicorn, open the browser, then: python body_demo.py (standalone server on :8000 is NOT needed;
this starts its own and waits for the browser)."""

import asyncio

import uvicorn

import agent_ws
from server import app


async def demo() -> None:
    srv = uvicorn.Server(uvicorn.Config(app, port=8000, log_level="warning"))
    task = asyncio.create_task(srv.serve())
    print("waiting for browser on ws://localhost:8000/agent/ws ...")
    body = await agent_ws.get_body()
    p = (await body.pose())["pose"]
    print("pose", p)
    frames = await body.capture(1)
    print("capture", [{k: (len(v) if k == "jpeg" else v) for k, v in f.items() if k != "jpegDataUrl"} for f in frames])
    print("turn", await body.turn(90))
    print("goto", await body.goto(p["x"] + 1.0, p["z"]))
    await body.thought("demo", "hello")
    srv.should_exit = True
    await task


asyncio.run(demo())
