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
| `body/src/navPath.js` (NavMesh grid + A*) and `body/src/agentControl.js` (goto / turn / face / capture / halt driven through `player.setExternalMove`) | Teammate **Jun Jiang**, flaspa/NavEvolve PR #1 branch, commit `5a8b689` (hackathon day) | Copied verbatim with an attribution header; PR #1 itself was not merged. Its WebSocket agent loop (`agent_ws.py`, `body.py`, `agent.py`, `agentLink.js`) was not adopted: Milestone 6 drives navigation from the browser instead |
| Gemini object-detection prompt (`LIST`) and the object-merge rule (same name within 1 m, averaged position, sightings count) in `brain/objects.py`; frontier exploration (`frontiers()`, `capture()` visited-marking) already in `agentControl.js` | Teammate **Jun Jiang**, flaspa/NavEvolve PR #1 (`brain/models.py`, `brain/memory.py`, `body/src/agentControl.js`, commit `5a8b689`) | Prompt copied verbatim; run through our google-genai client, not the Woven proxy. The WebSocket agent loop (`agent.py`, `agent_ws.py`, `body.py`, `agentLink.js`, `agentPanel.js`) was not adopted: exploration runs in the browser (`talk.js`) |
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

Milestone 3 — Gemini perception:
- `brain/perception.py`: for one stored observation, a Gemini 3.8 Flash
  structured description (visible evidence only), then separate 768-d image
  and text embeddings from Gemini Embedding 2. Results are written onto the
  same observation with model ids, status, token usage and per-stage
  `time.perf_counter()` latency. Idempotent, and leaves the JPEG, pose, camera
  and range fields untouched.
- `brain/db.py`: the gallery list omits the embedding vectors.

Milestone 4 — cognitive map and self-improving harness:
- `brain/memory.py`: chronological place association using a weighted
  visual/semantic/range policy. It stores place nodes (observation ids,
  representative embeddings, description, range signature, display position)
  and traversal edges in `cognitive_graphs`. It also derives pose-based
  reference pairs (evaluation only) and computes the balanced-accuracy
  evaluation.
- `brain/harness.py`: replays observations, then searches candidates (a coarse
  grid plus local refinement) on the selection pairs, reporting the frozen
  held-out pairs separately. A candidate is adopted only on a strict
  improvement, and versions, runs and status are persisted.
- `brain/server.py`: `GET /cognitive-map`. `body/src/cognitiveMap.js` draws
  the places and edges, and shows policy, score, place count and harness
  status in the panel footer.

Milestone 4 refinement:
- `brain/memory.py`: `evaluate()` reports revisit-pair precision, recall and
  F1 alongside balanced accuracy.
- `brain/harness.py`: F1 is the policy-selection objective (balanced accuracy
  kept as an option for the historical v2 run); held-out is evaluated once and
  the result says explicitly when no held-out improvement is demonstrated.
- `body/src/cognitiveMap.js`: the footer names the active policy, the metric
  and the baseline version it is compared against.

Milestone 5 — Place Memory Inspector:
- `body/src/cognitiveMap.js`: nodes are hoverable and clickable; clicking opens
  an inspector beside the sidebar that browses the place's observations
  (photo from `GET /observations/{id}/image.jpg`, metadata and Gemini
  description from `GET /observations/{id}`), with Prev/Next and Close.
  Clicks on the inspector never reach the scene or pointer lock.
- `body/src/main.js`: the Cognitive Map poll is always scene-filtered and
  refreshes when a scene activates.

Milestone 6 — Talk to Seekr + memory-grounded navigation:
- `body/src/talk.js`: typed instructions routed by explicit rules; answers are
  grounded in stored observations (Gemini descriptions) and the cognitive
  map. "Take me to X" searches descriptions, walks to the REAL observation
  pose with the teammate's A* agent, faces the remembered heading, captures a
  new view and asks Gemini to verify. "Stop" halts and restores WASD.
- `body/src/ui.js`, `main.js`: Talk tab input, agent wiring, Enter hotkey.
- `brain/talk.py`, `server.py`: `POST /talk/verify`, `POST /talk`,
  `POST /observations/{id}/enrich` (reuses the Milestone 3 pipeline).

Conversational interface correction:
- User-facing name is "NavEvolve Agent" (Talk tab, replies, Gemini persona);
  project files and identifiers unchanged.
