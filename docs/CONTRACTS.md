# Contracts (frozen — change only via the lead)

Scene: `interior_0759_839979`. Coordinates: metres, Y up, Habitat == app coordinates.
Heading: degrees, `headingDeg` as reported by `observedFrom` in `captureEgo()`; `turn(+deg)` = turn left.
Python modules live flat in `brain/` and are imported as top-level modules (`import db`),
run from `brain/` (`python -m uvicorn server:app --port 8000`, `python body_demo.py`).

## 1. WebSocket `ws://localhost:8000/agent/ws`

Brain = server (FastAPI websocket route in `brain/agent_ws.py`, mounted by `server.py`).
Browser = client (`body/src/agentLink.js`), connects on load, reconnects every 2 s.

Brain → browser: `{"id": "<uuid>", "cmd": "<name>", ...args}`
Browser → brain reply: `{"id": "<same>", "ok": true, "result": {...}}` or `{"id", "ok": false, "error": "msg"}`
Browser → brain events (no id): `{"event": "hello", "sceneId"}`, `{"event": "goal", "text", "sceneId"}` (scene loaded when the goal was typed), `{"event": "stop"}`

| cmd | args | result |
|---|---|---|
| `capture` | `headings: int = 1` (n>1: n frames, turning 360/n left between, ending at original heading) | `{frames: [Frame]}` |
| `goto` | `x, z, stopWithin: float = 0.3` | `{status: "arrived"\|"unreachable"\|"blocked", pose: Pose, pathLength: m, path: [[x,z],...]}` |
| `turn` | `deg` | `{pose}` |
| `face` | `x, z` | `{pose}` |
| `pose` | — | `{pose}` |
| `frontiers` | — | `{frontiers: [{x, z, size}], coverage: 0..1}` (largest first, max 8) |
| `reset` | `x, z, headingDeg` | `{pose}` (snapped to NavMesh, clears visited grid) |
| `thought` | `phase: str, text: str, frameId?: str` | `{}` |
| `memory` | `objects: [{name, position:[x,y,z], confidence}]` | `{}` (UI map/panel refresh) |

```
Pose  = {x, y, z, headingDeg, pitchDeg}
Frame = {frameId, sceneId, jpegDataUrl, pose: Pose,
         camera: {fovDeg (vertical), aspect, near, far}, rangeM: number|null, ts: ISO string}
```
`goto` walks at normal walk speed (rendered live, ≤ ~20 s per call) and arrives facing the
direction of travel. `capture` also POSTs each frame to `/observations` (trigger `"agent"`) and
includes the returned `obsId` in the Frame when the brain is up. Timeout per command: 30 s (goto 60 s).

## 2. Mongo collections (db from `brain/.env` `MONGODB_DB`)

- `observations` (existing doc + fields): `img_emb: [float]`, `desc: str`, `desc_emb: [float]`,
  `objects: [{name, description, bbox: [x0,y0,x1,y1] (0..1, image coords), emb: [float]}]`,
  `ingest: "pending"|"done"|"error"`.
- `objects`: `{_id, scene_id, name, description, emb, position: [x,y,z], sightings: int, obs_ids: [str], confidence: 0..1}`;
  sightings of the same normalised name within 0.75 m merge (position = running mean).
- `episodes`: `{_id, scene_id, goal, started, mode: "recall"|"explore", steps: [{action, args, pose, thought, frameId}], success, metres, seconds}`.

## 3. Python interfaces

```python
# brain/models.py (real) and brain/fake_models.py (same names, deterministic, no network)
embed_image(jpeg: bytes) -> np.ndarray            # unit-norm float32, gemini-embedding-2
embed_text(text: str) -> np.ndarray               # unit-norm, same space
describe(jpeg: bytes) -> str                      # location-focused 120-200 words
list_objects(jpeg: bytes) -> list[dict]           # [{name, description, bbox}]
verify(jpeg: bytes, target: str) -> dict          # {visible: bool, bbox: [..]|None, reason: str}
choose(jpegs: list[bytes], goal: str, context: str, options: list[str]) -> dict
                                                  # {choice: int (index into options), thought: str}
# Select implementation: `import models_impl as models` where models_impl picks fake when
# env NAVEVOLVE_FAKE_MODELS=1 (see brain/models_impl.py).

# brain/memory.py
async def enqueue(obs_id: str) -> None            # ingest in background worker pool (4)
async def ingest(obs_id: str) -> None             # fills observation fields, upserts objects
def search(scene_id: str, query: str, k: int = 3, verify: bool = True) -> list[dict]
    # [{position: [x,y,z], obs_id, name, score, source: "object"|"desc", verified: bool, reason}]
def known_objects(scene_id: str) -> list[dict]    # for the UI `memory` cmd
def wipe(scene_id: str) -> None                   # eval: forget everything for a scene

# brain/body.py — the agent's only handle on the world
class Body:                                       # real: over the websocket
    async def capture(self, headings: int = 1) -> list[dict]   # Frames, jpeg decoded to bytes in frame["jpeg"]
    async def goto(self, x: float, z: float, stop_within: float = 0.3) -> dict
    async def turn(self, deg: float) -> dict
    async def face(self, x: float, z: float) -> dict
    async def pose(self) -> dict
    async def frontiers(self) -> dict
    async def reset(self, x: float, z: float, heading_deg: float) -> dict
    async def thought(self, phase: str, text: str, frame_id: str | None = None) -> None
    async def memory(self, objects: list[dict]) -> None
# brain/fake_body.py: class FakeBody(Body-compatible) — 2-D grid world, no browser.

# brain/agent.py
async def find(body, scene_id: str, goal: str, max_steps: int = 40, max_seconds: float = 300) -> dict
    # returns the episode dict (also stored in `episodes`)
```

## 4. Success (eval)
Episode success = agent ends `find` with `success=True` AND its final position is within 1.0 m of
any ObjectNav `view_points[].agent_state.position` for the goal category, OR within 1.5 m of a goal
object `position` (x,z distance) with the object verified visible.
