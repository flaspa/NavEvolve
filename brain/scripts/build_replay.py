"""Build the Replay Demo assets ONCE (hackathon presentation).

Reads real saved data (a remembered bathroom viewpoint, its JPEG, the recorded
Gemini perception) and generates cached ElevenLabs narration, so playback needs
no Gemini, MongoDB or ElevenLabs calls. Writes body/public/replay/:
    bathroom.json   script: scene, start/target poses, narration lines, evidence
    evidence.jpg    the saved observation image
    *.mp3           one clip per narration line (single voice)

    cd brain && .venv/Scripts/python scripts/build_replay.py
Never prints secrets.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import perception  # noqa: E402  (loads brain/.env)
import db  # noqa: E402
import talk  # noqa: E402

OUT = HERE.parent / "body" / "public" / "replay"
OUT.mkdir(parents=True, exist_ok=True)
SCENE = "interior_0759_839979"
TARGET_OBS = "6acc125a90f37b9f3001f0a2"   # enriched 'bathroom' viewpoint, (2.08, 1.65), heading 89°
VOICE_ID = "XrExE9yKIg1WjnnlVkGX"         # ElevenLabs "Matilda" — one voice for the whole demo
MODEL = "eleven_turbo_v2_5"

obs = db.get_db()[db.OBSERVATIONS].find_one({"_id": db.ObjectId(TARGET_OBS)})
assert obs and obs.get("perception", {}).get("status") == "done", "target observation missing or not enriched"
(OUT / "evidence.jpg").write_bytes(bytes(obs["image_jpeg"]))
pose = obs["pose"]
when = datetime.fromtimestamp(obs["timestamp"] / 1000).strftime("%I:%M %p").lstrip("0")
summary = (obs["description"].get("summary") or obs["description_text"].split("\n")[0]).strip()
room = obs["description"].get("room_type")

# A real, far-away saved viewpoint as the start (the dining-table viewpoint).
start = db.get_db()[db.OBSERVATIONS].find_one(
    {"scene_id": SCENE, "perception.status": "done", "description_text": {"$regex": "dining", "$options": "i"},
     "pose.x": {"$lt": -3}}, {"pose": 1, "timestamp": 1}, sort=[("timestamp", 1)])
assert start, "no start viewpoint"
sp = start["pose"]

# One real Gemini verification of the saved frame, recorded now (retried: the model was busy earlier).
verify = None
for attempt in range(4):
    try:
        verify = talk.verify(TARGET_OBS, "bathroom")
        break
    except Exception as exc:  # noqa: BLE001
        print(f"verify attempt {attempt + 1} failed: {type(exc).__name__}", flush=True)
        time.sleep(8)
verified_at = datetime.now().strftime("%Y-%m-%d %H:%M")

lines = {
    "intro": f"Searching my memory for a bathroom. I remember one: I recorded it at {when} from a viewpoint near "
             f"{pose['x']:.1f}, {pose['z']:.1f}. This is a replay of a saved route, not a live run.",
    "walk": "Planning a path on the NavMesh and walking there now.",
    "mid": "I'm crossing the showroom. The remembered bathroom viewpoint is just ahead.",
    "arrive": "I've arrived at the remembered viewpoint and turned to face the recorded view.",
    "evidence": (f"Here is what I recorded there. {summary} "
                 + (f"Recorded Gemini verification: {'visible' if verify['visible'] else 'not visible'} — {verify['reason']}"
                    if verify else f"Recorded Gemini perception classed this view as a {room}.")),
    "done": "Replay complete. Manual control is restored.",
    "stop": "Replay stopped. Manual control is restored.",
}

key = os.environ["ELEVENLABS_API_KEY"].strip()
for name, text in lines.items():
    path = OUT / f"{name}.mp3"
    if path.exists() and path.stat().st_size > 1000 and name not in ("intro", "evidence"):
        continue
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128",
        data=json.dumps({"text": text, "model_id": MODEL}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=120) as r:
        path.write_bytes(r.read())
    print(f"{name}.mp3 {path.stat().st_size // 1024} KB", flush=True)

script = {
    "label": "Replay Demo — guided replay of saved viewpoints and a recorded route",
    "scene_id": SCENE,
    "voice": {"provider": "elevenlabs", "voice_id": VOICE_ID, "model": MODEL},
    "user_message": "Find the bathroom.",
    "start": {"observation_id": str(start["_id"]), "x": sp["x"], "z": sp["z"], "headingDeg": sp["headingDeg"]},
    "target": {"observation_id": TARGET_OBS, "x": pose["x"], "z": pose["z"], "headingDeg": pose["headingDeg"],
               "recorded_at": when, "timestamp": obs["timestamp"], "room_type": room, "summary": summary,
               "range_m": (obs.get("range") or {}).get("distanceM")},
    "verification": ({"goal": "bathroom", **verify, "verified_at": verified_at, "source": "talk.verify on the saved JPEG"}
                     if verify else None),
    "lines": lines,
    "built_at": verified_at,
}
(OUT / "bathroom.json").write_text(json.dumps(script, indent=2), encoding="utf-8")
print(json.dumps({k: script[k] for k in ("start", "target", "verification")}, indent=1, default=str))
