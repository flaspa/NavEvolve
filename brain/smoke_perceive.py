"""One-shot smoke test: load LiquidAI/LFM2.5-VL-3B, perceive one synthetic
egocentric frame twice (with and without a task), and exercise /health and
/perceive in-process. Starts no server.

    conda activate vlmserver
    cd /mnt/c/Flavia/Code/seekr-worlds/brain
    python smoke_perceive.py
"""

import base64
import io

from PIL import Image, ImageDraw

import liquid


def synthetic_frame() -> Image.Image:
    img = Image.new("RGB", (768, 432), (200, 190, 170))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 260, 768, 432], fill=(120, 90, 60))  # floor
    d.rectangle([300, 40, 470, 300], fill=(30, 30, 40))  # dark doorway ahead
    d.rectangle([60, 200, 260, 280], fill=(150, 110, 70))  # table left
    d.rectangle([80, 280, 100, 340], fill=(150, 110, 70))
    d.rectangle([220, 280, 240, 340], fill=(150, 110, 70))
    d.ellipse([560, 150, 700, 290], fill=(60, 120, 60))  # plant right
    return img


def main() -> int:
    perception = liquid.LiquidPerception()
    perception.load()
    print("status:", perception.status, "device:", perception.device,
          "load_s:", perception.load_seconds, "error:", perception.error)
    if perception.status != "ready":
        return 1

    img = synthetic_frame()
    for i, task in enumerate([None, "Find the doorway"]):
        result = perception.perceive(img, task)
        text = result["description"][:400].replace("\n", " ")
        print(f"run {i} latency_ms={result['latency_ms']} -> {text}")

    from fastapi.testclient import TestClient

    import app as brain_app

    brain_app.perception = perception
    client = TestClient(brain_app.app)
    print("health:", client.get("/health").json())

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    res = client.post("/perceive", json={"image_data_url": data_url, "scene_id": "smoke"})
    body = res.json()
    if "description" in body:
        body["description"] = body["description"][:120]
    print("perceive:", res.status_code, body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
