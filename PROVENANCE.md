# Provenance

NavEvolve is built for the Cerebral Valley Harness Engineering & Model
Wrangling Hackathon (2026-10-11). This file separates what existed before the
hackathon from what was built during it.

## Pre-hackathon (imported, not built today)

| What | Source | Notes |
|---|---|---|
| `body/` Seekr Body — Three.js + Spark Gaussian Splat viewer, camera controls, scene loading, NavMesh-constrained locomotion, first/third-person player, minimap, HUD/UI, ego-frame capture | [flaspa/seekr-worlds](https://github.com/flaspa/seekr-worlds) @ `91e27ad` (2026-09-25), by Flavia Sparacino | Imported verbatim with `git archive`. Commit `6831151`, tag **`pre-hackathon-baseline`** |
| `brain/app.py`, `liquid.py`, `navigator.py`, `memories_ai.py`, `discover.py`, `postcard.py`, `smoke_*.py`, `requirements.txt` — legacy Seekr Brain (Liquid LFM2.5-VL-3B perception, Memories.ai, Discover, Postcards) | same commit | Kept unchanged, **not run** by NavEvolve (needs a GPU) |
| `body/public/avatar/Seeker.glb` | same commit | Legacy avatar, no longer referenced |
| `body/public/avatar/human.glb` | Supplied by the project author on hackathon day (pre-existing asset, not created in the hackathon) | Rig and clips: Idle / Walk / Run / Turn / Talk / Dance |
| Habitat-GS validation scenes (splats, NavMeshes, `scene.seekr.json`) | `C:\Flavia\Data\seekr-world-habitat-gs-validation`, derived from `RukawaY/gs_scenes` (val) | Local only, never committed; served by the Vite middleware at `/habitat/…` |

Everything that changed after the baseline: `git diff pre-hackathon-baseline`.

## Hackathon contributions

Milestone 1 — working foundation:
- `.gitignore` (secrets, datasets, caches, build output).
- `body/src/main.js`: avatar URL → `/avatar/human.glb`; fixed a pre-existing
  crash in `refreshLiveVision` (`getEyeQuaternion()` returns an array, so
  `eye.dot` threw every frame).
- `brain/server.py`: minimal FastAPI backend, no GPU, no model — `/health`,
  `/db/health` (real Atlas ping), `/db/roundtrip` (insert → read → delete).
- `brain/db.py`: server-side PyMongo access; credentials only from `brain/.env`.
- `brain/test_server.py`, `brain/requirements-server.txt`, `brain/.env.example`.
- `PROVENANCE.md`, `README.md`.
