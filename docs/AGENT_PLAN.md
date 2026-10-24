# Object-finding agent — parallel build plan

Goal: the avatar is asked "find X", explores the scene, streams its thoughts to the UI,
and accumulates a memory (image embedding + VLM description + description embedding +
object list with world positions). Later requests are answered from memory, so the agent
gets faster the more it has explored. It must never walk through walls (NavMesh).

## Facts the plan relies on (verified)

- Scene data: `data/` (gitignored), served by vite at `/habitat` (default now `../data`).
  Target scene: `interior_0759_839979` (now `APP_CONFIG.defaultSceneId`; 0637 verified rendering); `window.__seekr.captureEgo()` returns a
  768-px JPEG data URL + `observedFrom {x,y,z,headingDeg,pitchDeg}`.
- Each scene has `*.navmesh.glb` (Seekr walkability authority), `*.navmesh` (Habitat), `*.gs.ply`.
  `habitatToSeekr` is identity for the shipped scenes → Habitat coordinates == app coordinates.
- `data/benchmark/episodes/objectnav/val/content/<scene>.json.gz`: 100 episodes per scene
  (`start_position`, `start_rotation` quaternion xyzw, `object_category`) and
  `goals_by_category[<scene>.gs.ply_<cat>]` with object `position` and `view_points`.
  Categories in 0759 (target): cabinet, bookshelf, dining table, potted plant, chair, lamp, sofa.
  → ground truth for evaluation, no hand labelling.
- Existing hooks: `window.__seekr.{loadScene, captureEgo, captureObservation, player}`,
  `player.setAgentPose / getAgentPose / setInputEnabled`, `navmeshQuery.closestPointOnNavmesh`,
  `navmeshLocomotion.constrainDisplacementToNavmesh`, `ui.addMessage / addMessageWithFrame`,
  `ui` Cognitive Map panel placeholder (`data-role="cognitive-map-body"`).
- Brain: FastAPI `brain/server.py`, MongoDB via `brain/db.py` (`observations` collection).
- Feasibility code to port: `~/Projects/spacial-agents/{embed_test,text_test,object_test}.py`
  (gemini-embedding-2 via Woven proxy, gemini-3.8-flash VLM, prompts, retry-on-429).
  Findings: object→scene-description search found the object 21/25; misses were small objects
  and never-looked-at areas → store per-object entries and look around 4 headings per stop.

## Phase 0 — contracts (lead, before fan-out, ~30 min)

Written once into `docs/CONTRACTS.md`; every workstream codes against it, nobody changes it
without the lead. This is what lets the streams run in parallel without merge pain.

### 0.1 WebSocket `/agent/ws` (brain = server, browser = client)

Brain → browser commands, each `{"id": str, "cmd": str, ...args}`:

| cmd | args | reply `result` |
|---|---|---|
| `capture` | `headings?: int` (1 = current view, 4 = look around) | `{frames: [Frame]}` |
| `goto` | `x, z, stopWithin?: m (0.3)` | `{status: "arrived"\|"unreachable"\|"blocked", pose, pathLength}` |
| `turn` | `deg` (relative, + = left) | `{pose}` |
| `face` | `x, z` (turn toward point) | `{pose}` |
| `pose` | — | `{pose}` |
| `frontiers` | — | `{frontiers: [{x, z, size}], coverage: 0..1}` |
| `reset` | `x, z, headingDeg` (teleport to start; snaps to NavMesh) | `{pose}` |
| `thought` | `phase, text, frameId?` | `{}` (UI renders it) |

Browser → brain: replies `{"id", "ok": bool, "result"|"error"}`; unsolicited
`{"event": "hello", sceneId}` on connect and `{"event": "goal", text}` when the user types a goal.

`Frame = {frameId, sceneId, jpegDataUrl, pose: {x,y,z,headingDeg,pitchDeg}, camera: {fovDeg, aspect, near, far}, rangeM: number|null, ts}`.

### 0.2 Mongo collections (all keyed by `scene_id`)

- `observations` (exists; extend): `+ img_emb: float[3072], desc: str, desc_emb: float[3072], objects: [{name, description, emb, bbox: [x0,y0,x1,y1] 0..1}], ingest: "pending"|"done"|"error"`.
- `objects`: `{scene_id, name, description, emb, position: [x,y,z], sightings: int, obs_ids: [..], confidence: 0..1}` — merged per name within 0.75 m.
- `episodes`: `{scene_id, goal, mode: "recall"|"explore", steps: [{action, pose, thought, frameId}], success, metres, seconds}`.

### 0.3 Python interfaces (brain)

```python
# brain/models.py
embed_image(jpeg: bytes) -> np.ndarray           # unit-norm, gemini-embedding-2
embed_text(text: str) -> np.ndarray
describe(jpeg: bytes) -> str                     # location-focused prompt (from text_test.py)
list_objects(jpeg: bytes) -> list[dict]          # [{name, description, bbox}] JSON mode
verify(jpeg: bytes, target: str) -> dict         # {visible: bool, bbox?, reason}
choose(jpeg_list, goal, context: str, options: list[str]) -> dict   # {choice, thought}
# brain/memory.py
ingest(obs_id) -> None                           # fills the observation fields + upserts objects
search(scene_id, query: str, k=3) -> list[Hit]   # Hit = {position, obs_id, score, source, verified}
# brain/body.py  (WebSocket client wrapper used by the agent)
class Body: async capture(headings=1), goto(x,z), turn(deg), face(x,z), pose(), frontiers(), reset(...), thought(phase,text,frameId=None)
```

