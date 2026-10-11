/**
 * main.js — NavEvolve Body entry point.
 *
 * Wires the pre-hackathon Seekr Body modules together: Spark world + NavMesh
 * layer (world.js), avatar + locomotion (avatar.js, player.js), HUD/sidebar
 * (ui.js), minimap, and egocentric capture (frameCapture.js). The Brain is
 * polled only for its health and MongoDB status (brain/server.py).
 *
 * Scenes are Habitat-GS (InteriorGS) validation scenes. Each is described by
 * its own scene.seekr.json (sceneProfile.js): assets, environment transform,
 * visualOffset and defaultStart. They ship NO collision mesh: the NavMesh is
 * the walkability authority, and WASD locomotion is constrained to it
 * (navmeshLocomotion.js through player.js).
 */
import "./style.css";
import * as THREE from "three";

import { scene } from "./scene.js";
import { camera } from "./camera.js";
import { renderer } from "./renderer.js";
import "./floor.js";
import {
  worldReady,
  worldGroup,
  splatMesh,
  colliderMesh,
  navmeshMesh,
  worldCollider as importedWorldCollider,
  startupSession,
  getNavmeshMeshes,
  replaceSplat,
  replaceCollider,
  clearCollider,
  replaceNavmesh,
  clearNavmesh,
  sceneProfileUrl,
  controls as orbitControls,
} from "./world.js";
import { loadAvatar } from "./avatar.js";
import { createPlayer } from "./player.js";
import { createUI } from "./ui.js";
import { APP_CONFIG } from "./config/appConfig.js";
import { SCENES, getSceneById } from "./config/scenes.js";
import { CAMERA_DISTANCE } from "./cameraDistance.js";
import {
  resolveStartPose,
  headingDegToQuaternion,
  quaternionToHeadingDeg,
  formatPoseReport,
  formatDefaultStart,
} from "./agentPose.js";
import {
  SESSION_SAVE_INTERVAL_MS,
  createSessionRecord,
  writeSession,
  sessionPoseFor,
} from "./sessionPersistence.js";
import { createMinimap, MINIMAP_MIN_EXTENT, MINIMAP_MAX_EXTENT } from "./minimap.js";
import { projectNavmeshFootprint } from "./navmeshFootprint.js";
import {
  floorHeightAt,
  validateStartPose,
  START_NAVMESH_SNAP_MAX_DISTANCE,
} from "./navmeshQuery.js";
import { loadSceneProfile } from "./sceneProfile.js";
import { startLoop } from "./loop.js";
import { captureEgoFrame } from "./frameCapture.js";
import { measureCenterRange } from "./egoRange.js";
import { createCognitiveMap } from "./cognitiveMap.js";
import { agentSliderBounds, withAxis } from "./agentPoseAuthoring.js";

console.log("[NavEvolve] Body");

// ---------------------------------------------------------------------------
// Runtime configuration — populates the Controls panel. Scene calibration is
// copied in from the active scene descriptor by applySceneDescriptor().
// ---------------------------------------------------------------------------
const startupScene = getSceneById(APP_CONFIG.defaultSceneId);

if (!startupScene) {
  throw new Error(
    `[main] Unknown APP_CONFIG.defaultSceneId: "${APP_CONFIG.defaultSceneId}"`,
  );
}

/** The active scene descriptor — the runtime's single scene-data source. */
let activeScene = null;

const CONFIG = {
  environment: {
    // Overwritten by applySceneDescriptor() before any transform is applied.
    position: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    scale: 1,
    visualOffset: {
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
    },
  },

  player: {
    // Preferred spawn as [x, z], or null to probe from the scene centre. Used
    // only when a scene has no authored defaultStart.
    spawn: null,
    eyeHeight: 1.6,
    // VISUAL avatar scale — the rendered body only (~1.5 m tall).
    avatarVisualScale: 1.503,
    flySpeed: 5,
    sprintMultiplier: 4,

    thirdPerson: {
      distance: 1.5,
      headHeight: 1.45,
      walkSpeed: 1.5,
      runSpeed: 3.5,
      damping: 12,
    },
  },

  minimap: {
    extent: 8,
  },

  capture: {
    // Egocentric frame encoding (captureEgo).
    quality: 0.7,
    maxWidth: 768,
  },
};

const AVATAR_URL = "/avatar/human.glb";

