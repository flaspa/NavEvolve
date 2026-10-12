"""Real model clients (Gemini via Woven proxy). Stateless, thread-safe. Never prints secrets."""
import base64, json, os, time, urllib.error, urllib.request
from pathlib import Path

import numpy as np

for f in (Path(__file__).with_name(".env"), Path("/Users/jun.jiang/Projects/spacial-agents/.env")):
    if f.exists():
        for line in f.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))

BASE = "https://wovey-api.woven.tech/gemini/project/arene_1_core_product_development/v1/models"
EMBED, VLM = "gemini-embedding-2", "gemini-3.8-flash"

DESCRIBE = """Describe this indoor view in detail so that someone could recognise exactly where in the house it was taken from.
Cover: the room type; every clearly visible object and its position in the frame (left / centre / right, near / far);
furniture, doors, windows, arches, stairs, lights, ceiling and floor materials, wall colours; what is visible through
openings; and the approximate viewing direction. Plain prose, no preamble, 120-200 words."""
LIST = """List 6-10 distinct physical objects clearly visible in this image (furniture, fixtures, decor, doors, windows...).
For each give a 1-2 sentence description of the object itself only (appearance, colour, material, shape) - do not
describe the room or where the object is, and its bounding box [x0,y0,x1,y1] as fractions 0..1 of image width/height
(origin top-left). JSON: [{"name": "...", "description": "...", "bbox": [x0,y0,x1,y1]}]"""
CHECK = """Is this specific object visible in the image? Object: {t}
Answer JSON: {{"visible": true|false, "bbox": [x0,y0,x1,y1] or null, "reason": "short reason"}}
bbox is the object's box as fractions 0..1 of image width/height (origin top-left), null if not visible."""
CHOOSE = """You are a robot navigating a house to find: {goal}
Context: {ctx}
The images are your most recent forward views, oldest first; the last is where you stand now. Options are places you can walk to:
{opts}
Pick the option most likely to lead to the goal. JSON: {{"choice": <option index>, "thought": "one or two short first-person sentences explaining your reasoning"}}"""


def _post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {os.environ['AWS_BEARER_TOKEN_BEDROCK']}"})
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 7:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 0) or 5 * 2 ** attempt)


def _img(jpeg):
    return {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpeg).decode()}}


def _unit(v):
    v = np.array(v, dtype=np.float32)
    return v / np.linalg.norm(v)


def _vlm(parts, as_json):
    body = {"contents": [{"role": "user", "parts": parts}]}
    if as_json:
        body["generationConfig"] = {"responseMimeType": "application/json"}
    r = _post(f"{BASE}/{VLM}:generateContent", body)
    t = "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"] if not p.get("thought"))
    return json.loads(t) if as_json else t.strip()


def embed_image(jpeg: bytes) -> np.ndarray:
    return _unit(_post(f"{BASE}/{EMBED}:embedContent", {"content": {"parts": [_img(jpeg)]}})["embedding"]["values"])


def embed_text(text: str) -> np.ndarray:
    return _unit(_post(f"{BASE}/{EMBED}:embedContent", {"content": {"parts": [{"text": text}]}})["embedding"]["values"])


def describe(jpeg: bytes) -> str:
    return _vlm([_img(jpeg), {"text": DESCRIBE}], False)


def list_objects(jpeg: bytes) -> list[dict]:
    return _vlm([_img(jpeg), {"text": LIST}], True)


def verify(jpeg: bytes, target: str) -> dict:
    r = _vlm([_img(jpeg), {"text": CHECK.format(t=target)}], True)
    return {"visible": bool(r.get("visible")), "bbox": r.get("bbox") if r.get("visible") else None,
            "reason": r.get("reason", "")}


def choose(jpegs: list[bytes], goal: str, context: str, options: list[str]) -> dict:
    opts = "\n".join(f"{i}: {o}" for i, o in enumerate(options))
    r = _vlm([_img(j) for j in jpegs] + [{"text": CHOOSE.format(goal=goal, ctx=context, opts=opts)}], True)
    c = int(r.get("choice", 0))
    return {"choice": c if 0 <= c < len(options) else 0, "thought": r.get("thought", "")}


if __name__ == "__main__":
    import sys
    j = Path(sys.argv[1]).read_bytes()
    e = embed_image(j); print("embed_image", e.shape, e.dtype, float(np.linalg.norm(e)))
    t = embed_text("a sofa in a living room"); print("embed_text", t.shape, "sim", float(e @ t))
    print("describe:", describe(j)[:300])
    objs = list_objects(j); print("list_objects:", json.dumps(objs[:3]))
    print("verify:", verify(j, f"{objs[0]['name']}: {objs[0]['description']}"))
    print("choose:", choose([j, j], "a sofa", "start", ["left", "right"]))