### 0.4 Fakes, so streams don't block on each other
- `brain/fake_body.py`: `Body` implementation over a 2-D occupancy grid from `navmesh.glb`
  top-down, returns stored JPEGs from the nearest pre-captured frame. Lets the agent loop
  run without a browser.
- `brain/fake_models.py`: deterministic hash embeddings and canned VLM replies, for tests.

## Phase 1 — parallel workstreams (sonnet, medium effort)

Each agent owns its files only. Shared files (`server.py`, `main.js`, `ui.js`) get
small, clearly delimited additions; the lead merges.

| # | Stream | Owns | Depends on | Done when (check left behind) |
|---|---|---|---|---|
| A | **Navigation in the browser** | `body/src/agentControl.js`, `body/src/navPath.js`; ≤10-line hook in `main.js` | contracts | `goto` walks to 5 random NavMesh points along a path, `unreachable` for a point off-mesh, never crosses a wall (Playwright check: each per-frame position is on the NavMesh). `capture(4)` returns 4 frames 90° apart. `frontiers()` from a visited grid. |
| B | **WebSocket link** | `brain/agent_ws.py`, `brain/body.py`, `body/src/agentLink.js` | contracts | browser connects on load, auto-reconnects; `python -m brain.body_demo` drives capture/turn/goto through the real browser. Request/response by `id`, 30 s timeout. |
| C | **Model clients** | `brain/models.py`, `brain/fake_models.py` | contracts | ports the prompts + retry logic from spacial-agents; `.env` key (`GEMINI_API_KEY`, Google AI Studio); `test_models.py` runs on fakes, `python -m brain.models <jpg>` smoke-tests the real API. |
| D | **Memory** | `brain/memory.py`, extends `brain/db.py`, `test_memory.py` | C (interface only; uses fakes) | `POST /observations` enqueues ingest (asyncio worker pool, 4); object world position = camera pose + bbox-centre bearing (from camera fov) × `rangeM` (fallback 2 m), merged per name; `search` combines object-emb hits and desc-emb hits, VLM-verifies top 3. Tests on fakes. |
| E | **Agent loop** | `brain/agent.py`, `brain/fake_body.py`, `test_agent.py` | B+C+D interfaces (uses fakes) | state machine RECALL → NAVIGATE → VERIFY / EXPLORE (frontier choice by VLM `choose`, look around 4 at each stop, in-frame goal check), step + time budget, every step emits `thought`. Runs end-to-end on fake body + fake models. |
| F | **UI** | `body/src/agentPanel.js`, CSS; small hook in `ui.js` | contracts | goal input box → `goal` event; thought stream with thumbnails in the Log; Cognitive Map panel lists known objects; minimap dots for memory objects + the planned path. |
| G | **Evaluation harness** | `eval/run_objectnav.py`, `eval/report.py` | contracts (+ fakes) | reads ObjectNav episodes; for a scene runs N goals in sequence with memory kept vs wiped; success = agent stops within 1.0 m of any goal `view_points` position (or object within 1.5 m and visible); writes `eval/report.html` (steps per goal index curve, paths, thoughts — same style as spacial-agents `report.html`). Works against fake body first. |

Parallelism: A, B, C, F, G start immediately. D and E start immediately too, against fakes
and the Phase-0 interfaces. All seven can run at once; most stream pairs touch no shared files.

## Phase 2 — integration (lead + 1 agent)

1. Merge A+B+F: drive the real browser from `body_demo`.
2. Swap fakes for real C+D in E; run one goal live ("find the bookshelf"), watch thoughts.
3. G against the real stack, scene 0759_839979, 10 goals × {memory kept, memory wiped}.
4. Fix, tune (search weights, verify threshold, look-around cadence), re-run G.

## Phase 3 — stretch
- Other scenes (`loadScene`), the "self-improving policy" harness tuning knobs against G's score.
- Atlas Vector Search instead of in-process numpy (brute force is fine up to ~10k observations).

## Agent briefing template (per stream)

> You are building stream **X** of `docs/AGENT_PLAN.md` in `/Users/jun.jiang/Projects/NavEvolve`
> (branch `explore-local`). Read `docs/AGENT_PLAN.md` and `docs/CONTRACTS.md` first; code
> against the contracts exactly. Only edit the files your stream owns (plus the small hook
> named). Match the surrounding code style. Leave the "done when" check runnable. Don't commit;
> report files changed, how to run the check, and anything in the contract that blocked you.

## Risks
- VLM latency (2–5 s/step): one combined call per frame (goal-in-view + next move); ingest is
  async and off the critical path.
- Object positions from the centre-ray range are rough → always NAVIGATE then VERIFY/approach.
- Rate limits: Gemini proxy only on the live path; Voyage stays offline (3 RPM).
- Parallel edits: shared files limited to marked hook blocks; lead merges in Phase 2.