function applySceneDescriptor(descriptor) {
  const env = CONFIG.environment;
  env.position = [...descriptor.environment.position];
  env.rotationDeg = [...descriptor.environment.rotationDeg];
  env.scale = descriptor.environment.scale;
  env.visualOffset.position = [...descriptor.visualOffset.position];
  env.visualOffset.rotationDeg = [...descriptor.visualOffset.rotationDeg];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
const ui = createUI({ title: "NavEvolve" });

const minimap = createMinimap({
  mount: ui.minimapMount,
  extent: CONFIG.minimap.extent,
});

// ---------------------------------------------------------------------------
// Brain status — brain/server.py liveness and its MongoDB Atlas ping. The
// browser never sees database credentials; it only reads these two endpoints.
// ---------------------------------------------------------------------------
async function fetchJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${APP_CONFIG.brainUrl}${path}`, { signal: controller.signal });
    return { ok: response.ok, body: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

async function pollBrainStatus() {
  let text;
  try {
    await fetchJson("/health");
    const db = await fetchJson("/db/health");
    if (db.ok) {
      // Keeps the counter right after a New Session or Clear in the gallery.
      const obs = await fetchJson("/observations?limit=1");
      if (obs.ok) {
        observationCount = obs.body.all_total ?? obs.body.total;
        sessionCaptures = obs.body.session_total ?? sessionCaptures;
        showCaptureCount();
      }
    }
    text = db.ok
      ? `Brain: online · MongoDB: connected (${db.body.database})`
      : `Brain: online · MongoDB: ${db.body?.detail ?? "unavailable"}`;
  } catch (_) {
    text = `Brain: offline · start brain/server.py (${APP_CONFIG.brainUrl})`;
  }
  ui.setBrainStatus(text);
}

pollBrainStatus();
setInterval(pollBrainStatus, 10_000);

// Cognitive Map panel (hackathon) — read-only view of the graph the harness
// built in MongoDB (GET /cognitive-map), for the active scene.
const cognitiveMap = createCognitiveMap({
  mount: ui.cognitiveMapPanel,
  footer: ui.cognitiveMapFooter,
});

async function pollCognitiveMap() {
  try {
    const scene = activeScene ? `?scene_id=${encodeURIComponent(activeScene.id)}` : "";
    const res = await fetchJson(`/cognitive-map${scene}`);
    if (res.ok) cognitiveMap.update(res.body);
  } catch (_) {
    // Brain offline: keep the last drawing.
  }
}

pollCognitiveMap();
setInterval(pollCognitiveMap, 10_000);

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
let avatar = null;
let player = null;
let roomRect = null;

const cameraWorldPosition = new THREE.Vector3();

function isTyping() {
  const element = document.activeElement;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable;
}

// ---------------------------------------------------------------------------
// Scene transform and layers
// ---------------------------------------------------------------------------
function updateRoomRect() {
  const source = navmeshMesh ?? colliderMesh;
  if (!source) {
    roomRect = null;
    return;
  }

  worldGroup.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(source);
  if (box.isEmpty()) {
    roomRect = null;
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  roomRect = { x: center.x, z: center.z, w: size.x, d: size.z };
}

function applyEnvironmentTransform() {
  const environment = CONFIG.environment;
  const toRadians = THREE.MathUtils.degToRad;

  worldGroup.position.set(...environment.position);
  worldGroup.rotation.set(
    toRadians(environment.rotationDeg[0]),
    toRadians(environment.rotationDeg[1]),
    toRadians(environment.rotationDeg[2]),
  );
  worldGroup.scale.setScalar(environment.scale);
  worldGroup.updateMatrixWorld(true);

  updateRoomRect();
}

/** The splat's local alignment against the navigation frame (OLD semantics). */
function applyVisualOffset() {
  const offset = CONFIG.environment.visualOffset;
  const toRadians = THREE.MathUtils.degToRad;

  splatMesh.position.set(...offset.position);
  splatMesh.rotation.set(
    toRadians(offset.rotationDeg[0]),
    toRadians(offset.rotationDeg[1]),
    toRadians(offset.rotationDeg[2]),
  );
  splatMesh.updateMatrixWorld(true);
}

function setVisualVisible(visible) {
  splatMesh.visible = visible;
  if ("opacity" in splatMesh) splatMesh.opacity = visible ? 1 : 0;
  ui.setControl("layer-visual", visible);
}

/** NavMesh wireframe visibility (N). Visibility only. */
function setNavmeshVisible(visible) {
  if (!navmeshMesh) return;
  navmeshMesh.visible = visible;
  ui.setControl("layer-navmesh", visible);
}

// Obstacle collision (only for a scene that ships a collider; Habitat-GS
// scenes do not). Kept as plumbing; no UI in this build.
let collisionEnabled = true;

// ---------------------------------------------------------------------------
// NavMesh-constrained locomotion (the walkability authority)
// ---------------------------------------------------------------------------
// Starts ON: on an InteriorGS scene the NavMesh is the authority on where
// Seekr may walk, and it is the ONLY thing stopping him walking through the
// world.
let navmeshConstraintEnabled = true;

/**
 * Applies the "Constrain Avatar to NavMesh" setting to the player.
 *
 * The probe reads the CURRENTLY loaded NavMesh (getNavmeshMeshes() changes on
 * scene activation). Elevation following keeps the feet-to-surface offset
 * measured at Seekr's current pose, so an authored defaultStart keeps its
 * exact grounding while ramps/steps in the NavMesh are followed. Call again
 * after any deliberate vertical repositioning (scene start, Y slider, Reset).
 */
function applyNavmeshConstraint() {
  if (!player) return;

  const meshes = getNavmeshMeshes();
  if (!navmeshConstraintEnabled || !meshes.length) {
    player.setNavmeshProbe(null);
    return;
  }

  const { position } = player.getAgentPose();
  const surfaceY = floorHeightAt(meshes, position.x, position.z, { nearY: position.y });
  const footOffset = surfaceY === null ? 0 : position.y - surfaceY;

  player.setNavmeshProbe(
    (x, z, nearY) => floorHeightAt(getNavmeshMeshes(), x, z, { nearY }),
    { followElevation: true, footOffset },
  );
}

function setNavmeshConstraintEnabled(enabled) {
  navmeshConstraintEnabled = enabled;
  applyNavmeshConstraint();
  ui.setControl("player-navmesh-constraint", enabled);
}

// ---------------------------------------------------------------------------
// Spawn (fallback only — used when a scene has no authored defaultStart)
// ---------------------------------------------------------------------------
function findSpawnPoint(probe, box, override = null) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const probeY = box.min.y + size.y * 0.55;
  const maxDrop = size.y * 1.1;

  const originX = override ? override[0] : center.x;
  const originZ = override ? override[1] : center.z;

  const step = Math.min(size.x, size.z) * 0.12;

  const offsets = [[0, 0]];
  for (let ring = 1; ring <= 4; ring++) {
    for (const [dx, dz] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, -1], [1, -1], [-1, 1],
    ]) {
      offsets.push([dx * step * ring, dz * step * ring]);
    }
  }

  // Prefer the LOWEST surface among the candidates (the floor).
  let best = null;
  for (const [dx, dz] of offsets) {
    const x = originX + dx;
    const z = originZ + dz;
    const y = probe.groundY(x, z, probeY, maxDrop);
    if (y == null) continue;
    if (!best || y < best.y - 0.02) best = { x, y, z };
  }
  if (best) return best;

  console.warn("[spawn] No floor found — falling back to bounds minimum.");
  return { x: originX, y: box.min.y, z: originZ };
}

// ---------------------------------------------------------------------------
// Session persistence — remember the last scene and pose across a reload.
// ---------------------------------------------------------------------------
const SESSION_ENABLED = APP_CONFIG.sessionPersistenceEnabled;

/** The record read once at boot; consumed by the first scene activation. */
let pendingSessionRestore = SESSION_ENABLED ? startupSession : null;
let sessionSampleTimer = null;
let lastSavedPoseKey = null;

function sampleSessionPose() {
  if (!SESSION_ENABLED || !player || !activeScene) return;

  const pose = player.getAgentPose();
  const headingDeg = quaternionToHeadingDeg(pose.rotation);
  if (!Number.isFinite(headingDeg)) return;

  const record = createSessionRecord(activeScene.id, pose.position, headingDeg);
  const key = `${record.sceneId}|${JSON.stringify(record.pose)}`;
  if (key === lastSavedPoseKey) return;

  if (writeSession(record)) lastSavedPoseKey = key;
}

function startSessionPoseSampling() {
  if (!SESSION_ENABLED || sessionSampleTimer !== null) return;
  sessionSampleTimer = setInterval(sampleSessionPose, SESSION_SAVE_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Start pose — OLD semantics: a saved session pose for THIS scene, else the
// profile's authored defaultStart (base/feet position + headingDeg), else the
// spawn search. Scene and session poses are validated against the NavMesh
// (nudged onto it within START_NAVMESH_SNAP_MAX_DISTANCE, never relocated).
// ---------------------------------------------------------------------------
function resolveRuntimeStartPose(descriptor, fallback) {
  const restored = sessionPoseFor(pendingSessionRestore, descriptor.id);
  pendingSessionRestore = null;

  if (restored) {
    return {
      position: restored.position,
      headingDeg: restored.headingDeg,
      source: "session",
    };
  }

  return resolveStartPose(descriptor, fallback);
}

/** Poses that must be checked against the NavMesh before being applied. */
const VALIDATED_START_SOURCES = new Set(["scene", "session"]);

function reportStartValidation(validation, startPose) {
  const sceneId = activeScene?.id ?? startupScene.id;
  const configured = startPose.position;

  if (validation.status === "on-navmesh") {
    console.log(`[navmesh] Start pose is navigable for "${sceneId}"`, {
      position: configured,
      distanceToNavmesh: +validation.distance.toFixed(4),
    });
  } else if (validation.status === "snapped") {
    console.log(
      `[navmesh] Start pose nudged onto the NavMesh for "${sceneId}" ` +
        `(${validation.distance.toFixed(4)} m). Heading unchanged; ` +
        `scene.seekr.json is untouched.`,
      { configuredPosition: configured, runtimePosition: validation.position },
    );
  } else if (validation.status === "too-far") {
    console.warn(
      `[navmesh] Start pose for "${sceneId}" is ` +
        `${validation.distance.toFixed(3)} m from the nearest navigable point, ` +
        `beyond the ${START_NAVMESH_SNAP_MAX_DISTANCE} m startup correction ` +
        `limit. Using the authored pose unchanged — fix defaultStart in ` +
        `scene.seekr.json deliberately.`,
      {
        sceneId,
        configuredPosition: configured,
        nearestNavigablePoint: validation.nearest ? validation.nearest.point.toArray() : null,
        distance: +validation.distance.toFixed(4),
      },
    );
  } else if (validation.status === "no-navmesh") {
    console.log(`[navmesh] No NavMesh for "${sceneId}" — start pose unchecked.`);
  }

  if (startPose.source === "session") {
    console.log(
      `[session] Resumed the last pose for "${sceneId}". The scene profile is ` +
        `untouched; Reset to Scene Start still returns to its authored defaultStart.`,
    );
  }
}

/** Computes the start pose for a scene from the CURRENTLY loaded geometry. */
function computeStartPose(descriptor) {
  const meshes = getNavmeshMeshes();
  const groundSource = navmeshMesh ?? colliderMesh;
  const box = groundSource ? new THREE.Box3().setFromObject(groundSource) : null;

  const probe = meshes.length
    ? { groundY: (x, z) => floorHeightAt(meshes, x, z) }
    : importedWorldCollider;

  const current = player ? player.getAgentPose().position : { x: 0, y: 0, z: 0 };
  const legacy =
    probe && box && !box.isEmpty()
      ? findSpawnPoint(probe, box, CONFIG.player.spawn)
      : { x: current.x, y: current.y, z: current.z };

  const startPose = resolveRuntimeStartPose(descriptor, {
    position: [legacy.x, legacy.y, legacy.z],
  });

  if (meshes.length) {
    // NavMesh scenes: the OLD conservative check — a small Y/XZ discrepancy is
    // corrected at runtime, a clearly off-mesh start is reported and kept.
    const validation = VALIDATED_START_SOURCES.has(startPose.source)
      ? validateStartPose(meshes, startPose.position)
      : { status: "skipped", position: startPose.position, distance: null, nearest: null };
    reportStartValidation(validation, startPose);
    startPose.position = [...validation.position];
    return startPose;
  }

  // Collider-only scenes (none in the current registry): settle the feet on
  // the collider floor for session/fallback sources.
  if (importedWorldCollider && box && !box.isEmpty() && startPose.source !== "scene") {
    const [x, y, z] = startPose.position;
    const size = box.getSize(new THREE.Vector3());
    const floorY = importedWorldCollider.groundY(x, z, box.max.y + 0.5, size.y + 1);
    if (floorY !== null && Math.abs(floorY - y) > 0.05) {
      startPose.position = [x, floorY, z];
    }
  }

  return startPose;
}

/** Places Seekr for a newly activated scene. Never reuses the previous pose. */
function applySceneStartPose(descriptor) {
  if (!player) return;

  const startPose = computeStartPose(descriptor);
  const [x, y, z] = startPose.position;

  console.log(`[spawn] Start pose (${startPose.source}):`, {
    x: +x.toFixed(2),
    y: +y.toFixed(2),
    z: +z.toFixed(2),
    headingDeg: startPose.headingDeg,
  });

  const pose = { position: { x, y, z } };
  if (startPose.headingDeg !== null) {
    pose.rotation = headingDegToQuaternion(startPose.headingDeg);
  }
  player.setAgentPose(pose);
}

// ---------------------------------------------------------------------------
// Minimap (Top View) — centred on Seekr, NavMesh footprint as the backdrop
// ---------------------------------------------------------------------------
function resetMinimapToSeekr() {
  if (!player) return;
  const { position } = player.getAgentPose();
  minimap.reset({ x: position.x, z: position.z });
}

/**
 * Hands the minimap the walkable footprint of the ALREADY-LOADED NavMesh.
 * Diagnostic visualization only. A scene with no NavMesh clears the layer.
 */
function refreshMinimapNavmesh({ fit = false } = {}) {
  const footprint = projectNavmeshFootprint(getNavmeshMeshes());
  const fitted = minimap.setNavmesh(footprint, { fit });

  if (fit && Number.isFinite(fitted) && fitted !== CONFIG.minimap.extent) {
    CONFIG.minimap.extent = fitted;
    ui.setControl("minimap-extent", fitted);
  }
}

// ---------------------------------------------------------------------------
// Per-scene calibration — the scene's own scene.seekr.json is the ONE source:
//   visualOffset, environment  applied on load (OLD semantics)
//   defaultStart               { position: [x, y, z], headingDeg } — feet
//                              position in the scene frame + heading in
//                              degrees (0 = +Z, 90 = +X); written by
//                              "Set Current Pose as Scene Start"
//   avatarScale                optional visual avatar scale (added by this
//                              build; absent means the default)
// Saved back through the vite middleware (PUT), so the authored file is the
// persisted state. No second per-scene config format.
// ---------------------------------------------------------------------------
const DEFAULT_AVATAR_SCALE = 1.503;
const AVATAR_SCALE_RANGE = Object.freeze({ min: 0.5, max: 2.0, step: 0.01 });

/** Eye and third-person head heights at DEFAULT_AVATAR_SCALE, in metres. */
const BASE_EYE_HEIGHT = 1.6;
const BASE_HEAD_HEIGHT = 1.45;

function profileAvatarScale(descriptor) {
  const value = descriptor?.rawProfile?.avatarScale;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_AVATAR_SCALE;
}

/**
 * Applies the visual avatar scale immediately, together with the eye height
 * (first-person camera AND the egocentric perception camera) and the
 * third-person head pivot, which scale in proportion so Seekr's actual eye
 * stays on the rendered head. Collision, locomotion and the avatar root
 * origin are untouched.
 */
function applyAvatarScale(value) {
  if (!Number.isFinite(value) || value <= 0) return;
  const ratio = value / DEFAULT_AVATAR_SCALE;

  CONFIG.player.avatarVisualScale = value;
  CONFIG.player.eyeHeight = BASE_EYE_HEIGHT * ratio;
  CONFIG.player.thirdPerson.headHeight = BASE_HEAD_HEIGHT * ratio;

  avatar?.object.scale.setScalar(value);
  player?.setTuning({
    eyeHeight: CONFIG.player.eyeHeight,
    headHeight: CONFIG.player.thirdPerson.headHeight,
  });
  ui.setControl("agent-scale", value);
}

/** Writes the active scene's profile back with a new defaultStart/avatarScale. */
async function saveActiveProfile({ defaultStart, avatarScale }) {
  if (!activeScene?.rawProfile || !activeScene.profileUrl) {
    throw new Error("This scene has no editable scene.seekr.json.");
  }

  const next = JSON.parse(JSON.stringify(activeScene.rawProfile));
  next.defaultStart = defaultStart;
  if (Number.isFinite(avatarScale)) next.avatarScale = avatarScale;

  const response = await fetch(activeScene.profileUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} writing ${activeScene.profileUrl}`);
  }

  // Immediately the active scene start, without a reload.
  activeScene.rawProfile = next;
  activeScene.defaultStart = {
    position: [...defaultStart.position],
    headingDeg: defaultStart.headingDeg,
  };
}

