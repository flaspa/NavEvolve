"""The agent's handle on the world, over the browser websocket (CONTRACTS.md §3)."""

from __future__ import annotations

import base64

import agent_ws


class Body:
    async def capture(self, headings: int = 1) -> list[dict]:
        frames = (await agent_ws.request("capture", headings=headings))["frames"]
        for f in frames:
            url = f.pop("jpegDataUrl", None)
            if url:
                f["jpeg"] = base64.b64decode(url.split(",", 1)[-1])
        return frames

    async def goto(self, x: float, z: float, stop_within: float = 0.3) -> dict:
        return await agent_ws.request("goto", x=x, z=z, stopWithin=stop_within)

    async def halt(self) -> None:
        """Stop a walk in progress (its goto returns "blocked")."""
        await agent_ws.request("halt")

    async def turn(self, deg: float) -> dict:
        return await agent_ws.request("turn", deg=deg)

    async def face(self, x: float, z: float) -> dict:
        return await agent_ws.request("face", x=x, z=z)

    async def pose(self) -> dict:
        return await agent_ws.request("pose")

    async def frontiers(self) -> dict:
        return await agent_ws.request("frontiers")

    async def reset(self, x: float, z: float, heading_deg: float) -> dict:
        return await agent_ws.request("reset", x=x, z=z, headingDeg=heading_deg)

    async def thought(self, phase: str, text: str, frame_id: str | None = None) -> None:
        a = {"frameId": frame_id} if frame_id else {}
        await agent_ws.request("thought", phase=phase, text=text, **a)

    async def memory(self, objects: list[dict]) -> None:
        await agent_ws.request("memory", objects=objects)
