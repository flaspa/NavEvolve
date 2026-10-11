# NavEvolve

A self-improving embodied navigation harness, built on the pre-hackathon
Seekr Body (see `PROVENANCE.md` for what is reused vs. new).

## Run

**Frontend** (Gaussian Splat world, avatar, NavMesh locomotion) — http://localhost:5000

```bash
cd body
npm install
npm run dev
```

Scene data is read from `C:/Flavia/Data/seekr-world-habitat-gs-validation`
(override with `SEEKR_HABITAT_DATA_DIR`). Startup scene: `interior_0516_840045`.

**Backend** (no GPU) — http://localhost:8000

```bash
cd brain
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-server.txt   # Windows
cp .env.example .env    # then set MONGODB_URI and MONGODB_DB
.venv/Scripts/python -m uvicorn server:app --port 8000
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /db/health` | real MongoDB Atlas ping |
| `POST /db/roundtrip` | insert, read back and delete one test document |

Tests: `cd brain && .venv/Scripts/python -m pytest -q`

MongoDB credentials stay in `brain/.env` (gitignored) and are used only by the
Python server; the browser never sees them.

## Controls

WASD move (Shift run) · mouse / arrows look · V first/third person ·
N NavMesh wireframe · P report pose
