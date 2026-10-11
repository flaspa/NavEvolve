"""NavEvolve Harness (hackathon, Milestone 4): automatic improvement of the
place-recognition policy that builds the cognitive map.

One run:
  1. Replay the enriched observations of a scene with the ACTIVE policy and
     build the cognitive graph.
  2. Measure place-recognition errors (missed revisits, false merges) against
     pose-derived reference pairs, split ONCE into a policy-selection set and
     a frozen held-out set (memory.split_pairs).
  3. Generate candidate policies: a coarse grid over weights × threshold, then
     a local refinement around the best coarse candidate.
  4. Score every candidate on the SELECTION pairs only, by revisit-pair F1
     (penalises false merges; balanced accuracy hid them behind class imbalance).
  5. Adopt the best candidate only if its selection F1 beats the baseline
     policy's; evaluate held-out ONCE afterwards, never to choose.
  6. Persist the policy version, metrics and run history in MongoDB.
  7. Rebuild and persist the cognitive graph with the (possibly new) policy.

    .venv/Scripts/python harness.py            # scene with the most enriched observations
    .venv/Scripts/python harness.py --reset    # start again from Policy v1
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from itertools import product
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

import db  # noqa: E402
import memory  # noqa: E402
from memory import Policy  # noqa: E402

POLICIES = "harness_policies"
RUNS = "harness_runs"
MIN_REVISITS = 2  # per split; fewer means the data cannot support a claim
# Policy-selection objective. "f1" (revisit-pair F1) is the default: it
# penalises false merges. "balanced_accuracy" was used by the first run and
# rewarded over-merging; it remains available only to reproduce that record.
OBJECTIVES = {"f1": "revisit F1", "balanced_accuracy": "balanced accuracy"}


def active_policy(version: int | None = None) -> Policy:
    query = {"version": version} if version else {}
    doc = db.get_db()[POLICIES].find_one(query, sort=[("version", -1)])
    if doc is None:
        policy = Policy()
        db.get_db()[POLICIES].insert_one({**policy.as_dict(), "parent": None, "adopted_at":
                                          datetime.now(timezone.utc), "rationale": "initial fixed configuration"})
        return policy
    return Policy(**{k: doc[k] for k in ("version", "w_visual", "w_semantic", "w_range", "threshold")})


def _set_status(status: str, **extra) -> None:
    db.get_db()[RUNS].update_one({"_id": "status"}, {"$set": {"status": status, "updated_at":
                                 datetime.now(timezone.utc), **extra}}, upsert=True)


def _weights(step: float) -> list[tuple[float, float, float]]:
    n = round(1 / step)
    return [(i * step, j * step, (n - i - j) * step) for i in range(n + 1) for j in range(n + 1 - i)
            if (i + j) > 0]  # at least some perception weight


def candidates_coarse() -> list[Policy]:
    thresholds = [round(0.50 + 0.05 * k, 2) for k in range(10)]
    return [Policy(0, wv, ws, wr, t) for (wv, ws, wr), t in product(_weights(0.25), thresholds)]


def candidates_local(best: Policy) -> list[Policy]:
    out = []
    for dv, ds, dt in product((-0.1, 0, 0.1), (-0.1, 0, 0.1), [k * 0.01 for k in range(-4, 5)]):
        wv, ws = best.w_visual + dv, best.w_semantic + ds
        wr = 1 - wv - ws
        if min(wv, ws, wr) < -1e-9:
            continue
        out.append(Policy(0, round(wv, 2), round(ws, 2), round(max(wr, 0), 2), round(best.threshold + dt, 2)))
    return out


def _distance(a: Policy, b: Policy) -> float:
    return abs(a.w_visual - b.w_visual) + abs(a.w_semantic - b.w_semantic) + \
        abs(a.w_range - b.w_range) + abs(a.threshold - b.threshold)


def run(scene_id: str | None = None, objective: str = "f1", from_version: int | None = None) -> dict:
    observations = memory.load_observations(scene_id)
    if not scene_id:
        counts: dict[str, int] = {}
        for o in observations:
            counts[o["scene_id"]] = counts.get(o["scene_id"], 0) + 1
        scene_id = max(counts, key=counts.get) if counts else None
        observations = [o for o in observations if o["scene_id"] == scene_id]
    if not observations:
        return {"error": "no enriched observations"}

    _set_status("running", scene_id=scene_id)
    pairs = memory.reference_pairs(observations)
    selection, held_out = memory.split_pairs(pairs)
    current = active_policy(from_version)
    objective_of = lambda m: m[objective]  # noqa: E731

    graph_v1 = memory.build_graph(observations, current)
    sel_before, held_before = memory.evaluate(graph_v1, selection), memory.evaluate(graph_v1, held_out)

    report = {"scene_id": scene_id, "observations": len(observations), "objective": objective,
              "reference_pairs": {"selection": len(selection), "held_out": len(held_out),
                                  "revisits_selection": sel_before["revisits"],
                                  "revisits_held_out": held_before["revisits"]},
              "policy_before": current.as_dict(),
              "before": {"selection": _brief(sel_before), "held_out": _brief(held_before)}}

    if sel_before["revisits"] < MIN_REVISITS or held_before["revisits"] < MIN_REVISITS:
        report["result"] = ("insufficient revisits: explore a short loop that returns to earlier "
                            "viewpoints, then run the harness again")
        _finish(report, current, graph_v1, observations, scene_id, adopted=False)
        return report

    # 3–4. Generate and score candidates on the selection pairs only.
    scored = []
    for cand in candidates_coarse():
        scored.append((objective_of(memory.evaluate(memory.build_graph(observations, cand), selection)) or 0, cand))
    best_coarse = max(scored, key=lambda s: (s[0], -_distance(s[1], current)))[1]
    for cand in candidates_local(best_coarse):
        scored.append((objective_of(memory.evaluate(memory.build_graph(observations, cand), selection)) or 0, cand))
    best_score, best = max(scored, key=lambda s: (s[0], -_distance(s[1], current)))
    report["candidates_evaluated"] = len(scored)

    # 5. Adopt only on a strict improvement of the selection score.
    adopted = best_score > (objective_of(sel_before) or 0)
    next_version = (db.get_db()[POLICIES].find_one(sort=[("version", -1)]) or {"version": 0})["version"] + 1
    new_policy = Policy(next_version, best.w_visual, best.w_semantic, best.w_range,
                        best.threshold) if adopted else current
    graph_v2 = memory.build_graph(observations, new_policy)
    sel_after, held_after = memory.evaluate(graph_v2, selection), memory.evaluate(graph_v2, held_out)
    report.update({
        "adopted": adopted, "policy_after": new_policy.as_dict(),
        "after": {"selection": _brief(sel_after), "held_out": _brief(held_after)},
        "fixed_revisits": _fixed(graph_v1, graph_v2, pairs),
        "new_false_merges": _broken(graph_v1, graph_v2, pairs),
    })
    if adopted:
        db.get_db()[POLICIES].insert_one({
            **new_policy.as_dict(), "parent": current.version, "adopted_at": datetime.now(timezone.utc),
            "objective": objective, "selection_score": objective_of(sel_after),
            "held_out_score": objective_of(held_after), "held_out": _brief(held_after),
            "rationale": f"selection {OBJECTIVES[objective]} {objective_of(sel_before)} → "
                         f"{objective_of(sel_after)} over {len(scored)} candidates"})
    improved_held_out = adopted and (objective_of(held_after) or 0) > (objective_of(held_before) or 0)
    report["held_out_improved"] = improved_held_out
    if not adopted:
        report["result"] = "no candidate beat the baseline policy on the selection split"
    elif improved_held_out:
        report["result"] = f"held-out {OBJECTIVES[objective]} improved"
    else:
        report["result"] = f"No demonstrated held-out {OBJECTIVES[objective]} improvement."
    _finish(report, new_policy, graph_v2, observations, scene_id, adopted)
    return report


def _brief(m: dict) -> dict:
    return {k: m[k] for k in ("f1", "precision", "recall", "balanced_accuracy", "revisits",
                              "missed_revisits", "distinct", "false_merges")}


def _same(graph: dict, p: dict) -> bool:
    return graph["assignment"][p["a"]] == graph["assignment"][p["b"]]


def _fixed(g1: dict, g2: dict, pairs: list[dict]) -> list[dict]:
    return [p for p in pairs if p["same"] and not _same(g1, p) and _same(g2, p)]


def _broken(g1: dict, g2: dict, pairs: list[dict]) -> list[dict]:
    return [p for p in pairs if not p["same"] and not _same(g1, p) and _same(g2, p)]


def _finish(report: dict, policy: Policy, graph: dict, observations: list, scene_id: str, adopted: bool):
    report["graph_id"] = memory.save_graph(graph, policy, scene_id)
    report["places"] = len(graph["places"])
    report["edges"] = len(graph["edges"])
    db.get_db()[RUNS].insert_one({**report, "ran_at": datetime.now(timezone.utc)})
    report.pop("_id", None)
    after = (report.get("after") or report["before"])["held_out"]
    _set_status("idle", scene_id=scene_id, last_result=report["result"], policy_version=policy.version,
                baseline_version=report["policy_before"]["version"],
                objective=report["objective"], metric_label=f"held-out {OBJECTIVES[report['objective']]}",
                score_before=report["before"]["held_out"][report["objective"]],
                score_after=after[report["objective"]], places=report["places"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NavEvolve recursive harness run")
    parser.add_argument("--scene")
    parser.add_argument("--objective", choices=sorted(OBJECTIVES), default="f1")
    parser.add_argument("--from-version", type=int, help="baseline policy version (default: newest)")
    parser.add_argument("--reset", action="store_true", help="discard adopted policies; restart at v1")
    args = parser.parse_args()
    if args.reset:
        db.get_db()[POLICIES].delete_many({})
    print(json.dumps(run(args.scene, args.objective, args.from_version), indent=2, default=str))
