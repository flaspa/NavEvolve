# NavEvolve

A self-improving embodied navigation harness: an avatar explores Gaussian
Splat interiors, builds a persistent cognitive map of places in MongoDB, and
automatically improves its place-recognition policy.

Built for the Cerebral Valley Harness Engineering & Model Wrangling Hackathon
on top of the pre-hackathon Seekr Body. `PROVENANCE.md` lists exactly what was
reused and what is new.

## Architecture

| Component | Role | Status |
|---|---|---|
| **Body** (`body/`) | 3D world (Three.js + Spark splats), human avatar, NavMesh-constrained WASD locomotion, minimap, egocentric frame capture (`frameCapture.js`) | ✅ working (reused) |
| **Perception** (`brain/perception.py`) | ego JPEG + pose + camera + Gaussian-splat centre range → MongoDB `observations`; Gemini 3.8 Flash structured description + separate 768-d image and text embeddings (Gemini Embedding 2) on the same document | capture ✅ · enrichment ✅ (1 observation so far) |
| **Object memory** (`brain/objects.py`) | `objects` collection: detected objects with approximate 3D positions grounded on the splat, sightings, supporting observations and the cognitive place they belong to | ✅ |
| **Memory** (`brain/memory.py`) | cognitive map: observations replayed chronologically, matched to place memories by a weighted visual/semantic/range policy, places + traversal edges persisted in `cognitive_graphs` | ✅ |
| **Harness** (`brain/harness.py`) | replays observations, measures missed revisits / false merges against pose-derived reference pairs (selection vs frozen held-out split), searches candidate policies, adopts only on improvement, persists `harness_policies` / `harness_runs`, rebuilds the graph | ✅ |

```
body/   Vite app — main.js wires world.js, player.js, avatar.js, minimap.js, ui.js
brain/  FastAPI — server.py (endpoints), db.py (MongoDB, server-side only)
```

## Run

**Backend** — http://localhost:8000 (no GPU)

```bash
cd brain
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-server.txt   # Windows
cp .env.example .env    # set MONGODB_URI and MONGODB_DB
.venv/Scripts/python -m uvicorn server:app --port 8000
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /db/health` | real MongoDB Atlas ping |
| `POST /db/roundtrip` | insert, read back and delete one test document |
| `POST /observations` | store an ego JPEG + pose + camera snapshot + splat range |
| `GET /observations` | recent observations (metadata) and total |
| `GET /observations/{id}/image.jpg` | the stored JPEG |
| `GET /gallery` | contact-sheet gallery of stored observations (also linked from the HUD), with New Session / Clear Observations |
| `POST /talk/verify` | `{observation_id, goal}` → Gemini: is the goal visible in that stored JPEG? |
| `POST /talk` | `{question, memories[]}` → Gemini answer grounded only in those memories |
| `POST /observations/{id}/enrich` | run the Gemini description pipeline on one observation |
| `POST /observations/{id}/detect` | Gemini object list (name, description, normalised bbox) for one stored JPEG |
| `POST /objects/ingest` / `GET /objects?scene_id=&q=` | object-level memory (`objects` collection), linked to place nodes and source observations |
| `POST /talk/choose` | Gemini picks a frontier from recent frames (Jun's CHOOSE prompt) |
| `POST /cognitive-map/rebuild` | rebuild a scene's graph with the active policy; reports how one observation was placed |
| `GET /cognitive-map` | latest cognitive graph (no vectors) + policy + harness status, drawn in the Cognitive Map panel; click a node to inspect that place's photos and descriptions |
| `POST /sessions` | start a new capture session (observations kept) |
| `DELETE /observations?expected=N[&scene_id=…]` | **local dev only** (loopback client + localhost Host; disable with `ALLOW_DEV_DELETE=0`): delete observations of one scene or all; `expected` must match the confirmed count |

**Frontend** — http://localhost:5000

```bash
cd body
npm install
npm run dev
```

Scene data is read from `C:/Flavia/Data/seekr-world-habitat-gs-validation`
(override with `SEEKR_HABITAT_DATA_DIR`). Scenes: InteriorGS 0637/841444
(default), 0651/841463, 0695/841526, 0759/839979.

MongoDB credentials live only in `brain/.env` (gitignored). The browser shows
Brain/MongoDB status by calling `/health` and `/db/health`; it never sees the
connection string.

**Gemini perception** (runs on its own, separate from the server):

```bash
cd brain
.venv/Scripts/python perception.py --id <observation_id>   # or no --id: oldest un-enriched
```

**Recursive harness** (Policy vN → evaluate → optimise → Policy vN+1 → evaluate):

```bash
cd brain
.venv/Scripts/python harness.py --reset   # start from Policy v1
.venv/Scripts/python harness.py           # each run may adopt the next version
```

Policy selection uses **revisit-pair F1** on the selection split (it
penalises false merges); the frozen held-out split is evaluated once per run
and reported, never used to choose. The first run used balanced accuracy,
which rewarded over-merging (v2); that record is kept in `harness_runs`.
`--objective balanced_accuracy` reproduces it; `--from-version N` picks the
baseline policy.

The policy uses only Gemini image/text embeddings and the splat range.
Simulator pose is used only for display and to derive approximate evaluation
labels (same viewpoint: ≤ 1.5 m and ≤ 45°; different: ≥ 3 m).

## Talk to the NavEvolve Agent

Type in the **Talk** tab (or press Enter). The agent answers as "NavEvolve Agent". Supported:

| You say | Seekr does |
|---|---|
| `Seekr, what places do you remember?` | lists the cognitive map's places with their descriptions |
| `Have you seen a dining table?` | searches stored Gemini descriptions; reports when/where, or "no memory" |
| `Explore this area` / `Explore a large area` / `Explore and tell me what you discover` | autonomous, narrated exploration: looks around, enriches the view, says whether it recognizes the place, picks a frontier with Gemini and explains why, walks, repeats within a bounded budget (local 3 steps / large 8), then summarizes real counts and coverage |
| `Find the teapot` / `Find the dining table` | searches object memory, then remembered descriptions; walks there and verifies with Gemini; if nothing is known or verification fails, **explores unseen frontiers autonomously** (bounded: 6 steps / 4 min), detecting and remembering objects as it goes; reports "Object verified" or "Not found" |
| `Take me to the place where you saw the dining table.` / `Go stand next to the big table` / `Go to the table` | walks (A* over the NavMesh) to the real observation pose, faces the remembered view, captures and asks Gemini to verify |
| `What do you see here?` | captures a view and reads back Gemini's description |
| `Stop.` | halts the walk immediately; WASD is restored |
| anything else | Gemini classifies the intent (`POST /talk/intent`); if it is none of the above, Gemini answers grounded only in matching memories |

## Replay Demo (presentation)

Click **▶ Replay Demo** in the HUD. It is a labelled guided replay of a real
saved route: "Find the bathroom." → cached ElevenLabs narration → the avatar
walks on the NavMesh to the remembered bathroom viewpoint → the saved
observation and its recorded Gemini verification are shown. **■ Stop Replay**
(or WASD / typing "stop") halts it; the button then reads **↻ Replay Again**.
Assets are built once with `cd brain && .venv/Scripts/python scripts/build_replay.py`
(needs `ELEVENLABS_API_KEY` in `brain/.env`); playback needs no backend.

## Controls

WASD move (Shift run) · mouse / arrows look · V first/third person ·
C capture view (also automatic every 2 m) · N NavMesh wireframe · P report pose
