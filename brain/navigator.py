"""Goal-directed navigation for the Seekr Brain — deterministic rule over
Liquid's perception. No action model.

    Liquid  = visual perception of the goal target (visible? where? how far?)
    Brain   = this small rule: turn toward / move closer / search / stop
    Body    = executes ONE small action on the NavMesh and reports back

The Body reports its execution facts (iteration, whether the last move was
blocked by the NavMesh, streak counters); the rule below is stateless.
"""

from __future__ import annotations

import json
import re

from PIL import Image

# Movement increments the Body executes (Body semantics: turnBy radians > 0 is
# LEFT; forward is along the embodied eye direction, NavMesh-constrained).
TURN_DEG = 20.0
SEARCH_TURN_DEG = 30.0
FORWARD_M = 0.4

MAX_ITERATIONS = 24
MAX_BLOCKED_STREAK = 3
# A full search rotation at SEARCH_TURN_DEG, plus a little slack.
MAX_NOT_VISIBLE_STREAK = int(360 / SEARCH_TURN_DEG) + 2

GOAL_PROMPT = (
    "You are Seekr's visual perception system looking through Seekr's eyes.\n"
    'The human request is: "{goal}".\n'
    "Report ONLY visual evidence about the target of this request in this image.\n"
    "Answer with ONE JSON object and nothing else, exactly in this form:\n"
    '{{"target_visible": true or false, '
    '"horizontal": "left" or "center" or "right" or "unknown", '
    '"distance": "near" or "medium" or "far" or "unknown", '
    '"reached": true or false, '
    '"description": "one short sentence: what is visible and where the target is"}}\n'
    "Rules: target_visible is true only if the requested object is actually visible. "
    "horizontal is where the target is in the image. distance is near if Seekr is "
    "within about one metre of it, medium up to about three metres, far beyond. "
    "reached is true only if Seekr is already standing right next to the target. "
    "Do not invent objects."
)

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)
_H = {"left", "center", "right", "unknown"}
_D = {"near", "medium", "far", "unknown"}


def parse_perception(text: str) -> dict:
    """Smallest robust extraction: first {...} block → JSON, else 'unknown'."""
    fallback = {
        "target_visible": False,
        "horizontal": "unknown",
        "distance": "unknown",
        "reached": False,
        "description": text.strip()[:400],
        "parsed": False,
    }
    match = _JSON_RE.search(text or "")
    if not match:
        return fallback
    try:
        raw = json.loads(match.group(0))
    except json.JSONDecodeError:
        return fallback
    if not isinstance(raw, dict):
        return fallback

    horizontal = str(raw.get("horizontal", "unknown")).lower().strip()
    distance = str(raw.get("distance", "unknown")).lower().strip()
    return {
        "target_visible": bool(raw.get("target_visible", False)),
        "horizontal": horizontal if horizontal in _H else "unknown",
        "distance": distance if distance in _D else "unknown",
        "reached": bool(raw.get("reached", False)),
        "description": str(raw.get("description", "")).strip()[:400] or text.strip()[:400],
        "parsed": True,
    }


def decide(perception: dict, body: dict) -> dict:
    """The deterministic Brain rule. Returns one Body action.

    body: { iteration, blocked (last move hit the NavMesh), blocked_streak,
            not_visible_streak }
    """
    iteration = int(body.get("iteration", 0))
    blocked = bool(body.get("blocked", False))
    blocked_streak = int(body.get("blocked_streak", 0))
    not_visible_streak = int(body.get("not_visible_streak", 0))

    visible = perception["target_visible"]
    horizontal = perception["horizontal"]
    distance = perception["distance"]

    if visible and (perception["reached"] or distance == "near"):
        return _stop("reached", "Goal reached — standing next to the target.")

    if iteration >= MAX_ITERATIONS:
        return _stop("max_iterations", f"Stopped after {MAX_ITERATIONS} steps.")

    if blocked_streak >= MAX_BLOCKED_STREAK:
        return _stop("blocked", "Stopped — the NavMesh blocked every recent move.")

    if not visible:
        if not_visible_streak >= MAX_NOT_VISIBLE_STREAK:
            return _stop("not_found", "Stopped — the target was not found after a full search turn.")
        return _turn("left", SEARCH_TURN_DEG, "Searching: target not visible.")

    if horizontal == "left":
        return _turn("left", TURN_DEG, "Target is to the left.")
    if horizontal == "right":
        return _turn("right", TURN_DEG, "Target is to the right.")

    # Centred (or unknown horizontal), medium/far/unknown distance: approach.
    if blocked:
        # The straight line is not navigable: try another heading, then re-look.
        return _turn("left", SEARCH_TURN_DEG, "Forward was blocked — trying another heading.")
    return {"type": "move_forward", "meters": FORWARD_M, "reason": "Target ahead — moving closer."}


def _turn(direction: str, degrees: float, reason: str) -> dict:
    return {"type": f"turn_{direction}", "degrees": degrees, "reason": reason}


def _stop(outcome: str, reason: str) -> dict:
    return {"type": "stop", "outcome": outcome, "reason": reason}


def goal_step(liquid, image: Image.Image, goal: str, body: dict) -> dict:
    """One closed-loop step: Liquid perception → deterministic action."""
    prompt = GOAL_PROMPT.format(goal=goal.strip().replace('"', "'"))
    raw = liquid.generate(image, prompt, max_new_tokens=120)
    perception = parse_perception(raw["text"])
    action = decide(perception, body)
    return {
        "model": liquid.model_id,
        "perception": perception,
        "action": action,
        "raw": raw["text"][:600],
        "latency_ms": raw["latency_ms"],
    }
