"""Recorded Replay assets (presentation): persist one navigation episode the browser
recorded and cache everything a replay needs, so playback works offline.

Writes body/public/replay/episodes/<episode_id>.json, <episode_id>/<obs_id>.jpg for
every captured observation (copied once from MongoDB), <episode_id>/<n>.mp3 for every
agent line (ElevenLabs, one voice, generated once) and episodes/index.json (latest).
The ElevenLabs key is read only here, from brain/.env, and never returned.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path

import db

ROOT = Path(__file__).resolve().parent.parent / "body" / "public" / "replay" / "episodes"
VOICE_ID = "XrExE9yKIg1WjnnlVkGX"   # ElevenLabs "Matilda" — same voice as the Replay Demo
MODEL = "eleven_turbo_v2_5"


def _tts(text: str, path: Path) -> bool:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key or (path.exists() and path.stat().st_size > 1000):
        return path.exists()
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128",
        data=json.dumps({"text": text, "model_id": MODEL}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
        return True
    except Exception as exc:  # noqa: BLE001  (replay still works as text)
        print(f"[replay] tts failed: {type(exc).__name__}", flush=True)
        return False


def save_episode(episode: dict) -> dict:
    ep_id = re.sub(r"[^A-Za-z0-9_-]", "", str(episode.get("episode_id", "")))[:40]
    if not ep_id:
        raise ValueError("episode_id required")
    ROOT.mkdir(parents=True, exist_ok=True)
    folder = ROOT / ep_id
    folder.mkdir(exist_ok=True)
    assets = {"images": {}, "audio": {}}
    # Evidence images: copy each captured observation's JPEG once.
    for obs_id in {e.get("obs_id") for e in episode.get("events", []) if e.get("obs_id")}:
        try:
            jpeg = db.get_observation(obs_id, with_image=True)
        except Exception:  # noqa: BLE001  (Atlas down: image simply missing)
            jpeg = None
        if jpeg:
            (folder / f"{obs_id}.jpg").write_bytes(jpeg)
            assets["images"][obs_id] = f"/replay/episodes/{ep_id}/{obs_id}.jpg"
    # Narration: one clip per agent line that the recording marked as spoken.
    for i, e in enumerate(episode.get("events", [])):
        if e.get("speak") and e.get("text"):
            path = folder / f"{i}.mp3"
            if _tts(e["text"], path):
                assets["audio"][str(i)] = f"/replay/episodes/{ep_id}/{i}.mp3"
    episode = {**episode, "assets": assets, "label": "Recorded Replay"}
    (ROOT / f"{ep_id}.json").write_text(json.dumps(episode, indent=1), encoding="utf-8")
    (ROOT / "index.json").write_text(json.dumps({"latest": ep_id, "goal": episode.get("goal"),
                                                 "status": episode.get("status")}), encoding="utf-8")
    return {"episode_id": ep_id, "json": f"/replay/episodes/{ep_id}.json", **{k: len(v) for k, v in assets.items()}}
