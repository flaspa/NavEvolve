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
| **Perception** | captured views → descriptions / embeddings | next milestone |
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
N NavMesh wireframe · P report pose