// ---------------------------------------------------------------------------
// AGENT POSE authoring controls (Controls ▸ AGENT POSE)
// ---------------------------------------------------------------------------
function computeAgentBounds(fallbackAround) {
  let box = null;
  const source = navmeshMesh ?? colliderMesh;
  if (source) {
    const b = new THREE.Box3().setFromObject(source);
    if (!b.isEmpty()) box = b;
  }
  if (!box && splatMesh) {
    try {
      const b = splatMesh.getBoundingBox();
      if (b && !b.isEmpty()) box = b;
    } catch (_) {
      // Splat bounds may not be available yet; the fallback covers it.
    }
  }
  return agentSliderBounds(box, { around: fallbackAround });
}

/**
 * Applies a single position axis from the AGENT POSE sliders. Position-only.
 * A Y edit re-measures the feet-to-NavMesh offset so it sticks while walking.
 */
function setAgentAxis(axis, value) {
  if (!player) return;
  const pose = player.getAgentPose();
  player.setAgentPose({ position: withAxis(pose.position, axis, value) });
  if (axis === "y") applyNavmeshConstraint();
  syncAgentPosePanel();
}

/** Records Seekr's current pose as the scene start and persists it. */
async function setSceneStartFromCurrentPose() {
  if (!player || !activeScene) return;

  const pose = player.getAgentPose();
  const headingDeg = quaternionToHeadingDeg(pose.rotation);
  const defaultStart = {
    position: [
      +pose.position.x.toFixed(6),
      +pose.position.y.toFixed(6),
      +pose.position.z.toFixed(6),
    ],
    headingDeg: +headingDeg.toFixed(1),
  };
  const avatarScale = +CONFIG.player.avatarVisualScale.toFixed(3);

  try {
    await saveActiveProfile({ defaultStart, avatarScale });
    ui.addMessage(
      "System",
      `Scene start saved for ${activeScene.displayName}. ` +
        `${formatPoseReport(pose.position, headingDeg)} · Scale ${avatarScale}`,
    );
    ui.setStatus("Scene start saved · scene.seekr.json written");
  } catch (err) {
    console.error("[scene-profile] Save failed:", err);
    ui.addMessage("System", `Could not save scene start — ${err.message}`);
    ui.setStatus("Scene start NOT saved · see console");
  }
}

