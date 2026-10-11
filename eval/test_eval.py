import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import run_objectnav as R, report

S = "interior_0759_839979"


def test_load_and_pick():
    eps, gbc = R.load_episodes(S)
    assert eps and gbc
    pick = R.pick_episodes(eps, 10)
    assert len(pick) == 10 and pick == R.pick_episodes(eps, 10)
    assert len({e["object_category"] for e in pick}) > 1


def test_heading():
    assert abs(R.quat_to_heading_deg([0, 0, 0, 1])) < 1e-6
    import math
    h = 90
    assert abs(R.quat_to_heading_deg([0, math.sin(math.radians(h / 2)), 0, math.cos(math.radians(h / 2))]) - 90) < 1e-6


def test_success():
    eps, gbc = R.load_episodes(S)
    g = R.goals_for(gbc, S, eps[0]["object_category"])
    assert g
    p = g[0]["view_points"][0]["agent_state"]["position"]
    assert R.check_success({"success": True}, {"x": p[0] + 0.5, "z": p[2]}, g)
    assert not R.check_success({"success": True}, {"x": p[0] + 500, "z": p[2]}, g)
    assert not R.check_success({"success": False}, {"x": p[0], "z": p[2]}, g)


def test_report(tmp_path):
    runs = []
    for m in ("kept", "wiped"):
        eps = [dict(index=i, goal="lamp", mode="recall" if m == "kept" and i else "explore", success=i % 2 == 0,
                    steps=20 - (i if m == "kept" else 0), metres=10.0, seconds=30.0, thoughts=["a<b"]) for i in range(5)]
        f = tmp_path / f"{m}.json"
        f.write_text(json.dumps(dict(scene=S, mode=m, episodes=eps)))
        runs.append(f)
    out = Path(__file__).parent / "report.html"
    report.build(runs, out)
    t = out.read_text()
    assert "<polyline" in t and "<details>" in t and "a&lt;b" in t
