"""Smoke test: BFL FLUX.2 [pro] postcard from two synthetic reference frames
(no model, no server). Costs a few BFL credits."""
import base64, io, time
from pathlib import Path
from urllib.parse import urlparse
from dotenv import load_dotenv
from PIL import Image, ImageDraw
load_dotenv(Path(__file__).with_name(".env")); load_dotenv(Path(__file__).parent.parent / ".env")
import postcard

def frame(color, box):
    img = Image.new("RGB", (768, 432), (200, 190, 170)); d = ImageDraw.Draw(img)
    d.rectangle([0, 260, 768, 432], fill=(120, 90, 60)); d.rectangle(box, fill=color)
    b = io.BytesIO(); img.save(b, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()

t0 = time.perf_counter()
r = postcard.create_postcard([frame((40, 40, 60), [300, 40, 470, 300]), frame((60, 120, 60), [560, 150, 700, 290])],
                             ["a dark doorway ahead with a wooden bench on the left"], "InteriorGS 0516 / 840045")
print("postcard OK: refs", r["references"], "latency_ms", r["latency_ms"], "host", urlparse(r["image_url"]).netloc, "task", r["task_id"][:8] + "…")