/** Teleports Seekr back to the scene's authored defaultStart. */
function resetToSceneStart() {
  if (!player || !activeScene) return;

  const start = activeScene.defaultStart;
  if (!start) {
    ui.addMessage("System", "No scene start defined for this scene yet.");
    ui.setStatus("Reset to Scene Start: no scene start defined");
    return;
  }

  const [x, y, z] = start.position;
  player.setAgentPose({
    position: { x, y, z },
    rotation: headingDegToQuaternion(start.headingDeg),
  });

  // AFTER the pose is applied: a teleport, not a walk, so break the trail.
  applyNavmeshConstraint();
  resetMinimapToSeekr();
  syncAgentPosePanel();

  ui.addMessage(
    "System",
    `Reset to scene start · [${start.position.join(", ")}] @ ${start.headingDeg}°`,
  );
}

/** Mirrors Seekr's live pose into the AGENT POSE sliders. Read-only. */
function syncAgentPosePanel() {
  if (!player) return;

  const pose = player.getAgentPose();

  for (const axis of ["x", "y", "z"]) {
    const id = `agent-${axis}`;
    if (ui.isControlActive(id)) continue;
    ui.setControl(id, pose.position[axis]);
  }

  if (ui.isControlActive("agent-heading")) return;

  const headingDeg = quaternionToHeadingDeg(pose.rotation);
  if (Number.isFinite(headingDeg)) ui.setControl("agent-heading", headingDeg);
}

