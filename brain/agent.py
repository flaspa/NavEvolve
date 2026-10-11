"""Agent loop: RECALL -> NAVIGATE -> EXPLORE (see docs/AGENT_PLAN.md stream E)."""
import asyncio
import math
import time
from datetime import datetime, timezone


WATCH_S = 1.0  # seconds between forward photos while walking (each is one VLM verify + ingest)


async def _timed(fn, *args):
    """to_thread + a timing line per model / memory / db call."""
    t = time.time()
    try:
        r = await asyncio.to_thread(fn, *args)
    except Exception as e:
        print(f"[time] {fn.__name__} FAILED after {time.time() - t:.1f}s: {e!r}", flush=True)
        raise
    out = {k: r[k] for k in ("visible", "choice", "reason") if k in r} if isinstance(r, dict) else (len(r) if isinstance(r, list) else "")
    print(f"[time] {fn.__name__} {time.time() - t:.1f}s -> {out}", flush=True)
    return r

try:  # tests monkeypatch these module attributes
    import models_impl as models
    import agent_memory as memory
    import db
except Exception:  # pragma: no cover
    models = memory = db = None


def _fwd(h):  # unit (x, z) the camera faces; turn(+deg) = left
    r = math.radians(h)
    return math.sin(r), math.cos(r)  # app convention: heading 0 faces +Z (agentPose.js)


def _describe(p, f):
    dx, dz = f["x"] - p["x"], f["z"] - p["z"]
    fx, fz = _fwd(p["headingDeg"])
    side = "left" if dx * fz - dz * fx > 0 else "right"
    return f"frontier {math.hypot(dx, dz):.1f} m to the {side}, size {f['size']}"


