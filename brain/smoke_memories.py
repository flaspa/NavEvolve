"""Smoke test for the Memories.ai Video Datalake path through the Brain
(in-process, no server): POST /memories with a short clip, poll the ingest
operation, list the collection.

WSL has no video encoder, so this uses a tiny public MP4 (~1 s of billable
indexing) in place of the Body's WebM clip.

    conda activate vlmserver
    cd /mnt/c/Flavia/Code/seekr-worlds/brain
    python smoke_memories.py
"""

import json
import time

import requests
from fastapi.testclient import TestClient

import app as brain_app

CLIP_URL = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"


def main() -> int:
    client = TestClient(brain_app.app)
    print("health.memories:", client.get("/health").json()["memories"])

    clip = requests.get(CLIP_URL, timeout=60).content
    print("clip bytes:", len(clip))

    now_ms = int(time.time() * 1000)
    context = {
        "scene_id": "interior_0516_840045",
        "scene_name": "InteriorGS 0516 / 840045",
        "timestamp": now_ms,
        "pose": {"x": 3.28, "z": 0.99, "headingDeg": 314},
        "description": "smoke test memory",
        "goal": None,
        "client_id": f"smoke-{now_ms}",
    }
    res = client.post(
        "/memories",
        files={"video": ("seekr-memory.mp4", clip, "video/mp4")},
        data={"json": json.dumps(context)},
    )
    print("POST /memories:", res.status_code, res.json())
    if not res.is_success:
        return 1

    operation = res.json()["operation"]
    for i in range(8):
        time.sleep(5)
        op = client.get(f"/memories/operations/{operation}").json()
        print(f"  poll {i}: done={op['done']} progress={op.get('progress')} error={op.get('error')}")
        if op["done"]:
            break

    listing = client.get("/memories?limit=3")
    print("GET /memories:", listing.status_code, str(listing.json())[:400])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