// ---------------------------------------------------------------------------
// Egocentric capture — the observation source for upcoming perception
// ---------------------------------------------------------------------------
function getCaptureEgoView() {
  if (!avatar) return null;

  const position = avatar.object.position;
  // eyeHeight so the perception camera sits where the first-person camera is.
  const eyeY = position.y + CONFIG.player.eyeHeight;
  const heading = avatar.object.rotation.y - (avatar.facingOffset ?? 0);
  const quaternion = player ? player.getEyeQuaternion() : null;

  return {
    position: [position.x, eyeY, position.z],
    heading,
    quaternion,
    // Observations show only the world: no avatar body, no NavMesh overlay.
    hide: [avatar.object, ...getNavmeshMeshes()],
  };
}

/** The most recent ego frame, in the exact form a Brain would receive. */
let lastEgoFrame = null;

function captureEgo() {
  if (!player || !avatar || !activeScene) return null;

  const egoView = getCaptureEgoView();
  const { dataUrl, width, height, cameraSnapshot } = captureEgoFrame(renderer, scene, camera, egoView, {
    quality: CONFIG.capture.quality,
    maxWidth: CONFIG.capture.maxWidth,
  });

  const pose = player.getAgentPose();
  lastEgoFrame = {
    dataUrl,
    width,
    height,
    sceneId: activeScene.id,
    sceneName: activeScene.displayName,
    timestamp: Date.now(),
    observedFrom: {
      x: +pose.position.x.toFixed(3),
      y: +pose.position.y.toFixed(3),
      z: +pose.position.z.toFixed(3),
      headingDeg: +quaternionToHeadingDeg(pose.rotation).toFixed(1),
      pitchDeg: +(player.getEyePitch?.() ?? 0).toFixed(1),
    },
    cameraSnapshot,
  };

  return lastEgoFrame;
}

// ---------------------------------------------------------------------------
// Observations (hackathon) — ego JPEG + pose + exact camera + centre range,
// stored in MongoDB through brain/server.py. Captured manually (Capture View)
// and automatically every AUTO_CAPTURE_EVERY_M metres of avatar travel.
// ---------------------------------------------------------------------------
const AUTO_CAPTURE_EVERY_M = 2;
let observationCount = 0;
let sessionCaptures = 0;
let travelledSinceCapture = 0;
const lastTravelPos = new THREE.Vector3(NaN, NaN, NaN);

function showCaptureCount(note = "") {
  ui.setCaptureStatus(
    `Observations: ${sessionCaptures} this session · ${observationCount} in MongoDB${note ? ` · ${note}` : ""}`,
  );
}

