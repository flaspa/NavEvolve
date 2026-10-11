"""Memory postcard — Black Forest Labs FLUX.2 [pro] over Seekr's local memories.

    1–3 remembered ego frames (+ Liquid descriptions)  →  POST /v1/flux-2-pro
    →  poll the returned polling_url until Ready  →  one generated image URL

BFL renders; the Brain only builds the prompt and polls. BFL_API_KEY stays
server-side. Docs: https://docs.bfl.ai/flux_2/flux2_image_editing
"""

from __future__ import annotations

import os
import time

import requests

BFL_ENDPOINT = "https://api.bfl.ai/v1/flux-2-pro"
POLL_INTERVAL_S = 1.5
POLL_MAX_S = 180

BASE_PROMPT = (
    "Create a polished, cinematic memory-postcard image inspired by these reference views "
    "from Seekr's journey through an interior. Preserve the recognizable architecture, "
    "materials, furniture, lighting and mood of the references so the place stays "
    "recognizable. Re-imagine it as one warm, cohesive travel-memory image with gentle "
    "postcard framing. No user interface, no added people, no text or lettering in the image."
)


class BflConfigError(RuntimeError):
    pass


class BflApiError(RuntimeError):
    pass


def _api_key() -> str:
    key = os.environ.get("BFL_API_KEY", "").strip()
    if not key:
        raise BflConfigError("BFL_API_KEY is not configured. Add it to seekr-worlds/.env (or brain/.env).")
    return key


def _strip_data_url(image: str) -> str:
    """BFL expects the base64 payload; accept a data URL or bare base64."""
    return image.split(",", 1)[1] if image.startswith("data:") else image


def build_prompt(descriptions: list[str], scene_name: str | None) -> str:
    prompt = BASE_PROMPT
    grounded = [d.strip() for d in descriptions if d and d.strip()]
    if grounded:
        # Only visually grounded details, and only a little of them.
        prompt += " Visible in the references: " + " ".join(grounded[:3])[:500]
    if scene_name:
        prompt += f" The place is {scene_name}."
    return prompt


def create_postcard(images: list[str], descriptions: list[str], scene_name: str | None) -> dict:
    """Submit to FLUX.2 [pro] with up to three reference images, poll, return the image URL."""
    key = _api_key()
    refs = [_strip_data_url(img) for img in images[:3] if img]
    if not refs:
        raise BflApiError("no reference images")

    body = {"prompt": build_prompt(descriptions, scene_name), "output_format": "jpeg", "safety_tolerance": 2}
    for i, ref in enumerate(refs):
        body["input_image" if i == 0 else f"input_image_{i + 1}"] = ref

    headers = {"x-key": key, "accept": "application/json", "Content-Type": "application/json"}
    started = time.perf_counter()
    submit = requests.post(BFL_ENDPOINT, headers=headers, json=body, timeout=120)
    if not submit.ok:
        raise BflApiError(f"submit HTTP {submit.status_code}: {submit.text[:200]}")
    task = submit.json()
    task_id = task.get("id")
    polling_url = task.get("polling_url") or f"https://api.bfl.ai/v1/get_result?id={task_id}"

    while time.perf_counter() - started < POLL_MAX_S:
        time.sleep(POLL_INTERVAL_S)
        poll = requests.get(polling_url, headers={"x-key": key, "accept": "application/json"}, timeout=60)
        if not poll.ok:
            raise BflApiError(f"poll HTTP {poll.status_code}: {poll.text[:200]}")
        data = poll.json()
        status = data.get("status")
        if status == "Ready":
            sample = (data.get("result") or {}).get("sample")
            if not sample:
                raise BflApiError("Ready but no result.sample")
            return {
                "image_url": sample,
                "task_id": task_id,
                "prompt": body["prompt"],
                "references": len(refs),
                "latency_ms": round((time.perf_counter() - started) * 1000),
            }
        if status in ("Error", "Request Moderated", "Content Moderated", "Task not found", "Failed"):
            raise BflApiError(f"{status}: {str(data.get('details') or data.get('result') or '')[:200]}")
        # Pending / Queued: keep polling.

    raise BflApiError(f"timed out after {POLL_MAX_S}s")
