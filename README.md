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
| **Perception** | ego JPEG + pose + camera + Gaussian-splat centre range → MongoDB `observations` · embeddings next | capture ✅ |
| **Memory** (`brain/db.py`) | persistent graph of places in MongoDB Atlas | connection ✅ · graph next |
| **Harness** | automatic improvement of the place-recognition policy | next milestone |

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

## Controls

WASD move (Shift run) · mouse / arrows look · V first/third person ·
C capture view (also automatic every 2 m) · N NavMesh wireframe · P report pose
