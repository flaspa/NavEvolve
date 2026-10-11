# Provenance

NavEvolve is built for the Cerebral Valley Harness Engineering & Model
Wrangling Hackathon (2026-10-11). This file separates what existed before the
hackathon from what was built during it.

## Pre-hackathon (imported, not built today)

| What | Source | Notes |
|---|---|---|
| `body/` Seekr Body — Three.js + Spark Gaussian Splat viewer, camera controls, scene loading, NavMesh-constrained locomotion, first/third-person player, minimap, HUD/UI, ego-frame capture | [flaspa/seekr-worlds](https://github.com/flaspa/seekr-worlds) @ `91e27ad` (2026-09-25), by Flavia Sparacino | Imported verbatim with `git archive`. Commit `6831151`, tag **`pre-hackathon-baseline`** |
| `brain/liquid.py` — Liquid LFM2.5-VL-3B loader (Hugging Face Transformers) | same commit | Kept unchanged as the candidate image-description utility for the Perception milestone. Not imported yet; needs a GPU plus `torch`/`transformers` |
| `body/public/avatar/human.glb` | Supplied by the project author on hackathon day (pre-existing asset, not created in the hackathon) | Rig and clips: Idle / Walk / Run / Turn / Talk / Dance |
| `body/src/egoRange.js`: `cameraFromSnapshot()`, `measurementMetrics()` and the Spark `SplatMesh.raycast()` ranging approach | [flaspa/scavengeai](https://github.com/flaspa/scavengeai) @ `3334d40`: `src/egocentricRange.js`, `src/sceneMeasure.js`, `handleMeasurementClick()` in `src/main.js` | Functions copied verbatim. Only `measureCenterRange()` is new |
| Habitat-GS validation scenes (splats, NavMeshes, `scene.seekr.json`) | `C:\Flavia\Data\seekr-world-habitat-gs-validation`, derived from `RukawaY/gs_scenes` (val) | Local only, never committed; served by the Vite middleware at `/habitat/…` |

Everything that changed after the baseline: `git diff pre-hackathon-baseline`.

### Removed from the baseline during the cleanup (still in Git history)

Memories.ai (`memories.js`, `egoClip.js`, `brain/memories_ai.py`), Discover /
Nimble web search (`discoverTab.js`, `brain/discover.py`), FLUX postcards
(`postcardModal.js`, `brain/postcard.py`), the goal-navigation demo
(`goalNavigation.js`, `brain/navigator.py`), the SEEKR VISION / Perception
panels and HTTP client (`seekrVision.js`, `perceptionTab.js`,
`perceptionClient.js`, `sessionId.js`), the legacy Brain server and smoke
scripts (`brain/app.py`, `brain/smoke_*.py`, `brain/requirements.txt`), the
unused `sceneName.js`, and `Seeker.glb`. The remaining Body modules are the
pre-hackathon code, trimmed only where they referenced removed features.

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

Repository cleanup for judging:
- Scene registry reduced to four scenes (0637/841444 default, 0651/841463,
  0695/841526, 0759/839979).
- UI reduced to viewport, HUD (scene, Brain + MongoDB status, camera toggle),
  minimap and the tabs Controls / Cognitive Map (placeholder) / Log.
- `main.js`: legacy feature wiring removed; new Brain/MongoDB status poller.
- `ui.js`, `style.css`: removed chat input, Discover/Memories/Vision panels
  and their CSS; added the Cognitive Map placeholder tab.

Milestone 2 — egocentric observations in MongoDB:
- `body/src/main.js`: `captureObservation()` saves an ego JPEG (from the
  existing `captureEgo()` / `frameCapture.js`) with scene, timestamp, pose,
  the exact `cameraSnapshot` and a centre Gaussian-splat range. It runs on the
  Capture View button or the C key, and automatically every 2 m of travel. The
  avatar and NavMesh overlay are hidden in captures. HUD shows a capture counter.
- `body/src/egoRange.js`: `measureCenterRange()`, which casts a ray through the
  image centre from the rebuilt capture camera. Visible splat surface only:
  never the NavMesh. Returns `null` distance when there is no hit.
- `brain/server.py`, `brain/db.py`: `POST /observations`, `GET /observations`,
  `GET /observations/{id}`, `GET /observations/{id}/image.jpg`. The
  `observations` collection stores the JPEG as BSON binary.

Observation Gallery:
- `brain/gallery.html` + `GET /gallery`: a contact sheet of stored observations
  with a lightbox. It reads the existing `/observations` endpoints, so storage
  is unchanged.
- `body/src/ui.js`: "Observation Gallery ↗" link in the HUD.

Observation reset controls:
- `capture_sessions` collection and `POST /sessions`. Each new observation is
  tagged with the current `session_id`. The HUD and gallery show session and
  total counts.
- `DELETE /observations`: deletes documents in `observations` only, for one
  scene or all. Local development only, and protected by a confirmed-count check.