async function captureObservation(trigger = "manual") {
  const frame = captureEgo();
  if (!frame) return null;
  travelledSinceCapture = 0;

  const range = measureCenterRange({
    splatMesh,
    cameraSnapshot: frame.cameraSnapshot,
    metersPerUnit: activeScene.geometry?.metersPerUnit ?? 1,
    environmentScale: CONFIG.environment.scale,
  });

  try {
    const response = await fetch(`${APP_CONFIG.brainUrl}/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_data_url: frame.dataUrl,
        scene_id: frame.sceneId,
        timestamp: frame.timestamp,
        trigger,
        pose: frame.observedFrom,
        camera_snapshot: frame.cameraSnapshot,
        image_width: frame.width,
        image_height: frame.height,
        range,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.detail ?? `HTTP ${response.status}`);
    sessionCaptures = body.session_total ?? sessionCaptures + 1;
    observationCount = body.total;
    const dist = range.distanceM === null ? "no surface" : `${range.distanceM.toFixed(2)} m ahead`;
    showCaptureCount(dist);
    console.log(`[observation] ${trigger} stored ${body.id} · range ${dist}`);
    return { id: body.id, range };
  } catch (err) {
    console.error("[observation] store failed:", err);
    showCaptureCount(`store failed — ${err.message}`);
    return null;
  }
}

function trackTravelForAutoCapture() {
  if (!avatar || !activeScene) return;
  const p = avatar.object.position;
  if (Number.isFinite(lastTravelPos.x)) {
    travelledSinceCapture += Math.hypot(p.x - lastTravelPos.x, p.z - lastTravelPos.z);
  }
  lastTravelPos.copy(p);
  if (travelledSinceCapture >= AUTO_CAPTURE_EVERY_M) captureObservation("auto-distance");
}

// ---------------------------------------------------------------------------
// Scene activation and switching
// ---------------------------------------------------------------------------
/**
 * Makes a scene descriptor the active scene: calibration, name, avatar scale,
 * start pose, NavMesh constraint, minimap and controls are all replaced.
 */
function activateScene(descriptor) {
  activeScene = descriptor;

  applySceneDescriptor(descriptor); // environment + visualOffset -> CONFIG
  applyEnvironmentTransform();
  applyVisualOffset();
  ui.setSceneName(descriptor.displayName ?? descriptor.id);

  applyAvatarScale(profileAvatarScale(descriptor));

  buildControlPanel();

  applySceneStartPose(descriptor);
  // The probe reads the newly loaded NavMesh; the foot offset is measured at
  // the start pose just applied.
  applyNavmeshConstraint();
  // After placement: centre on where Seekr ended up, then fit the walkable
  // area around that centre.
  resetMinimapToSeekr();
  refreshMinimapNavmesh({ fit: true });
  syncAgentPosePanel();

  lastSavedPoseKey = null;
  startSessionPoseSampling();
}

let selectedSceneId = null;
let worldAssetBusy = false;

function currentSceneSelection() {
  if (selectedSceneId && getSceneById(selectedSceneId)) return selectedSceneId;
  return activeScene?.id ?? APP_CONFIG.defaultSceneId;
}

/**
 * Switches to a registered scene without reloading the page:
 * loadSceneProfile → replaceSplat / replaceNavmesh / replaceCollider →
 * activateScene. Chat and Memories are untouched. A failed load leaves the
 * previous scene in place.
 */
async function loadSceneById(sceneId) {
  if (worldAssetBusy) return false;

  const next = getSceneById(sceneId);
  if (!next) {
    ui.addMessage("System", `Unknown scene "${sceneId}".`);
    return false;
  }

  worldAssetBusy = true;
  ui.setControlDisabled("load-selected-scene", true);
  ui.setStatus(`Loading ${next.displayName}…`);

  try {
    const profileUrl = sceneProfileUrl(next);
    console.log(`[scene] Fetching scene profile "${sceneId}" from ${profileUrl}`);
    const descriptor = await loadSceneProfile(profileUrl, fetch);

    console.log(`[scene] Splat: ${descriptor.assets.splat ?? "—"}`);
    console.log(`[scene] Seekr NavMesh GLB: ${descriptor.assets.seekrNavmesh ?? "—"}`);

    await replaceSplat(descriptor.assets.splat);

    if (descriptor.assets.seekrNavmesh) {
      await replaceNavmesh(descriptor.assets.seekrNavmesh);
    } else {
      clearNavmesh();
    }

    if (descriptor.assets.collider) {
      const { collider } = await replaceCollider(descriptor.assets.collider);
      player?.setCollider(collisionEnabled ? collider : null);
    } else {
      clearCollider();
      player?.setCollider(null);
    }

    // Only now does the new scene become active — a failure above leaves the
    // previous scene untouched.
    selectedSceneId = descriptor.id;
    activateScene(descriptor);

    ui.addMessage("System", `Scene loaded · ${descriptor.displayName}`);
    ui.setStatus(explorerReadyStatus());
    return true;
  } catch (err) {
    console.error(`[scene] Failed to load "${sceneId}":`, err);
    ui.addMessage("System", `Scene not loaded — ${err.message}`);
    ui.setStatus("Scene load failed · previous scene kept");
    return false;
  } finally {
    worldAssetBusy = false;
    ui.setControlDisabled("load-selected-scene", false);
  }
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------
function setViewMode(mode) {
  if (!player) return;
  const selectedMode = player.setMode(mode);
  ui.setViewMode(selectedMode);
  ui.setStatus(explorerReadyStatus());
}

function explorerReadyStatus() {
  return player?.mode === "third"
    ? "Explorer ready · Third-person"
    : "Explorer ready · First-person";
}

// ---------------------------------------------------------------------------
// Controls panel
// ---------------------------------------------------------------------------
function buildControlPanel() {
  const agentStart = player ? player.getAgentPose().position : { x: 0, y: 0, z: 0 };
  const agentBounds = computeAgentBounds(agentStart);
  const agentHeading = player ? quaternionToHeadingDeg(player.getAgentPose().rotation) : 0;

  ui.buildControls([
    { type: "section", label: "SCENE" },

    {
      type: "readout",
      id: "scene-id",
      label: "Current",
      value: activeScene?.displayName ?? "—",
    },

    {
      type: "select",
      id: "scene-select",
      label: "Scene",
      options: SCENES.map((s) => ({ value: s.id, label: s.displayName })),
      value: currentSceneSelection(),
      onChange: (value) => {
        selectedSceneId = value;
      },
    },

    {
      type: "button",
      id: "load-selected-scene",
      label: "Load Selected Scene",
      onClick: () => loadSceneById(currentSceneSelection()),
    },

    { type: "section", label: "OBSERVATIONS" },

    {
      type: "button",
      id: "capture-view",
      label: "Capture View (C)",
      onClick: () => captureObservation("manual"),
    },

    { type: "section", label: "LAYERS" },

    {
      type: "checkbox",
      id: "layer-visual",
      label: "Gaussian Splat",
      value: splatMesh ? splatMesh.visible : true,
      onChange: setVisualVisible,
    },

    {
      type: "checkbox",
      id: "layer-navmesh",
      label: "NavMesh (N)",
      value: navmeshMesh ? navmeshMesh.visible : false,
      onChange: setNavmeshVisible,
    },

    { type: "section", label: "MOVEMENT" },

    {
      type: "slider",
      id: "player-walk",
      label: "Walk speed",
      min: 0.5,
      max: 10,
      step: 0.1,
      value: CONFIG.player.thirdPerson.walkSpeed,
      onChange: (value) => {
        CONFIG.player.thirdPerson.walkSpeed = value;
        player?.setTuning({ walkSpeed: value });
      },
    },

    {
      type: "checkbox",
      id: "player-navmesh-constraint",
      label: "Constrain Avatar to NavMesh",
      value: navmeshConstraintEnabled,
      onChange: setNavmeshConstraintEnabled,
    },

    { type: "section", label: "CAMERA" },

    {
      type: "slider",
      id: "player-camera",
      label: "3rd-person distance",
      min: CAMERA_DISTANCE.min,
      max: CAMERA_DISTANCE.max,
      step: CAMERA_DISTANCE.step,
      value: CONFIG.player.thirdPerson.distance,
      onChange: (value) => {
        CONFIG.player.thirdPerson.distance = value;
        player?.setTuning({ distance: value });
      },
    },

    { type: "section", label: "TOP VIEW" },

    {
      type: "slider",
      id: "minimap-extent",
      label: "Extent (m)",
      min: MINIMAP_MIN_EXTENT,
      max: MINIMAP_MAX_EXTENT,
      step: 1,
      value: CONFIG.minimap.extent,
      format: (v) => `${(+v).toFixed(0)} m`,
      onChange: (value) => {
        CONFIG.minimap.extent = value;
        minimap.setExtent(value);
      },
    },

    { type: "section", label: "AGENT POSE" },

    // Authoring sliders: they move SEEKR only. Bounds come from the scene's
    // own geometry, so they stay usable whatever its extent.
    ...["x", "y", "z"].map((axis) => ({
      type: "slider",
      id: `agent-${axis}`,
      label: axis.toUpperCase(),
      min: agentBounds[axis].min,
      max: agentBounds[axis].max,
      step: 0.01,
      value: agentStart[axis],
      editable: true,
      format: (value) => (+value).toFixed(3),
      onChange: (value) => setAgentAxis(axis, value),
    })),

    {
      type: "slider",
      id: "agent-heading",
      label: "Heading",
      min: 0,
      max: 360,
      step: 0.1,
      value: Number.isFinite(agentHeading) ? agentHeading : 0,
      editable: true,
      format: (value) => `${(+value).toFixed(1)}°`,
      onChange: (value) => {
        // Routed through the authoritative quaternion path. 360 lands on 0.
        player?.setAgentPose({ rotation: headingDegToQuaternion(value) });
      },
    },

    {
      type: "slider",
      id: "agent-scale",
      label: "Scale",
      min: AVATAR_SCALE_RANGE.min,
      max: AVATAR_SCALE_RANGE.max,
      step: AVATAR_SCALE_RANGE.step,
      value: CONFIG.player.avatarVisualScale,
      editable: true,
      format: (value) => (+value).toFixed(3),
      onChange: applyAvatarScale,
    },

    {
      type: "button",
      id: "set-scene-start",
      label: "Set Current Pose as Scene Start",
      onClick: setSceneStartFromCurrentPose,
    },

    {
      type: "button",
      id: "reset-scene-start",
      label: "Reset to Scene Start",
      onClick: resetToSceneStart,
    },
  ]);
}

// ---------------------------------------------------------------------------
// World and player initialization
// ---------------------------------------------------------------------------
worldReady
  .then(async ({ collider, navmeshFloorProbe, scene: descriptor }) => {
    activeScene = descriptor;
    applySceneDescriptor(descriptor);
    ui.setSceneName(descriptor.displayName ?? descriptor.id);

    // A scene may ship a navmesh and no obstacle collider (Habitat-GS does).
    // The navmesh gives us a floor to stand on; obstacle collision stays
    // unavailable rather than being faked from it.
    const floorProbe = collider ?? navmeshFloorProbe;
    if (!floorProbe) {
      throw new Error("The scene provides neither a collider nor a navmesh to stand on.");
    }

    applyEnvironmentTransform();
    applyVisualOffset();

    ui.setStatus("World loaded · Loading Explorer…");

    CONFIG.player.avatarVisualScale = profileAvatarScale(descriptor);
    const startPose = computeStartPose(descriptor);
    const [spawnX, spawnY, spawnZ] = startPose.position;

    console.log(`[spawn] Explorer start pose (${startPose.source}):`, {
      x: +spawnX.toFixed(2),
      y: +spawnY.toFixed(2),
      z: +spawnZ.toFixed(2),
      headingDeg: startPose.headingDeg,
    });

    avatar = await loadAvatar({
      url: AVATAR_URL,
      position: [spawnX, spawnY, spawnZ],
      scale: CONFIG.player.avatarVisualScale,
      // human.glb is authored facing +Z, so no model-axis correction.
      facingOffset: 0,
    });

    scene.add(avatar.object);
    avatar.setAnimation("idle");

    camera.position.set(spawnX + 4, spawnY + 2.5, spawnZ + 5);
    camera.lookAt(spawnX, spawnY + 1, spawnZ);

    // Transfer camera ownership from OrbitControls to the player controller.
    orbitControls.enabled = false;
    orbitControls.dispose();

    player = createPlayer({
      camera,
      domElement: renderer.domElement,
      eyeHeight: CONFIG.player.eyeHeight,
      speed: CONFIG.player.flySpeed,
      sprintMultiplier: CONFIG.player.sprintMultiplier,
      thirdPerson: { ...CONFIG.player.thirdPerson },
    });

    scene.add(player.rig);

    player.onDistanceChange((distance) => {
      CONFIG.player.thirdPerson.distance = distance;
      ui.setControl("player-camera", distance);
    });

    player.setAvatar(avatar);
    // Body, eye height and head pivot together (startup path).
    applyAvatarScale(CONFIG.player.avatarVisualScale);
    // Obstacle collision only; null for navmesh-only scenes.
    if (collider && collisionEnabled) player.setCollider(collider);

    player.controls.addEventListener("lock", () => ui.setHelpVisible(false));
    player.controls.addEventListener("unlock", () => ui.setHelpVisible(true));

    ui.onViewChange(setViewMode);
    player.onModeChange((mode) => ui.setViewMode(mode));

    setViewMode(APP_CONFIG.defaultView);

    if (startPose.headingDeg !== null) {
      player.setAgentPose({ rotation: headingDegToQuaternion(startPose.headingDeg) });
    }

    // NavMesh constraint, measured at the start pose just applied.
    applyNavmeshConstraint();

    resetMinimapToSeekr();
    refreshMinimapNavmesh({ fit: true });
    startSessionPoseSampling();
    buildControlPanel();

    console.log("[avatar] Loaded animations:", avatar.animations);
    console.log("[player] Controller ready");

    ui.addMessage("System", `Ready in ${descriptor.displayName} · WASD to explore`);
  })
  .catch((error) => {
    console.error("[Seekr] Initialization failed:", error);
    ui.setStatus("Initialization failed · See console");
    ui.addMessage(
      "System",
      `Initialization failed: ${error.message}. Is the Habitat-GS package present ` +
        `at the path configured in body/vite.config.js?`,
    );
  });

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------
window.addEventListener("keydown", (event) => {
  if (isTyping() || !player) return;

  if (event.code === "KeyV") {
    setViewMode(player.mode === "third" ? "first" : "third");
  }

  if (event.code === "KeyC") {
    captureObservation("manual");
  }

  if (event.code === "KeyN") {
    if (navmeshMesh) setNavmeshVisible(!navmeshMesh.visible);
  }

  if (event.code === "KeyP") {
    // REPORT ONLY: where Seekr is, plus a paste-ready defaultStart snippet.
    const pose = player.getAgentPose();
    const headingDeg = quaternionToHeadingDeg(pose.rotation);

    console.log(
      [
        `[Seekr] Current pose in "${activeScene?.id}":`,
        formatDefaultStart(pose.position, headingDeg),
      ].join("\n"),
    );

    ui.addMessage("System", `Current pose: ${formatPoseReport(pose.position, headingDeg)}`);
    ui.setStatus(`Current pose · ${formatPoseReport(pose.position, headingDeg)}`);

    navigator.clipboard
      ?.writeText(formatDefaultStart(pose.position, headingDeg))
      .catch(() => console.warn("[Seekr] Clipboard unavailable; pose logged above."));
  }
});

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
startLoop(renderer, scene, camera, (delta) => {
  player?.update(delta);
  avatar?.update(delta);

  camera.getWorldPosition(cameraWorldPosition);

  const seekrPosition =
    avatar?.object.position ?? player?.rig.position ?? cameraWorldPosition;

  ui.setFloorplanPosition(seekrPosition.x, seekrPosition.z);
  syncAgentPosePanel();
  trackTravelForAutoCapture();
  ui.setCameraPosition(
    player?.mode ?? "first",
    cameraWorldPosition.x,
    cameraWorldPosition.y,
    cameraWorldPosition.z,
  );

  minimap.update({
    avatarX: avatar?.object.position.x,
    avatarZ: avatar?.object.position.z,
    heading: avatar ? avatar.object.rotation.y - (avatar.facingOffset ?? 0) : 0,
    camX: cameraWorldPosition.x,
    camZ: cameraWorldPosition.z,
    environment: roomRect ? { x: roomRect.x, z: roomRect.z, rect: roomRect } : null,
  });
});

// ---------------------------------------------------------------------------
// Debug handle — the surfaces later integrations will use.
// ---------------------------------------------------------------------------
window.__seekr = {
  get scene() {
    return activeScene;
  },
  scenes: SCENES,
  loadScene: loadSceneById,
  captureEgo,
  get lastEgoFrame() {
    return lastEgoFrame;
  },
  captureObservation,
  get player() {
    return player;
  },
};