- `talk.js`: navigation parsing by verb + filler stripping ("go stand next to
  the big table" → "big table"), head-noun fallback that says when only a
  looser memory matched, Gemini structured intent (`POST /talk/intent`) for
  unfamiliar phrasing, and backend errors reported by endpoint instead of
  "Not Found".

Final integration — autonomous exploration + object memory:
- `brain/objects.py`, `server.py`: `POST /observations/{id}/detect` (teammate's
  Gemini LIST prompt, cached on the observation), `POST /objects/ingest`,
  `GET /objects`. The `objects` collection stores normalised name, description,
  approximate 3D position + confidence + `location_method`
  (`splat-bbox-raycast` or `image-center-approx`), sightings, supporting
  `obs_ids`, `place_id` (resolved from the latest cognitive graph when the
  source observation belongs to a place) and an `embedding_ref` to the source
  observation's existing 768-d vectors. No new embeddings are generated.
- `body/src/egoRange.js`: `measureBboxRange()` casts through the bounding-box
  centre against the splat; `approximateBboxPoint()` is the flagged fallback.
- `body/src/talk.js`: "find X" → remembered objects → remembered descriptions
  → autonomous frontier exploration (teammate's `frontiers()`), capturing,
  detecting and remembering objects at each step; success only on Gemini
  verification; bounded budget; Stop cancels exploration and motion.
- `body/src/agentControl.js`: frames now carry the exact `cameraSnapshot`
  (one added line) so bounding boxes can be grounded.
- `config/appConfig.js`: `?brain=` URL override for testing against a
  temporary backend.

Priority 1 — autonomous exploration + narrated decisions (branch `feature/explore-narrated`):
- Reused from teammate **Jun Jiang** (origin/explore-local, commit `4f50823`):
  latest `agentControl.js` (smooth visible turning, frontiers, capture) and
  `navPath.js` verbatim; the minimap planned-path/marker overlay
  (`setPath`/`setMarkers`); the frontier-selection prompt `CHOOSE`
  (`brain/talk.py`, verbatim, run through our Gemini client); and the loop
  shape of her `agent.py` (observe → recall → frontiers → choose → explain →
  walk → observe), ported to the browser in `body/src/talk.js`
  (`runExploration`). Her thought-stream idea (`agentPanel.js`) became
  `narrate()` in the Talk tab with `ui.addMessageWithFrame` thumbnails. Her
  WebSocket stack, local MongoDB and Woven proxy were not adopted.
- New: exploration modes (local / large / find) with step, time and Gemini
  budgets; `POST /cognitive-map/rebuild` folds newly enriched observations into
  the graph with the ACTIVE policy (new graph document, history kept, policy
  unchanged); generation-guarded Stop (`taskGen`) so no pending Gemini reply
  can restart movement; path overlay cleared on stop/finish.

Priority 2 — object-level semantic memory (branch `feature/object-memory`):
- Reused from teammate **Jun Jiang** (origin/explore-local `agent_memory.py`):
  the approximate bearing+range object position (`approx_position`, flagged
  `image-center-approx`) used only when no splat raycast is available, and the
  name+1 m merge rule as the starting point. Woven proxy / local MongoDB not used.
- New in `brain/objects.py`: one 768-d Gemini Embedding 2 text vector per NEW
  object memory ("name: description"; same configured space as perception
  text embeddings; cached, never regenerated), per-sighting evidence
  (`sightings[]`: observation id, bbox, position, method, confidence, time),
  idempotent ingest (`objects_status` on the observation; reprocessing adds no
  sightings), merge requiring same name AND (position within 1 m, or same
  place AND description cosine ≥ 0.9), place links derived live from the
  ACTIVE graph via stable observation ids (`place_links`, `relink` after every
  rebuild), in-process cosine retrieval (`semantic_search`; not Atlas Vector
  Search), `objects_in_place`, `find_places`, bounded `backfill`.
- Talk: object-memory-first answers with place and evidence counts; place
  contents; places-with queries; explore offer when nothing is remembered.
  The inspector lists the selected place's objects. Observation image/text
  embeddings, ranges, place spatial signatures and the harness are untouched.

Priority 3 — spatial fusion + interactive object map (branch `feature/spatial-fusion`):
- Reused from teammate **Jun Jiang**: the minimap marker/path overlay
  (`setMarkers`/`setPath`, origin/explore-local `minimap.js`), extended with
  grounded vs approximate styling, uncertainty rings, destination highlight,
  hover tooltips and click selection. Existing splat raycasting
  (`measureCenterRange`, `measureBboxRange`, `approximateBboxPoint`) is unchanged.
- New in `brain/objects.py`: `fuse_position()` — confidence-weighted fusion of
  per-sighting positions (sigma 0.35 m grounded, 1.5 m approximate), seeded by
  the best-grounded sighting; sightings farther than 1 m from it are kept as
  evidence but excluded as inconsistent. Stores `position_uncertainty_m`,
  `spatial_confidence`, `fused_views`, `rejected_views`, `grounded_views`;
  sightings now also keep `range_m` and `camera_pose`. `refuse` recomputes
  from stored sightings. `GET /objects/markers` serves positioned objects only.
- UI: markers → Place Memory Inspector object view (sightings, method,
  uncertainty, place, supporting thumbnails, navigate-to-viewpoint); selecting
  a place highlights its objects on the minimap; Talk answers "where is X" with
  uncertainty wording, "what objects are near X", and highlights the marker.

Replay Demo (presentation):
- `body/src/replay.js`, HUD buttons in `ui.js`, `brain/scripts/build_replay.py`,
  `body/public/replay/` (script JSON, saved evidence JPEG, cached MP3s). A
  clearly labelled guided replay of a REAL saved route: the avatar walks with
  the same A*/NavMesh controller from a remembered viewpoint to the remembered
  bathroom viewpoint while cached ElevenLabs narration (voice "Matilda",
  `eleven_turbo_v2_5`) plays. Evidence and the Gemini verification shown were
  recorded once at build time from the saved observation; playback makes no
  Gemini, MongoDB or ElevenLabs calls.

Harness Evolution view (read-only): `body/src/harnessView.js`, Harness tab in
`ui.js`, `GET /harness/history` and `?graph_id=` on `GET /cognitive-map`.
Reuses the existing Cognitive Map rendering; no new frameworks; no writes.