async def find(body, scene_id, goal, max_steps=40, max_seconds=300):
    t0 = time.time()
    ep = {"scene_id": scene_id, "goal": goal, "started": datetime.now(timezone.utc).isoformat(),
          "mode": "explore", "steps": [], "success": False, "metres": 0.0, "seconds": 0.0}
    print(f"[agent] find {goal!r} in {scene_id}", flush=True)
    tried = []  # object positions already checked and not found

    def budget():
        return len(ep["steps"]) < max_steps and time.time() - t0 < max_seconds

    async def log(action, args, pose=None, thought="", frame=None, phase=None):
        fid = frame and frame.get("frameId")
        ep["steps"].append({"action": action, "args": args, "pose": pose, "thought": thought, "frameId": fid})
        print(f"[agent] {action} {args} {thought}", flush=True)
        if thought:
            await body.thought(phase or action, thought, fid)

    async def go(x, z, stop=0.3):
        r = await body.goto(x, z, stop)
        ep["metres"] += r.get("pathLength", 0) or 0
        await log("goto", {"x": x, "z": z}, r.get("pose"))
        return r

    def is_tried(p):
        return any(math.hypot(p[0] - t[0], p[2] - t[2]) < 1.0 for t in tried)

    async def navigate(pos, name):
        """Walk to ~1 m from pos, look at it, verify. True when goal visible."""
        pose = await body.pose()
        pose = pose.get("pose", pose)
        vx, vz = pose["x"] - pos[0], pose["z"] - pos[2]
        d = math.hypot(vx, vz)
        sx, sz = (pos[0] + vx / d, pos[2] + vz / d) if d > 1 else (pose["x"], pose["z"])
        await go(sx, sz)
        r = await body.face(pos[0], pos[2])
        await log("face", {"x": pos[0], "z": pos[2]}, r.get("pose"))
        frame = (await body.capture(1))[0]
        v = await _timed(models.verify, frame["jpeg"], goal)
        if not v["visible"]:  # position estimates are rough: look around once before giving up here
            frames = await body.capture(4)
            for f, fv in zip(frames, await asyncio.gather(*(_timed(models.verify, f["jpeg"], goal) for f in frames))):
                if fv["visible"]:
                    await body.turn((f["pose"]["headingDeg"] - frames[0]["pose"]["headingDeg"] + 180) % 360 - 180)
                    frame, v = f, fv
                    break
        if v["visible"]:
            await log("verify", {"goal": goal}, frame["pose"], f"Found the {goal}: {v.get('reason', '')}", frame, "found")
            return True
        tried.append(pos)
        await log("verify", {"goal": goal}, frame["pose"], f"The {name} isn't there after all.", frame, "verify")
        return False

    async def view(h):
        """Stand where a matching view was taken, face the same way, verify."""
        await go(h["position"][0], h["position"][2])
        p = await body.pose(); p = p.get("pose", p)
        await body.turn((h["headingDeg"] - p["headingDeg"] + 180) % 360 - 180)
        frame = (await body.capture(1))[0]
        v = await _timed(models.verify, frame["jpeg"], goal)
        await log("verify", {"goal": goal}, frame["pose"], f"Found the {goal}: {v.get('reason', '')}" if v["visible"]
                  else f"The {goal} isn't in this view after all.", frame, "found" if v["visible"] else "verify")
        if not v["visible"]:
            tried.append(h["position"])
        return v["visible"]

    async def recall():
        for h in await _timed(memory.search, scene_id, goal, 3, True):
            if h.get("verified") and not is_tried(h["position"]):
                p = h["position"]
                if not ep["steps"]:
                    ep["mode"] = "recall"
                await log("recall", {"position": p}, None,
                          f"I've seen a {h['name']} before near ({p[0]:.1f},{p[2]:.1f}) — heading there.", phase="recall")
                if h.get("source") == "desc" and await view(h):
                    return True
                if h.get("source") != "desc" and await navigate(p, h["name"]):
                    return True
        return False

    async def finish(ok):
        ep["success"], ep["seconds"] = ok, time.time() - t0
        try:
            await body.memory(await _timed(memory.known_objects, scene_id))
            await _timed(db.insert_episode, dict(ep))
        except Exception:  # no Mongo / no UI: fine
            pass
        return ep

    if await recall():
        return await finish(True)
    def check(f):
        return f, asyncio.create_task(_timed(models.verify, f["jpeg"], goal))

    def seen(checks):
        for f, c in checks:
            if c.done() and not c.cancelled() and not c.exception() and c.result()["visible"]:
                return f

    async def approach(f):
        p, fx = f["pose"], _fwd(f["pose"]["headingDeg"])
        r = min(f.get("rangeM") or 2, 2)
        tgt = [p["x"] + fx[0] * r, p["y"], p["z"] + fx[1] * r]
        if is_tried(tgt):
            return False
        await log("see", {}, p, f"I think I see the {goal} ahead — approaching.", f, "explore")
        return await navigate(tgt, goal)

    async def pick(frames):
        fr = (await body.frontiers())["frontiers"]
        if not fr:
            return fr, None
        pose = (await body.pose()); pose = pose.get("pose", pose)
        known = await _timed(memory.known_objects, scene_id)
        ctx = "Known objects: " + (", ".join(o["name"] for o in known) or "none yet")
        return fr, await _timed(models.choose, [f["jpeg"] for f in frames], goal, ctx, [_describe(pose, x) for x in fr])

    # Explore: one forward photo every WATCH_S while walking, each goal-checked in the background;
    # a sighting halts the walk. At each arrival, choosing the next frontier overlaps the last checks.
    recent = await body.capture(1)
    checks = [check(recent[-1])]
    n = 0
    while budget():
        n += 1
        try:
            await body.memory(await _timed(memory.known_objects, scene_id))
        except Exception:
            pass
        picking = asyncio.create_task(pick(recent))
        if seen(checks) is None:
            await asyncio.gather(*(c for _, c in checks), return_exceptions=True)
        f, checks = seen(checks), []
        if f is not None:
            if await approach(f):
                picking.cancel()
                return await finish(True)
            picking.cancel()  # options were described from before the approach
            recent = await body.capture(1)
            picking = asyncio.create_task(pick(recent))
        if n % 3 == 0 and await recall():
            picking.cancel()
            return await finish(True)
        fr, c = await picking
        if not fr or not c or not budget():
            break
        t = fr[min(max(c["choice"], 0), len(fr) - 1)]
        await body.thought("explore", c["thought"])
        walking = asyncio.create_task(go(t["x"], t["z"]))
        while not walking.done():
            frame = (await body.capture(1))[0]
            recent = (recent + [frame])[-4:]
            checks.append(check(frame))
            if seen(checks) is not None:
                await body.halt()
                break
            await asyncio.wait([walking], timeout=WATCH_S)
        await walking
        ep["steps"][-1]["thought"] = c["thought"]
        if seen(checks) is None:  # arrival view
            frame = (await body.capture(1))[0]
            recent = (recent + [frame])[-4:]
            checks.append(check(frame))
    await body.thought("fail", f"I couldn't find a {goal}.")
    return await finish(False)
