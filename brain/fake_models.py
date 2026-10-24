"""Deterministic no-network stand-ins for models.py."""
import hashlib, re

import numpy as np

_NOUNS = ["sofa", "table", "chair", "bed", "lamp", "door", "window", "plant", "tv", "shelf"]
_state = {}


def _h(s: bytes | str) -> int:
    return int(hashlib.md5(s if isinstance(s, bytes) else s.encode()).hexdigest(), 16)


def embed_text(text: str) -> np.ndarray:
    v = np.zeros(256, np.float32)
    for w in re.findall(r"[a-z0-9]+", text.lower()):
        v[_h(w) % 256] += 1
    if not v.any():
        v[0] = 1
    return v / np.linalg.norm(v)


def embed_image(jpeg: bytes) -> np.ndarray:
    return embed_text(describe(jpeg))


def _objs(jpeg):
    h = _h(jpeg)
    return [_NOUNS[(h >> (4 * i)) % len(_NOUNS)] for i in range(3)]


def describe(jpeg: bytes) -> str:
    return "A room view containing " + ", ".join(_objs(jpeg)) + "."


def list_objects(jpeg: bytes) -> list[dict]:
    return [{"name": n, "description": f"a {n} in the room", "bbox": [0.1 + 0.2 * i, 0.2, 0.3 + 0.2 * i, 0.8]}
            for i, n in enumerate(dict.fromkeys(_objs(jpeg)))]


def verify(jpeg: bytes, target: str) -> dict:
    words = set(re.findall(r"[a-z0-9]+", target.lower()))
    hit = words & set(_objs(jpeg))
    return {"visible": bool(hit), "bbox": [0.1, 0.2, 0.5, 0.8] if hit else None,
            "reason": f"fake: sees {sorted(hit)}" if hit else "fake: not seen"}


def choose(jpegs: list[bytes], goal: str, context: str, options: list[str]) -> dict:
    return {"choice": 0, "thought": f"I'll try the first option while looking for {goal}."}
