"""NavEvolve Memory (hackathon, Milestone 4): the cognitive map of places.

Observations are replayed chronologically. Each one is scored against every
existing place memory with an explicit, configurable POLICY:

    score = (w_visual·cos(image) + w_semantic·cos(text) + w_range·range_sim)
            / (w_visual + w_semantic + w_range)

If the best score reaches `threshold` the observation joins that place,
otherwise it founds a new place. Consecutive observations in different places
add a traversal edge.

POLICY INPUTS are only perception: Gemini image/text embeddings and the
egocentric Gaussian-splat range. Simulator pose is NEVER read by the policy.
Pose is used only (a) to place nodes on screen and (b) by the evaluator to
derive approximate reference labels (see reference_pairs).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from itertools import combinations

import db

GRAPHS = "cognitive_graphs"

# ── Reference labels (evaluation only) ─────────────────────────────────────
SAME_PLACE_MAX_M = 1.5       # within 1.5 m …
SAME_PLACE_MAX_TURN = 45.0   # … and looking the same way (±45°) → revisit
DIFFERENT_PLACE_MIN_M = 3.0  # ≥ 3 m apart → different place; between: ignored


@dataclass
class Policy:
    version: int = 1
    w_visual: float = 0.5
    w_semantic: float = 0.5
    w_range: float = 0.0
    threshold: float = 0.85

    def as_dict(self) -> dict:
        return asdict(self)


# ── Similarities (perception only) ─────────────────────────────────────────
def _norm(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))  # inputs are unit vectors


def _mean_unit(vectors: list[list[float]]) -> list[float]:
    return _norm([sum(col) / len(vectors) for col in zip(*vectors)])


def range_similarity(a: float | None, b: float | None) -> float:
    """1 when equal, → 0 as the ratio grows; neutral 0.5 when either is unknown."""
    if not a or not b:
        return 0.5
    return math.exp(-abs(math.log(a / b)))


def load_observations(scene_id: str | None = None) -> list[dict]:
    """Enriched observations, oldest first, as plain dicts with unit vectors."""
    query = {"perception.status": "done"}
    if scene_id:
        query["scene_id"] = scene_id
    fields = {"image_embedding": 1, "text_embedding": 1, "range": 1, "pose": 1,
              "timestamp": 1, "scene_id": 1, "description": 1}
    out = []
    for d in db.get_db()[db.OBSERVATIONS].find(query, fields).sort("timestamp", 1):
        out.append({
            "id": str(d["_id"]),
            "scene_id": d["scene_id"],
            "timestamp": d["timestamp"],
            "image": _norm(d["image_embedding"]),
            "text": _norm(d["text_embedding"]),
            "range_m": (d.get("range") or {}).get("distanceM"),
            "summary": (d.get("description") or {}).get("summary", ""),
            "pose": d.get("pose") or {},          # evaluation + display only
        })
    return out


# ── Graph construction ─────────────────────────────────────────────────────
def build_graph(observations: list[dict], policy: Policy) -> dict:
    places: list[dict] = []
    assignment: dict[str, int] = {}
    edges: dict[tuple[int, int], int] = {}
    decisions = []
    weight_sum = (policy.w_visual + policy.w_semantic + policy.w_range) or 1.0
    previous = None

    for obs in observations:
        best, best_score = None, -1.0
        for idx, place in enumerate(places):
            score = (policy.w_visual * _cos(obs["image"], place["image"])
                     + policy.w_semantic * _cos(obs["text"], place["text"])
                     + policy.w_range * range_similarity(obs["range_m"], place["range_m"])) / weight_sum
            if score > best_score:
                best, best_score = idx, score

        if best is not None and best_score >= policy.threshold:
            place = places[best]
            place["members"].append(obs)
            place["image"] = _mean_unit([m["image"] for m in place["members"]])
            place["text"] = _mean_unit([m["text"] for m in place["members"]])
            ranges = [m["range_m"] for m in place["members"] if m["range_m"]]
            place["range_m"] = sum(ranges) / len(ranges) if ranges else None
            idx = best
        else:
            places.append({"members": [obs], "image": obs["image"], "text": obs["text"],
                           "range_m": obs["range_m"]})
            idx = len(places) - 1
        assignment[obs["id"]] = idx
        decisions.append({"observation_id": obs["id"], "place": idx,
                          "best_score": round(best_score, 4) if best is not None else None})
        if previous is not None and previous != idx:
            key = tuple(sorted((previous, idx)))
            edges[key] = edges.get(key, 0) + 1
        previous = idx

    return {"places": places, "assignment": assignment, "edges": edges, "decisions": decisions}


# ── Evaluation against pose-derived reference labels ───────────────────────
def _turn(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def reference_pairs(observations: list[dict]) -> list[dict]:
    """Approximate spatial ground truth from simulator pose (never a policy input).

    Pairs that are neither clearly the same viewpoint nor clearly apart are
    left out rather than guessed.
    """
    pairs = []
    for a, b in combinations(observations, 2):
        pa, pb = a["pose"], b["pose"]
        dist = math.hypot(pa["x"] - pb["x"], pa["z"] - pb["z"])
        turn = _turn(pa.get("headingDeg", 0), pb.get("headingDeg", 0))
        if dist <= SAME_PLACE_MAX_M and turn <= SAME_PLACE_MAX_TURN:
            label = True
        elif dist >= DIFFERENT_PLACE_MIN_M:
            label = False
        else:
            continue
        pairs.append({"a": a["id"], "b": b["id"], "same": label,
                      "dist_m": round(dist, 2), "turn_deg": round(turn)})
    return pairs


def split_pairs(pairs: list[dict]) -> tuple[list[dict], list[dict]]:
    """Frozen, deterministic split: alternate positives and negatives into a
    policy-selection set and a held-out evaluation set."""
    selection, held_out = [], []
    for label in (True, False):
        group = sorted((p for p in pairs if p["same"] is label), key=lambda p: (p["a"], p["b"]))
        for i, p in enumerate(group):
            (selection if i % 2 == 0 else held_out).append(p)
    return selection, held_out


def evaluate(graph: dict, pairs: list[dict]) -> dict:
    """Balanced accuracy over revisit (same) and distinct (different) pairs."""
    assign = graph["assignment"]
    tp = fn = tn = fp = 0
    missed, merged = [], []
    for p in pairs:
        predicted_same = assign[p["a"]] == assign[p["b"]]
        if p["same"]:
            if predicted_same:
                tp += 1
            else:
                fn += 1
                missed.append(p)
        else:
            if predicted_same:
                fp += 1
                merged.append(p)
            else:
                tn += 1
    recall = tp / (tp + fn) if tp + fn else None
    specificity = tn / (tn + fp) if tn + fp else None
    parts = [x for x in (recall, specificity) if x is not None]
    return {
        "score": round(sum(parts) / len(parts), 4) if parts else None,
        "revisit_recall": recall, "distinct_specificity": specificity,
        "revisits": tp + fn, "missed_revisits": fn, "distinct": tn + fp, "false_merges": fp,
        "missed": missed, "false_merged": merged,
    }


# ── Persistence ────────────────────────────────────────────────────────────
def save_graph(graph: dict, policy: Policy, scene_id: str) -> str:
    """Stores the graph (one document per build); the newest build is active."""
    places = []
    for idx, place in enumerate(graph["places"]):
        members = place["members"]
        xs = [m["pose"].get("x", 0) for m in members]
        zs = [m["pose"].get("z", 0) for m in members]
        places.append({
            "place_id": f"p{idx}",
            "observation_ids": [m["id"] for m in members],
            "image_embedding": place["image"],
            "text_embedding": place["text"],
            "description": members[0]["summary"],
            "spatial_signature": {"ranges_m": [m["range_m"] for m in members],
                                  "mean_range_m": place["range_m"]},
            # DISPLAY ONLY — pose never feeds the matching policy.
            "display_xz": [sum(xs) / len(xs), sum(zs) / len(zs)],
        })
    edges = [{"from": f"p{a}", "to": f"p{b}", "traversals": n} for (a, b), n in graph["edges"].items()]
    doc = {"scene_id": scene_id, "policy": policy.as_dict(), "places": places, "edges": edges,
           "decisions": graph["decisions"], "built_at": datetime.now(timezone.utc)}
    return str(db.get_db()[GRAPHS].insert_one(doc).inserted_id)


def latest_graph(scene_id: str | None = None) -> dict | None:
    query = {"scene_id": scene_id} if scene_id else {}
    doc = db.get_db()[GRAPHS].find_one(query, {"places.image_embedding": 0, "places.text_embedding": 0,
                                               "decisions": 0}, sort=[("built_at", -1)])
    if doc:
        doc["id"] = str(doc.pop("_id"))
        doc["built_at"] = doc["built_at"].isoformat()
    return doc
