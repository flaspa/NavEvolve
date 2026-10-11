"""Discover — "find X like this online".

    ego frame + request  →  Liquid: compact JSON describing the VISIBLE object
                         →  Nimble Search API v2 (live web)  →  ≤5 results

Liquid perceives; Nimble searches; the Brain only glues them. The Nimble key
stays server-side (NIMBLE_API_KEY).
"""

from __future__ import annotations

import json
import os
import re
from urllib.parse import urlparse

import requests
from PIL import Image

NIMBLE_SEARCH_URL = "https://sdk.nimbleway.com/v2/search"
MAX_RESULTS = 5

DISCOVER_PROMPT = (
    "You are Seekr's visual perception system looking through Seekr's eyes.\n"
    'The human asked: "{request}".\n'
    "Describe the requested object AS IT APPEARS in this image so it can be shopped for online.\n"
    "Answer with ONE JSON object and nothing else, exactly in this form:\n"
    '{{"object": "<object type, one or two words>", '
    '"visible": true or false, '
    '"description": "<one sentence: material, color, shape, finish, style, distinctive look>", '
    '"search_query": "<6-12 word shopping search query built from those visible attributes>"}}\n'
    "Rules: visible is true only if the requested object is actually in the image. "
    "Use only observable attributes; never invent a brand, model or manufacturer. "
    "If not visible, describe what is visible instead and set search_query to an empty string."
)

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


class NimbleConfigError(RuntimeError):
    pass


class NimbleApiError(RuntimeError):
    pass


def parse_discovery(text: str, fallback_object: str) -> dict:
    fallback = {"object": fallback_object, "visible": False, "description": text.strip()[:300], "search_query": ""}
    match = _JSON_RE.search(text or "")
    if not match:
        return fallback
    try:
        raw = json.loads(match.group(0))
    except json.JSONDecodeError:
        return fallback
    if not isinstance(raw, dict):
        return fallback
    return {
        "object": str(raw.get("object") or fallback_object).strip()[:60],
        "visible": bool(raw.get("visible", False)),
        "description": str(raw.get("description") or "").strip()[:300],
        "search_query": str(raw.get("search_query") or "").strip()[:160],
    }


def nimble_search(query: str, max_results: int = MAX_RESULTS) -> list[dict]:
    key = os.environ.get("NIMBLE_API_KEY", "").strip()
    if not key:
        raise NimbleConfigError("NIMBLE_API_KEY is not configured. Add it to seekr-worlds/.env (or brain/.env).")

    response = requests.post(
        NIMBLE_SEARCH_URL,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "query": query,
            "search_depth": "lite",
            "full_content": False,
            "country": "US",
            "locale": "en",
            "max_results": max_results,
            # No `focus: "shopping"`: measured at ~87 s per query versus 1.3 s
            # for the plain request, which already returns Etsy/Wayfair pages.
        },
        timeout=60,
    )
    if not response.ok:
        raise NimbleApiError(f"HTTP {response.status_code}: {response.text[:200]}")

    body = response.json()
    items = body.get("results") if isinstance(body, dict) else body
    results = []
    for item in items or []:
        url = item.get("url")
        if not url:
            continue
        results.append(
            {
                "title": (item.get("title") or url)[:160],
                "url": url,
                "description": (item.get("description") or item.get("content") or "")[:300],
                "source": urlparse(url).netloc.replace("www.", ""),
            }
        )
        if len(results) >= max_results:
            break
    return results


def discover(liquid, image: Image.Image, request: str) -> dict:
    """One discovery: Liquid describes the visible object → Nimble live search."""
    prompt = DISCOVER_PROMPT.format(request=request.strip().replace('"', "'"))
    raw = liquid.generate(image, prompt, max_new_tokens=140)
    found = parse_discovery(raw["text"], fallback_object=request.strip()[:40])

    out = {"model": liquid.model_id, "perception": found, "liquid_latency_ms": raw["latency_ms"], "results": []}
    if not found["visible"] or not found["search_query"]:
        return out

    query = f"{found['search_query']} buy"
    out["query"] = query
    out["results"] = nimble_search(query)
    return out
