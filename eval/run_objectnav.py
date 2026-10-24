"""ObjectNav eval. Must run inside the brain process (real body lives on the websocket), so for the
real stack this script starts uvicorn (server:app, port 8000) in its own event loop, then waits for the
browser to connect. Run from brain/:  python ../eval/run_objectnav.py --scene interior_0759_839979 --n 10 --mode both
--fake: FakeBody + NAVEVOLVE_FAKE_MODELS=1, no browser."""
import argparse, asyncio, gzip, json, math, os, random, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "brain"))


def load_episodes(scene, root=ROOT):
    p = root / f"data/benchmark/episodes/objectnav/val/content/{scene}.json.gz"
    with gzip.open(p) as f:
        d = json.load(f)
    return d["episodes"], d["goals_by_category"]


def quat_to_heading_deg(q):
    """xyzw quaternion -> headingDeg in [0,360); same as agentPose.js (forward=+z, atan2(x,z))."""
    x, y, z, w = q
    fx, fz = 2 * (x * z + w * y), 1 - 2 * (x * x + y * y)
    return math.degrees(math.atan2(fx, fz)) % 360


def goals_for(goals_by_category, scene, cat):
    return goals_by_category.get(f"{scene}.gs.ply_{cat}", [])


def check_success(ep, pose, goals):
    """CONTRACTS §4. ponytail: 'object verified visible' is approximated by the agent's own success flag."""
    if not ep.get("success"):
        return False
    px, pz = pose["x"], pose["z"]
    for g in goals:
        for vp in g["view_points"]:
            p = vp["agent_state"]["position"]
            if math.hypot(px - p[0], pz - p[2]) <= 1.0:
                return True
        if math.hypot(px - g["position"][0], pz - g["position"][2]) <= 1.5:
            return True
    return False


def pick_episodes(episodes, n, seed=0):
    rng = random.Random(seed)
    by_cat = {}
    for e in episodes:
        by_cat.setdefault(e["object_category"], []).append(e)
    cats = sorted(by_cat)
    rng.shuffle(cats)
    out, i = [], 0
    while len(out) < n and any(by_cat.values()):
        c = cats[i % len(cats)]
        if by_cat[c]:
            out.append(by_cat[c].pop(rng.randrange(len(by_cat[c]))))
        i += 1
    return out


async def run_mode(mode, body, agent, memory, scene, eps, goals_by_cat):
    rows = []
    if mode == "kept":
        memory.wipe(scene)
    for i, e in enumerate(eps):
        if mode == "wiped":
            memory.wipe(scene)
        sx, _, sz = e["start_position"]
        await body.reset(sx, sz, quat_to_heading_deg(e["start_rotation"]))
        ep = await agent.find(body, scene, goal=e["object_category"])
        r = await body.pose()
        pose = r.get("pose", r)
        ok = check_success(ep, pose, goals_for(goals_by_cat, scene, e["object_category"]))
        rows.append(dict(index=i, episode_id=e["episode_id"], goal=e["object_category"], mode=ep.get("mode"),
                         success=ok, steps=len(ep.get("steps", [])), metres=ep.get("metres"), seconds=ep.get("seconds"),
                         thoughts=[s.get("thought") for s in ep.get("steps", []) if s.get("thought")]))
        print(mode, i, rows[-1]["goal"], rows[-1]["mode"], ok, rows[-1]["steps"], flush=True)
    return rows


async def main(a):
    if a.fake:
        os.environ["NAVEVOLVE_FAKE_MODELS"] = "1"
    import agent, agent_memory as memory
    episodes, gbc = load_episodes(a.scene)
    eps = pick_episodes(episodes, a.n, a.seed)
    if a.fake:
        from fake_body import FakeBody
        body = FakeBody()
    else:
        import uvicorn, agent_ws, server
        srv = uvicorn.Server(uvicorn.Config(server.app, port=8000, log_level="warning"))
        asyncio.create_task(srv.serve())
        while True:
            try:
                body = agent_ws.get_body()
                if asyncio.iscoroutine(body):
                    body = await body
                if body:
                    break
            except Exception:
                pass
            print("waiting for browser on /agent/ws ...", flush=True)
            await asyncio.sleep(2)
    ts = time.strftime("%Y%m%d-%H%M%S")
    (ROOT / "eval/results").mkdir(exist_ok=True, parents=True)
    for mode in (["kept", "wiped"] if a.mode == "both" else [a.mode]):
        rows = await run_mode(mode, body, agent, memory, a.scene, eps, gbc)
        out = ROOT / f"eval/results/{a.scene}-{mode}-{ts}.json"
        out.write_text(json.dumps(dict(scene=a.scene, mode=mode, episodes=rows), indent=1))
        print("wrote", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", default="interior_0759_839979")
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--mode", choices=["kept", "wiped", "both"], default="both")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--fake", action="store_true")
    asyncio.run(main(ap.parse_args()))
