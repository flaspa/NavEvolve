"""Smoke test for goal-directed navigation: the deterministic rule and JSON
extraction offline, then one real /goal/step on a synthetic frame. No server.

    conda activate vlmserver
    cd /mnt/c/Flavia/Code/seekr-worlds/brain
    python smoke_goal.py
"""

import base64
import io

import navigator
from smoke_perceive import synthetic_frame


def offline_checks() -> None:
    p = navigator.parse_perception(
        'Sure. {"target_visible": true, "horizontal": "right", "distance": "far", '
        '"reached": false, "description": "A doorway on the right."}'
    )
    assert p["parsed"] and p["horizontal"] == "right", p
    assert navigator.decide(p, {})["type"] == "turn_right"
    p["horizontal"] = "center"
    assert navigator.decide(p, {})["type"] == "move_forward"
    assert navigator.decide(p, {"blocked": True})["type"] == "turn_left"
    p["distance"] = "near"
    assert navigator.decide(p, {})["type"] == "stop"
    bad = navigator.parse_perception("I cannot see any stools here.")
    assert not bad["parsed"] and not bad["target_visible"]
    assert navigator.decide(bad, {"not_visible_streak": 0})["type"] == "turn_left"
    assert navigator.decide(bad, {"not_visible_streak": 99})["type"] == "stop"
    assert navigator.decide(p, {"iteration": 99, "reached": False})["type"] == "stop"
    print("offline rule/parse checks: OK")


def main() -> int:
    offline_checks()

    import liquid

    perception = liquid.LiquidPerception()
    perception.load()
    if perception.status != "ready":
        print("model not ready:", perception.error)
        return 1

    img = synthetic_frame()
    for goal in ["Walk toward the doorway and stand next to it.", "Walk toward the stools."]:
        r = navigator.goal_step(perception, img, goal, {"iteration": 0})
        print(f"goal={goal!r}\n  raw: {r['raw'][:220]!r}\n  perception: {r['perception']}\n"
              f"  action: {r['action']}  latency_ms={r['latency_ms']}")

    from fastapi.testclient import TestClient

    import app as brain_app

    brain_app.perception = perception
    client = TestClient(brain_app.app)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    res = client.post(
        "/goal/step",
        json={"image_data_url": data_url, "goal": "Go to the doorway.", "scene_id": "smoke",
              "body": {"iteration": 3, "blocked": True, "blocked_streak": 1}},
    )
    body = res.json()
    body.pop("raw", None)
    print("goal/step:", res.status_code, body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
