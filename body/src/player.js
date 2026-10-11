/**
 * player.js — Locomotion + camera modes.
 *
 * Two modes (switch via setMode, UI buttons, or V key):
 *
 *   "first" — FPS controller: WASD moves the avatar, mouse look via pointer
 *             lock. Camera sits at the avatar's eye (rig at avatar feet,
 *             camera offset to eyeHeight). No Q/E vertical flight when an
 *             avatar is present; free-fly fallback when avatar is absent.
 *
 *   "third" — The camera orbits the avatar (boom camera).
 *             WASD moves the AVATAR relative to the camera direction; the
 *             avatar rotates to face its movement and plays idle/walk/run.
 *             Mouse look orbits the boom around the avatar's head.
 *
 * Rig pattern: the camera lives inside `rig` (THREE.Group) — locomotion
 * moves the rig, mouse look rotates the camera.
 *
 * ## Authoritative eye orientation
 *
 * One variable, `_eyeYaw`, tracks the avatar's look direction in Three.js
 * camera convention (0 = looking toward −Z; positive = CCW / left turn).
 * This is separate from the avatar's visual `rotation.y` which includes
 * `facingOffset` to compensate for the model's authored forward axis.
 *
 * In first-person mode `getEyeQuaternion()` reads the live camera world
 * quaternion (PointerLockControls owns yaw+pitch). In third-person it
 * reconstructs a quaternion from `_eyeYaw` — updated whenever the avatar
 * moves and when entering third-person (see syncBodyYawToCamera) — tilted
 * only by Seekr's own `_tpLookPitch` (level unless the brain looked up/down).
 *
 * ## Camera -Z convention
 *
 * Three.js cameras look along their local −Z. `camera.getWorldDirection()`
 * returns the world −Z vector. When converting a movement vector `m` to a
 * camera yaw: `_eyeYaw = atan2(m.x, m.z) + π`. This single `+ π` is the
 * ONLY place the −Z convention is applied; no other sign inversion exists.
 * (This camera-convention π is unrelated to any model-axis correction.)
 *
 * ## Avatar model-axis correction
 *
 * Soldier.glb's authored forward is +Z — verified empirically by sampling
 * bind-pose vertices of the actual GLB (face/chest vertices sit at larger
 * +Z than the back). The body-yaw formula is:
 *
 *   rotation.y = atan2(dir.x, dir.z) + facingOffset
 *
 * atan2(dir.x, dir.z) is the yaw that rotates world +Z onto `dir`, so a
 * +Z-authored model needs facingOffset = 0. Math.PI is ONLY for models
 * authored facing −Z. applyBodyHeading() below is the single owner of
 * body-yaw writes — both movement branches and the camera sync use it.
 *
 * ## Three orientation states, one camera
 *
 * There is only ONE Three.js camera and ONE PointerLockControls, so the mouse
 * writes `camera.quaternion` in both modes — but it MEANS different things:
 *
 *   1. Seekr heading (embodied)      → `avatar.object.rotation.y`
 *                                      single owner: applyBodyHeading()
 *   2. First-person look pitch       → `_fpPitch`
 *      (embodied agent state)          saved on FP→TP, restored on TP→FP
 *   3. Third-person orbit yaw/pitch  → `camera.quaternion` while in TP
 *      (visualization state only)      write-only: never read back as look state
 *   4. Third-person embodied pitch   → `_tpLookPitch`
 *      (embodied agent state)          the brain's look_up/look_down while the
 *                                      camera is the spectator; level on TP entry
 *
 * In first-person the mouse is agent state — it changes where Seekr looks.
 * In third-person the mouse only orbits the external camera and must NOT
 * rotate Seekr. Entering first-person therefore RECONSTRUCTS the eye from
 * (1) + (2) and discards (3); it never reuses the live camera orientation.
 * Conflating (2) and (3) — they share one quaternion — is what made a steep
 * third-person orbit reappear as a steep downward first-person view.
 *
 * ## Body-yaw ↔ camera sync
 *
 * In first-person the mesh is hidden and mouse look rotates only the
 * camera, so a stationary mouse turn used to leave the visual yaw stale
 * until the next WASD input (the "backwards after switching" bug).
 * syncBodyYawToCamera() re-aligns the body every idle FP frame, and
 * setMode("third") calls it with syncEye=true so `_eyeYaw` (perception)
 * stays continuous across the FP→TP switch. Third-person orbiting still
 * rotates neither the body nor the eye, and FP movement keeps facing the
 * movement direction (strafing diverges from the camera by design).
 *
 * ## Programmatic steering (autonomous brain motor)
 *
 * setExternalMove(x, z) supplies a normalized horizontal walk direction
 * that update() consumes ONLY when no movement keys are held — keyboard
 * input always wins, so pressing a movement key interrupts programmatic
 * movement at any time. External steering reuses the exact keyboard movement path: same
 * collision check, same animations, same ground clamp — always at walk
 * speed, never sprint. ONE deliberate difference: it is a semantic
 * TRANSLATION in Seekr's own frame (W/S/A/D = forward/back/strafe), so it
 * never re-points the body yaw or `_eyeYaw` at the walk direction the way
 * manual WASD does — a brain strafe or backward step keeps the heading, and
 * heading changes for the brain go through turnBy() only.
 * After update(),
 * `lastMoveSource` reports which input drove the frame ("keys" |
 * "external" | null) and `lastBlocked` reports a collider block; the
 * autonomous motor in main.js reads both for one-step action feedback.
 *
 * Collision comes from collision.js (setCollider); without it the avatar
 * moves freely on its horizontal plane.
 */
import * as THREE from "three";
import { constrainDisplacementToNavmesh } from "./navmeshLocomotion.js";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { UP as UP_AXIS } from "./agentPose.js";
import { panScalars } from "./cameraPan.js";
import { nextCameraDistance, CAMERA_DISTANCE } from "./cameraDistance.js";

export function createPlayer({
  camera,
  domElement,
  eyeHeight = 1.6,
  speed = 5,
  sprintMultiplier = 4,
  thirdPerson = {},
  // Called with the key code when a TRACKED key is pressed while input is
  // gated off. Purely a notification: it changes nothing here, and it is what
  // lets the application say why the key did nothing instead of leaving the
  // user to conclude the app has hung.
  onBlockedInput = () => {},
  // Called when mouse-look actually rotates the agent. Purely a notification.
  onLookInput = () => {},
} = {}) {
  const tp = {
    distance: thirdPerson.distance ?? 4, // boom length (m behind the head)
    headHeight: thirdPerson.headHeight ?? 1.7,
    walkSpeed: thirdPerson.walkSpeed ?? 2,
    runSpeed: thirdPerson.runSpeed ?? 6,
    damping: thirdPerson.damping ?? 12, // camera follow smoothing
  };

  const rig = new THREE.Group();
  rig.name = "playerRig";
  camera.position.set(0, eyeHeight, 0);
  rig.add(camera);

  const controls = new PointerLockControls(camera, domElement);

  // ── Input gate ─────────────────────────────────────────────────
  // ONE flag, checked by every listener this module owns, so "the rig is
  // frozen" is a single fact rather than a per-listener convention. Set by
  // setInputEnabled(); nothing else writes it.
  //
  // It gates INPUT only. update() keeps running, so gravity, the NavMesh
  // constraint and the camera rig all continue to behave normally — a frozen
  // agent is one that stops being driven, not one that is removed from the
  // simulation.
  let inputEnabled = true;

  /**
   * Mouse-look, gated SEPARATELY from the keys.
   *
   * The two come apart during a diagnostic benchmark run: WASD and the arrows
   * must stay off the ordinary motor — they are routed to the benchmark motor
   * instead — while mouse-look is the one human control that may drive Seekr
   * directly, because rotating translates nothing and so needs no navmesh.
   */
  let lookEnabled = true;

  function onClick() {
    // Pointer lock would hide the cursor, which is exactly what a
    // click-to-pick tool needs back. Look is gated on its OWN flag: during a
    // diagnostic benchmark run the keys are off but looking is allowed.
    if (!lookEnabled) {
      onBlockedInput("MouseLook");
      return;
    }
    controls.lock();
  }
  domElement.addEventListener("click", onClick);

  // --- keyboard state (ignored while the user types in a UI field) ---
  const keys = new Set();
  const TRACKED = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
    "ShiftLeft", "ShiftRight",
    // Arrow keys are LOOK, not movement — see applyArrowLook().
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  ]);

  /** Arrow keys steer the view; they never translate Seekr. */
  const LOOK_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
  const isTyping = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };

  // Last time any movement key or mouse-look input was received (ms, performance.now).
  let lastInputTime = 0;

  function onKeyDown(e) {
    if (isTyping()) return;

    if (!inputEnabled) {
      // Swallowed, but not silently: the caller decides what to tell the user
      // and how often. Reported only for keys that would otherwise have done
      // something, so an unrelated keystroke is not announced.
      if (TRACKED.has(e.code)) onBlockedInput(e.code);
      return;
    }

    if (TRACKED.has(e.code)) {
      // Arrows would otherwise scroll the page out from under the canvas.
      if (LOOK_KEYS.has(e.code)) e.preventDefault();
      keys.add(e.code);
      lastInputTime = performance.now();
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }
  // Mouse-look via pointer lock also counts as movement input.
  function onMouseMove() {
    // A real look, actually applied by the library. Reported so the caller can
    // record that a human changed the authoritative heading.
    if (lookEnabled && controls.isLocked) {
      lastInputTime = performance.now();
      onLookInput();
      return;
    }

    if (!inputEnabled) {
      // Belt to setInputEnabled's braces. `controls.enabled = false` already
      // stops the library rotating the camera, and unlock() is in flight —
      // but exitPointerLock() is ASYNCHRONOUS, so `isLocked` can still be
      // true for a frame or two. Reporting here means a look attempt in that
      // window is still explained rather than silently ignored.
      if (controls.isLocked) onBlockedInput("MouseLook");
      return;
    }
    if (controls.isLocked) lastInputTime = performance.now();
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);

  // --- mode state ---
  let mode = "first"; // "first" | "third"
  // setMode() short-circuits when the mode is unchanged, but the constructor
  // only parks the camera — it never applies the mode's orientation. Startup
  // must therefore be able to run the setup for the mode we already report,
  // so the first call always applies. Reuses the same branch the 1st/3rd
  // Person buttons use rather than adding a second initialization path.
  let modeApplied = false;
  let avatar = null;  // object returned by loadAvatar()
  let collider = null; // optional, from collision.js
  // Optional NavMesh probe for the "Constrain Avatar to NavMesh" feature.
  // null = unconstrained, which is exactly the pre-feature behaviour.
  // Independent of `collider`: collision and NavMesh constraint are separate
  // features and either may be on without the other.
  let navmeshProbe = null;
  // Elevation following along the NavMesh (see advance()). Off unless the
  // application asks for it; the offset preserves the authored grounding.
  let navmeshFollowElevation = false;
  let navmeshFootOffset = 0;
  let lastNavmeshBlocked = false;
  let snapBoom = false;
  let lastMoving = false; // did the avatar translate during the last update()?

  // ── Programmatic steering (autonomous brain motor) ─────────────────────
  // Normalized horizontal walk direction supplied by main.js's
  // driveEmbodiedMotor via setExternalMove(). Consumed by update() only when no
  // movement keys are held — real keyboard input always wins.
  let externalMove = null;   // { x, z } normalized, or null
  let lastBlocked = false;   // last update()'s move attempt hit the collider
  let lastMoveSource = null; // "keys" | "external" | null for last update()

  const modeListeners = new Set();

  //const BODY_RADIUS = 0.4;  // horizontal clearance to walls/trunks
  //const CHEST_HEIGHT = 1.0; // wall ray origin height
  //const MAX_STEP_UP = 0.5;  // highest ledge the avatar can walk up
  //const BOOM_MARGIN = 0.3;  // keep the camera this far off obstacles

  const BODY_RADIUS = 0.12;  // horizontal clearance to walls/trunks
  const CHEST_HEIGHT = 1.0; // wall ray origin height (also the boom probe)
  // Highest ledge the avatar can walk up: an ordinary floor threshold. Anything
  // taller (chairs, tables, planters, counters) is an OBSTACLE, never a floor.
  const MAX_STEP_UP = 0.25;
  const BOOM_MARGIN = 0.3;  // keep the camera this far off obstacles

  /**
   * Heights above the feet at which the body is tested against the collider
   * before a move. A single chest-height ray let everything lower than 1 m
   * pass; this short stack spans shin to head so furniture blocks like a
   * wall does. The lowest ray sits just above MAX_STEP_UP, so a threshold
   * still passes underneath it and is climbed by the ground clamp instead.
   */
  const BODY_RAY_HEIGHTS = [MAX_STEP_UP + 0.05, 0.6, CHEST_HEIGHT, 1.4];

  /** True when any body ray from `pos` along `dir` hits within BODY_RADIUS. */
  function bodyBlocked(pos, dir) {
    for (const h of BODY_RAY_HEIGHTS) {
      head.copy(pos);
      head.y += h;
      if (collider.blocked(head, dir, BODY_RADIUS)) return true;
    }
    return false;
  }

  /**
   * Ground clamp: follow the floor under the feet.
   *
   * Casts down from just above step height. A surface at most MAX_STEP_UP
   * above the feet is a step and is climbed; the floor any distance below is
   * settled onto (walking off a threshold, or standing above the floor after
   * a manual Y edit with collision on). A surface higher than MAX_STEP_UP is
   * an obstacle: it is never snapped to, and the position is left alone.
   */
  function clampToGround(pos) {
    const groundY = collider.groundY(pos.x, pos.z, pos.y + MAX_STEP_UP + 0.1);
    if (groundY !== null && groundY - pos.y <= MAX_STEP_UP) {
      pos.y = groundY;
    }
  }

  // Reused temporaries
  const move = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const back = new THREE.Vector3();
  const head = new THREE.Vector3();
  const boomTarget = new THREE.Vector3();
  const worldPos = new THREE.Vector3();

  // ── Authoritative eye yaw ─────────────────────────────────────────────────
  // Stored in Three.js camera convention: 0 = looking toward −Z.
  // Updated when the avatar moves in third-person (see updateThird) and on
  // the FP→TP switch (see setMode/syncBodyYawToCamera).
  // In first-person, getEyeQuaternion() reads the live camera quaternion
  // instead of this value.
  let _eyeYaw = 0;
  // Scratch for setAgentPose(); avoids allocating per call.
  const _poseDir = new THREE.Vector3();

  // Temporaries for getEyeQuaternion (reused each call to avoid GC pressure).
  const _eyeQ = new THREE.Quaternion();
  const _eyeEuler = new THREE.Euler(0, 0, 0, "YXZ");

  // ── First-person look pitch ───────────────────────────────────────────────
  // Dedicated storage for Seekr's EMBODIED look pitch, in radians, YXZ-euler
  // convention (positive = looking up). 0 = neutral / level, the default
  // before the player has ever looked around in first-person.
  //
  // This exists because there is only ONE camera and ONE PointerLockControls,
  // so `camera.quaternion` alone cannot distinguish two different meanings of
  // "where the mouse is pointing":
  //   • first-person — embodied agent state: where SEEKR is looking.
  //   • third-person — visualization state: where the ORBIT camera sits.
  // Conflating them is what made a steep third-person orbit reappear as a
  // steep first-person view. Third-person orbit is now write-only with
  // respect to `camera.quaternion`; it is never read back as look state.
  //
  // Saved on FP→TP (storeFirstPersonPitch), restored on TP→FP
  // (applyFirstPersonOrientation). Yaw is NOT stored here — first-person yaw
  // is always reconstructed from Seekr's own heading, which is authoritative
  // and already has a single owner (applyBodyHeading).
  let _fpPitch = 0;
  const _fpEuler = new THREE.Euler(0, 0, 0, "YXZ");

  // Matches PointerLockControls' default polar clamp (straight up / down).
  const MAX_LOOK_PITCH = Math.PI / 2;

  // ── Third-person embodied look pitch ─────────────────────────────────────
  // Seekr's OWN view tilt while the camera is the spectator orbit, in radians
  // (positive = looking up). This is the fourth orientation state the header
  // anticipates, with its own storage rather than time-sharing the camera:
  //
  //   • it is what the autonomous brain's look_up / look_down change in
  //     third person (pitchBy), and what third-person perception reads
  //     (getEyeQuaternion) — so an ego frame after a look is genuinely tilted;
  //   • the spectator camera.quaternion is never read or written for it;
  //   • it is NOT the human's parked first-person pitch (`_fpPitch`): it
  //     starts level on every entry into third person, so a human FP look
  //     never leaks into TP perception (unchanged behaviour), and it is not
  //     folded into `_fpPitch` on the way back — the brain's look never
  //     hijacks the human's first-person view.
  let _tpLookPitch = 0;

  /**
   * Return the authoritative eye-space world quaternion.
   *
   * First-person: camera world quaternion (includes mouse-look pitch + yaw).
   * Third-person:  level quaternion from the avatar's last movement yaw;
   *               yaw is stored in camera convention (0 = −Z).
   *
   * This is the single source of truth for perception capture orientation.
   * Call getCaptureEgoView() rather than getEyeQuaternion() directly when
   * building a capture — getCaptureEgoView bundles position + hide list.
   *
   * @returns {number[]} [x, y, z, w]
   */
  function getEyeQuaternion() {
    if (mode === "first") {
      camera.getWorldQuaternion(_eyeQ);
    } else {
      // Third-person: look in the avatar's facing direction, tilted only by
      // Seekr's own embodied look pitch (level unless the brain looked up or
      // down). _eyeYaw is in camera convention (0 = −Z) so we set it
      // directly. The spectator orbit is never consulted.
      _eyeEuler.set(_tpLookPitch, _eyeYaw, 0);
      _eyeQ.setFromEuler(_eyeEuler);
    }
    return [_eyeQ.x, _eyeQ.y, _eyeQ.z, _eyeQ.w];
  }

  /**
   * Seekr's EMBODIED eye pitch, in radians. POSITIVE looks UP, 0 is level.
   *
   * Gaze proprioception for the brain (FIX 07): the pitch of the exact view
   * getEyeQuaternion() describes, so it is the pitch of the RGB the brain
   * receives — never the spectator orbit's.
   *
   *   first-person  the camera IS the eye, so decompose its live quaternion
   *                 (YXZ, same as storeFirstPersonPitch / pitchBy). Mouse
   *                 look, arrow look and brain look all wrote this one state,
   *                 so a manual tilt between autonomous actions is reported
   *                 truthfully.
   *   third-person  Seekr's own `_tpLookPitch`, the only embodied pitch in
   *                 that mode. The orbit camera is never read.
   *
   * Read-only: it measures, it never changes anything.
   *
   * @returns {number} radians in [-MAX_LOOK_PITCH, MAX_LOOK_PITCH]
   */
  function getEyePitch() {
    if (mode !== "first") return _tpLookPitch;
    _fpEuler.setFromQuaternion(camera.quaternion); // YXZ: pitch, yaw, roll
    return Math.max(-MAX_LOOK_PITCH, Math.min(MAX_LOOK_PITCH, _fpEuler.x));
  }

  // ── Body yaw (visual mesh rotation) ──────────────────────────────────────

  /**
   * Rotate the avatar mesh to face the horizontal direction (x, z).
   *
   * SINGLE OWNER of `avatar.object.rotation.y` writes. atan2(x, z) is the
   * yaw from world +Z; `facingOffset` (0 for the +Z-authored Soldier.glb;
   * π only for −Z-authored models) aligns the mesh's authored forward with
   * the direction. Do not write rotation.y anywhere else.
   */
  function applyBodyHeading(x, z) {
    if (!avatar) return;
    avatar.object.rotation.y = Math.atan2(x, z) + (avatar.facingOffset ?? 0);
  }

  /**
   * Align the avatar's body yaw with the camera's horizontal look direction.
   *
   * Called every stationary first-person frame (a mouse turn must never
   * leave the visual yaw stale) and on the FP→TP switch. No-op when the
   * camera looks straight up/down (degenerate horizontal direction).
   *
   * @param {boolean} syncEye  Also update `_eyeYaw` so third-person
   *   perception (getEyeQuaternion) is continuous after a mode switch.
   *   Uses the same single camera-convention `+ π` as updateThird.
   */
  function syncBodyYawToCamera(syncEye = false) {
    if (!avatar) return;
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) return; // looking straight up/down
    applyBodyHeading(forward.x, forward.z);
    if (syncEye) {
      _eyeYaw = Math.atan2(forward.x, forward.z) + Math.PI;
    }
  }

  /**
   * Save Seekr's embodied look pitch when LEAVING first-person.
   *
   * While in first-person the mouse expresses agent state, so the pitch on
   * `camera.quaternion` is genuine "where Seekr is looking". Third-person is
   * about to overwrite that same quaternion with orbit angles, so capture the
   * pitch first — otherwise it is gone, and returning to first-person could
   * only ever guess (the previous fix guessed "level", which discarded a
   * deliberate look-up/look-down).
   */
  function storeFirstPersonPitch() {
    _fpEuler.setFromQuaternion(camera.quaternion);
    _fpPitch = Math.max(-MAX_LOOK_PITCH, Math.min(MAX_LOOK_PITCH, _fpEuler.x));
  }

  /**
   * Seekr's embodied heading, expressed in Three.js camera convention
   * (0 = looking toward −Z).
   *
   * `avatar.object.rotation.y` is the authoritative record of where Seekr
   * faces and has a single owner (applyBodyHeading), so first-person yaw is
   * reconstructed from it rather than read back off the camera — the camera
   * may be holding third-person orbit yaw, which is visualization state and
   * must never become agent state.
   *
   * The `+ Math.PI` is the same single camera-convention conversion used by
   * syncBodyYawToCamera and updateThird: atan2(x, z) measures from world +Z,
   * while a camera at rotation.y = θ looks toward −Z.
   */
  // ── Third-person inspection pan (right mouse drag) ──────────────────────
  // LEFT mouse keeps its existing orbit behaviour untouched (pointer lock +
  // mouse-look driving camera.quaternion, which the boom follows). RIGHT
  // mouse TRANSLATES the view instead: it never touches camera.quaternion, so
  // it cannot orbit, and it never touches Seekr.
  //
  // `panOffset` is ephemeral camera state. It shifts the boom's target, which
  // moves the camera and what it looks at by the same amount, so orientation
  // is unchanged and Seekr is free to leave the centre of frame — that is
  // what panning is for. It is never written to the agent pose, the scene
  // profile, the environment, visualOffset or the NavMesh.
  const panOffset = new THREE.Vector3();
  const _panRight = new THREE.Vector3();
  const _panUp = new THREE.Vector3();
  let panning = false;

  /** Translates the inspection camera. Never rotates anything. */
  function panCameraBy(movementX, movementY) {
    const { right, up } = panScalars({
      movementX,
      movementY,
      distance: tp.distance,
      fovDeg: camera.fov,
      viewportHeight: domElement.clientHeight || 1,
    });

    // The rig carries no rotation, so the camera's local axes are its world
    // axes — pan stays in the plane the viewer is actually looking at.
    _panRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _panUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

    panOffset.addScaledVector(_panRight, right);
    panOffset.addScaledVector(_panUp, up);
  }

  function onPanPointerDown(e) {
    if (!inputEnabled || e.button !== 2 || mode !== "third") return;
    panning = true;
    domElement.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onPanPointerMove(e) {
    if (!panning) return;
    if (mode !== "third") {
      panning = false; // mode changed mid-drag
      return;
    }
    panCameraBy(e.movementX, e.movementY);
  }

  function onPanPointerUp(e) {
    if (e.button !== 2) return;
    panning = false;
    domElement.releasePointerCapture?.(e.pointerId);
  }

  /** Canvas-only, third-person-only. The rest of the page keeps its menu. */
  function onPanContextMenu(e) {
    if (mode === "third") e.preventDefault();
  }

  // ── Third-person camera dolly (mouse wheel) ─────────────────────────────
  // Drives the SAME tp.distance the Controls "Camera" slider drives, so the
  // two stay in lock-step. Listeners let main.js mirror the value back into
  // the slider without re-firing its onChange.
  //
  // Distance only: orbit (camera.quaternion) and pan (panOffset) are left
  // exactly as they are, so a dolly never re-frames or re-centres the view.
  const distanceListeners = new Set();

  function onCameraWheel(e) {
    if (!inputEnabled || mode !== "third") return;

    const next = nextCameraDistance(tp.distance, e.deltaY, CAMERA_DISTANCE);
    e.preventDefault(); // canvas-only, so page/panel scrolling is unaffected

    if (next === tp.distance) return; // already at a limit

    tp.distance = next;
    for (const fn of distanceListeners) fn(tp.distance);
  }

  domElement.addEventListener("wheel", onCameraWheel, { passive: false });

  domElement.addEventListener("pointerdown", onPanPointerDown);
  domElement.addEventListener("contextmenu", onPanContextMenu);
  window.addEventListener("pointermove", onPanPointerMove);
  window.addEventListener("pointerup", onPanPointerUp);

  function seekrHeadingYaw() {
    if (avatar) {
      return avatar.object.rotation.y - (avatar.facingOffset ?? 0) + Math.PI;
    }
    // Free-fly fallback (no avatar): there is no embodied heading to restore,
    // so keep the camera's current horizontal heading.
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) return _eyeYaw;
    return Math.atan2(forward.x, forward.z) + Math.PI;
  }

  /**
   * Rebuild the first-person eye orientation when ENTERING first-person.
   *
   * Composed entirely from agent state — Seekr's heading (yaw) plus the saved
   * first-person look pitch — so third-person's orbit orientation is DISCARDED
   * rather than inherited. Roll is always zero: neither mode has a concept of
   * a rolled eye.
   *
   * This is the orientation half of the FP↔TP hand-over, mirroring the
   * syncBodyYawToCamera(true) call the "third" branch already makes.
   *
   * Writes camera.quaternion (local). `rig` is a position-only container —
   * nothing in this codebase rotates it — so local and world orientation are
   * identical here; if the rig ever gains a rotation this must convert
   * through it.
   *
   * Deliberately does NOT write `_eyeYaw`: first-person reads eye orientation
   * live from the camera, and `_eyeYaw` keeps its documented two writers
   * (updateThird on move, and the setMode("third") hand-over).
   */
  function applyFirstPersonOrientation() {
    const yaw = seekrHeadingYaw();
    // Wrap to (−π, π]. Mathematically 2π and 0 are the same rotation, but the
    // unwrapped form yields w = −1, and PointerLockControls decomposes
    // camera.quaternion on the next mouse move — keep it canonical.
    _fpEuler.set(_fpPitch, Math.atan2(Math.sin(yaw), Math.cos(yaw)), 0);
    camera.quaternion.setFromEuler(_fpEuler);
  }

  /** Wrap an angle to (−π, π] so stored yaw stays canonical. */
  function wrapAngle(radians) {
    return Math.atan2(Math.sin(radians), Math.cos(radians));
  }

  /**
   * Rotate Seekr IN PLACE by `radians`.
   *
   * Sign follows the `_eyeYaw` convention documented at the top of this file:
   * positive = counter-clockwise = turn LEFT.
   *
   * This is embodied orientation, not locomotion: it never translates, never
   * queries the collider, never touches `lastBlocked`, and never fakes A/D
   * strafing. Strafing moves the body sideways while facing the same way;
   * this changes the facing itself.
   *
   * Mode handling — the two modes store the embodied look direction in
   * different places (see "Three orientation states, one camera"):
   *
   *   first-person — the camera IS the eye, so its yaw is the embodied look
   *     direction. Only yaw is rotated: pitch is genuine agent state and roll
   *     stays zero. The body is re-synced immediately so no caller can observe
   *     a stale heading before the next idle frame would have fixed it.
   *
   *   third-person — the orbit camera is VISUALISATION ONLY and must never
   *     become Seekr's orientation, so it is deliberately left untouched: the
   *     spectator keeps its viewpoint while Seekr rotates in place. The
   *     embodied pair `_eyeYaw` + body heading is what moves.
   *
   * `_fpPitch` is never written here, so a stored first-person pitch survives
   * turning in either mode.
   *
   * @param {number} radians  Positive = left, negative = right.
   * @returns {number} The rotation actually applied (0 when there is no
   *   avatar to turn, or the input was not a finite non-zero angle).
   */
  /**
   * The embodied yaw the next turnBy() will rotate, in camera convention.
   * Mode-dependent because the two modes store the look direction in
   * different places (see "Three orientation states, one camera").
   */
  function currentEmbodiedYaw() {
    if (mode === "first") {
      _fpEuler.setFromQuaternion(camera.quaternion); // YXZ → .y is yaw
      return _fpEuler.y;
    }
    return _eyeYaw;
  }

  /**
   * Seekr's pose: base (feet) position plus authoritative orientation as a
   * quaternion about world Y.
   *
   * The quaternion is DERIVED from the existing single-owner yaw state, not
   * stored beside it — for an upright agent the two are isomorphic, so there
   * is no second heading system to drift. Camera pitch is deliberately
   * excluded: it is a view concern, never part of the floor-plane heading.
   *
   * @returns {{position: THREE.Vector3, rotation: THREE.Quaternion}}
   */
  function getAgentPose() {
    const base = avatar ? avatar.object.position : rig.position;
    // seekrHeadingYaw() is camera convention (0 = −Z); −π returns it to the
    // +Z body reference that headingDeg and applyBodyHeading both use.
    const heading = seekrHeadingYaw() - Math.PI;

    return {
      position: base.clone(),
      rotation: new THREE.Quaternion().setFromAxisAngle(UP_AXIS, heading),
    };
  }

  /**
   * Places Seekr at an absolute pose. Accepts a quaternion directly so a
   * Habitat episode's start_rotation needs no degrees round-trip.
   *
   * Rotation is applied through turnBy() — the one sanctioned rotation path —
   * so every existing sync runs and no new writer of `_eyeYaw` is introduced.
   * Does not change view mode, scene transforms, the NavMesh, or calibration.
   *
   * @param {{position?: THREE.Vector3|number[], rotation?: THREE.Quaternion}} pose
   */
  function setAgentPose({ position, rotation } = {}) {
    if (position) {
      const [x, y, z] = Array.isArray(position)
        ? position
        : [position.x, position.y, position.z];

      if (avatar) avatar.object.position.set(x, y, z);
      // The rig parks at the feet; update() re-parks it every frame anyway,
      // but setting it now keeps a same-tick getAgentPose() honest.
      rig.position.set(x, y, z);
    }

    if (rotation) {
      _poseDir.set(0, 0, 1).applyQuaternion(rotation);
      _poseDir.y = 0; // floor-plane heading only; pitch/roll are view state

      if (_poseDir.lengthSq() > 1e-12) {
        // Camera convention target, then rotate by the exact delta so the
        // result lands on the requested heading rather than near it.
        const target = Math.atan2(_poseDir.x, _poseDir.z) + Math.PI;
        turnBy(wrapAngle(target - currentEmbodiedYaw()));
      }
    }
  }

  /**
   * Arrow-key look speed, radians per second (~86°/s). Frame-rate independent:
   * it is multiplied by delta, so holding a key sweeps at a steady rate.
   */
  const ARROW_LOOK_RATE = 1.5;

  /**
   * Changes Seekr's embodied look PITCH.
   *
   * First person: the camera IS the eye, so this edits the same
   * camera.quaternion that mouse look writes: one orientation state, not two.
   * Yaw is preserved, roll forced to zero, and pitch clamped to the same
   * MAX_LOOK_PITCH limit PointerLockControls enforces.
   *
   * Third person: the camera is the spectator orbit and must not be touched,
   * so the tilt goes to Seekr's own `_tpLookPitch`, which third-person
   * perception (getEyeQuaternion) reads. Same clamp, same sign.
   *
   * `_fpPitch` is deliberately not written here — it is captured on the way
   * out of first person by storeFirstPersonPitch(), exactly as with mouse look.
   *
   * Never translates, never rotates the body, never queries the collider.
   *
   * POSITIVE radians look UP. Note Camera.getWorldDirection() returns -Z
   * (it overrides Object3D's +Z), so a camera at +pitch faces upward.
   */
  function pitchBy(radians) {
    if (!Number.isFinite(radians) || radians === 0) return 0;

    if (mode !== "first") {
      const before = _tpLookPitch;
      _tpLookPitch = Math.max(
        -MAX_LOOK_PITCH,
        Math.min(MAX_LOOK_PITCH, before + radians),
      );
      return _tpLookPitch - before;
    }

    _fpEuler.setFromQuaternion(camera.quaternion); // YXZ: pitch, yaw, roll
    const before = _fpEuler.x;
    const pitch = Math.max(
      -MAX_LOOK_PITCH,
      Math.min(MAX_LOOK_PITCH, before + radians),
    );

    _fpEuler.set(pitch, _fpEuler.y, 0);
    camera.quaternion.setFromEuler(_fpEuler);

    return pitch - before;
  }

  /**
   * Applies held arrow keys as a look, first person only.
   *
   * Yaw goes through turnBy() — the single sanctioned rotation path — so the
   * body yaw stays in sync and no new writer of avatar rotation is created.
   * Pitch goes through pitchBy(). Neither touches position, so arrows can
   * never move Seekr.
   *
   * Third person is untouched: mouse orbit, pan and the wheel dolly keep sole
   * control of that camera.
   */
  function applyArrowLook(delta) {
    if (mode !== "first") return;

    const step = ARROW_LOOK_RATE * delta;

    // Positive = counter-clockwise = left, matching turnBy's convention.
    let yaw = 0;
    if (keys.has("ArrowLeft")) yaw += step;
    if (keys.has("ArrowRight")) yaw -= step;
    if (yaw !== 0) turnBy(yaw);

    // Positive pitch looks up.
    let pitch = 0;
    if (keys.has("ArrowUp")) pitch += step;
    if (keys.has("ArrowDown")) pitch -= step;
    if (pitch !== 0) pitchBy(pitch);
  }

  function turnBy(radians) {
    if (!Number.isFinite(radians) || radians === 0) return 0;
    if (!avatar) return 0; // nothing embodied to rotate

    if (mode === "first") {
      _fpEuler.setFromQuaternion(camera.quaternion); // YXZ: pitch, yaw, roll
      _fpEuler.set(_fpEuler.x, wrapAngle(_fpEuler.y + radians), 0);
      camera.quaternion.setFromEuler(_fpEuler);
      camera.updateMatrixWorld(true);
      // Keep the visual body consistent with the new look direction now.
      syncBodyYawToCamera();
    } else {
      // Deliberate third writer of `_eyeYaw` (alongside updateThird on move
      // and the setMode("third") hand-over): turning IS an embodied
      // orientation change, which is exactly what `_eyeYaw` tracks.
      _eyeYaw = wrapAngle(_eyeYaw + radians);
      // Convert camera convention (0 = −Z) back to the +Z body reference.
      const heading = _eyeYaw - Math.PI;
      applyBodyHeading(Math.sin(heading), Math.cos(heading));
    }

    return radians;
  }

  /**
   * Applies one frame's walk, constrained to the NavMesh when enabled.
   *
   * The single translation point for BOTH first- and third-person: the two
   * update paths differ in camera handling, not in how the feet move, so the
   * constraint cannot be enabled in one and forgotten in the other.
   *
   * Y is deliberately untouched — the existing ground clamp still owns it —
   * so this changes where the agent may walk, not how it sits on the floor.
   */
  function advance(pos, direction, distance) {
    if (!navmeshProbe) {
      pos.addScaledVector(direction, distance);
      lastNavmeshBlocked = false;
      return;
    }

    const { x, z, blocked } = constrainDisplacementToNavmesh({
      fromX: pos.x,
      fromZ: pos.z,
      fromY: pos.y,
      dx: direction.x * distance,
      dz: direction.z * distance,
      probe: navmeshProbe,
    });

    pos.x = x;
    pos.z = z;
    lastNavmeshBlocked = blocked;

    // Follow the NavMesh elevation while keeping the feet-to-surface offset
    // established when the scene start was applied (or last edited), so an
    // authored start pose keeps its exact grounding and a ramp or step in
    // the NavMesh is followed rather than walked through.
    if (navmeshFollowElevation) {
      const surfaceY = navmeshProbe(x, z, pos.y);
      if (surfaceY !== null && surfaceY !== undefined) {
        pos.y = surfaceY + navmeshFootOffset;
      }
    }
  }

  const sprinting = () => keys.has("ShiftLeft") || keys.has("ShiftRight");

  function readMoveInput(allowVertical) {
    move.set(0, 0, 0);
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    right.crossVectors(forward, camera.up).normalize();
    if (keys.has("KeyW")) move.add(forward);
    if (keys.has("KeyS")) move.sub(forward);
    if (keys.has("KeyD")) move.add(right);
    if (keys.has("KeyA")) move.sub(right);
    if (allowVertical) {
      if (keys.has("KeyE")) move.y += 1;
      if (keys.has("KeyQ")) move.y -= 1;
    }
    if (move.lengthSq() > 0) move.normalize();
  }

  /**
   * Populate `move` for an avatar-bound update: keyboard input first,
   * falling back to the external steering direction (autonomous motor)
   * when no movement keys are held. Returns "keys", "external", or null.
   */
  function resolveMoveInput() {
    readMoveInput(false); // ground-bound; no Q/E vertical
    if (move.lengthSq() > 0) return "keys";
    if (externalMove) {
      move.set(externalMove.x, 0, externalMove.z); // stored normalized
      return "external";
    }
    return null;
  }

  function updateFirst(delta) {
    if (!avatar) {
      // No avatar yet — fall back to free-fly so the player can navigate.
      readMoveInput(true); // allow vertical
      lastMoving = move.lengthSq() > 0;
      lastMoveSource = lastMoving ? "keys" : null;
      if (!lastMoving) return;
      rig.position.addScaledVector(
        move,
        speed * (sprinting() ? sprintMultiplier : 1) * delta,
      );
      return;
    }

    // Avatar-based first-person: WASD moves the avatar exactly as in
    // third-person, but the camera sits at eye level looking through the
    // avatar's eyes rather than orbiting behind it.
    const pos = avatar.object.position;

    const source = resolveMoveInput();
    lastMoveSource = source;
    let moving = source !== null;

    if (moving && collider) {
      if (bodyBlocked(pos, move)) {
        moving = false;
        lastBlocked = true;
      }
    }

    if (moving) {
      // External steering always walks; sprint applies to keyboard only.
      const sprint = source === "keys" && sprinting();
      const s = sprint ? tp.runSpeed : tp.walkSpeed;
      advance(pos, move, s * delta);
      if (source === "keys") {
        // Visual body rotation — face the movement direction. Strafing
        // intentionally diverges from the camera direction while moving.
        applyBodyHeading(move.x, move.z);
      } else {
        // External (brain) steering translates in Seekr's own frame; the eye
        // is the camera and does not move, so the (hidden) body stays aligned
        // with it rather than swinging toward a strafe or backward step.
        syncBodyYawToCamera();
      }
      avatar.setAnimation(sprint ? "run" : "walk");
    } else {
      // Standing still: keep the (hidden) body aligned with the camera so
      // a stationary mouse turn can never leave the visual yaw stale.
      // Eye orientation in FP is read live from the camera, so no eye sync.
      syncBodyYawToCamera();
      avatar.setAnimation("idle");
    }
    lastMoving = moving;

    // Ground clamp — same as third-person.
    if (collider) clampToGround(pos);

    // Park the rig at the avatar's feet so the camera (offset to eyeHeight
    // inside the rig) lands exactly at the avatar's eye position.
    rig.position.copy(pos);
  }

  function updateThird(delta) {
    if (!avatar) return;
    const pos = avatar.object.position;

    // Move the avatar relative to where the camera looks (keyboard), or
    // along the external steering direction (autonomous motor).
    const source = resolveMoveInput();
    lastMoveSource = source;
    let moving = source !== null;
    if (moving && collider) {
      // Body check: shin-to-head rays, so furniture blocks like a wall.
      if (bodyBlocked(pos, move)) {
        moving = false;
        lastBlocked = true;
      }
    }
    if (moving) {
      const sprint = source === "keys" && sprinting();
      const s = sprint ? tp.runSpeed : tp.walkSpeed;
      advance(pos, move, s * delta);

      if (source === "keys") {
        // Manual WASD: the avatar faces where it walks (unchanged).
        // Visual body rotation — same single owner as updateFirst.
        applyBodyHeading(move.x, move.z);

        // ── Authoritative eye yaw (third-person) ──────────────────────────
        // `move` is the camera-relative walk direction.
        // atan2(move.x, move.z) gives the movement yaw measured from world +Z.
        // Adding π converts to Three.js camera convention (0 = facing −Z).
        // This is the ONLY sign/offset applied to the eye yaw.
        _eyeYaw = Math.atan2(move.x, move.z) + Math.PI;
      }
      // External (brain) steering is a semantic TRANSLATION in Seekr's own
      // frame — move_forward / move_backward / strafe_left / strafe_right —
      // so it must not re-point the body or the eye at the walk direction:
      // that would turn strafe_left into "turn 90° left, then walk" and
      // move_backward into "about-face, then walk" for the next ego frame.
      // Heading changes for the brain go through turnBy() only.

      avatar.setAnimation(sprint ? "run" : "walk");
    } else {
      // Third-person orbiting rotates neither the body nor the eye.
      avatar.setAnimation("idle");
    }
    lastMoving = moving;

    // Ground clamp.
    if (collider) clampToGround(pos);

    // Camera boom: sit `distance` metres behind the head along the current
    // look direction (mouse look = orbit), with smoothing.
    head.copy(pos);
    head.y += tp.headHeight;
    // Right-drag pan shifts the boom target, so the camera AND what it looks
    // at move together — the view translates without rotating.
    head.add(panOffset);
    camera.getWorldDirection(forward); // full 3D, including pitch
    let boomLength = tp.distance;
    if (collider) {
      // Camera clip — pull in if something sits between the head and the camera.
      back.copy(forward).negate();
      const hit = collider.blocked(head, back, tp.distance + BOOM_MARGIN);
      if (hit) boomLength = Math.max(0.5, hit.distance - BOOM_MARGIN);
    }
    boomTarget.copy(head).addScaledVector(forward, -boomLength);
    if (snapBoom) {
      rig.position.copy(boomTarget);
      snapBoom = false;
    } else {
      rig.position.lerp(boomTarget, Math.min(1, tp.damping * delta));
    }
  }

  /**
   * Single owner of the avatar's RENDER visibility: hidden in first person,
   * shown in third.
   *
   * Rendering only. The avatar object stays in the scene and keeps being
   * moved, rotated and read exactly as before — position, heading, collision,
   * perception orientation and the eye camera are all untouched. The eye stays
   * at base + eyeHeight (1.6 m) so the sensor pose remains Habitat-comparable.
   *
   * Why this is now needed: the visual body used to render ~1.10 m tall with
   * the eye at 1.60 m, so the camera sat clear above the head and a visible
   * body meant the camera was wrong. At the corrected ~1.50 m stature the head
   * top is only 0.10 m below the eye, so looking down legitimately shows hair.
   * Hiding it is the fix; moving the camera would break sensor parity.
   *
   * Safe alongside the ego-capture hide/restore pairs in capture.js and
   * frameCapture.js: those collect only objects that are currently visible,
   * so an already-hidden avatar is never force-restored to visible.
   */
  function applyAvatarVisibility() {
    if (!avatar?.object) return;
    avatar.object.visible = mode !== "first";
  }

  function setMode(next) {
    if (next === mode && modeApplied) return mode;
    if (next === "third") {
      if (!avatar) return mode; // no character yet — stay in first person
      // Hand-over sync: a stationary FP mouse turn must carry into TP for
      // BOTH the visual body yaw and the perception eye yaw (_eyeYaw), so
      // the avatar faces where the player was looking and getEyeQuaternion
      // stays continuous across the switch.
      syncBodyYawToCamera(true);
      // Preserve Seekr's embodied look pitch before the orbit camera takes
      // ownership of camera.quaternion. Entering TP is the only way to leave
      // FP, so this is the single capture point.
      storeFirstPersonPitch();
      // Third-person perception starts level: the human's first-person look
      // is parked in _fpPitch for the way back, never read as TP perception.
      _tpLookPitch = 0;
      camera.position.set(0, 0, 0); // rig itself becomes the boom origin
      panOffset.set(0, 0, 0); // always enter third person framed on Seekr
      snapBoom = true;
    } else {
      // Switch to first-person: camera sits at eye-height within the rig,
      // rig parked at avatar's feet so the camera lands at eye level.
      camera.position.set(0, eyeHeight, 0);
      // Hand-over sync (orientation): rebuild the eye from AGENT state —
      // Seekr's heading plus his saved look pitch — so third-person's orbit
      // orientation is discarded, never inherited. See
      // applyFirstPersonOrientation().
      applyFirstPersonOrientation();
      if (avatar) {
        rig.position.copy(avatar.object.position);
      } else {
        // No avatar yet — preserve the current world camera position.
        camera.getWorldPosition(worldPos);
        rig.position.set(worldPos.x, worldPos.y - eyeHeight, worldPos.z);
      }
    }
    mode = next;
    modeApplied = true;
    applyAvatarVisibility();
    modeListeners.forEach((fn) => fn(mode));
    return mode;
  }

  function update(delta) {
    // Per-frame input reporting — recomputed by the branch that runs.
    lastBlocked = false;
    lastMoveSource = null;
    // Look before moving, so a movement direction resolved from the camera
    // reflects the orientation the player just asked for.
    applyArrowLook(delta);
    if (mode === "third") updateThird(delta);
    else updateFirst(delta);
  }

  function dispose() {
    domElement.removeEventListener("click", onClick);
    domElement.removeEventListener("wheel", onCameraWheel);
    domElement.removeEventListener("pointerdown", onPanPointerDown);
    domElement.removeEventListener("contextmenu", onPanContextMenu);
    window.removeEventListener("pointermove", onPanPointerMove);
    window.removeEventListener("pointerup", onPanPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    controls.dispose();
  }

  return {
    rig,
    controls,
    update,
    dispose,

    /**
     * Freezes or restores every input this rig owns: pointer-lock look,
     * WASD/QE walking, arrow-key look, the wheel dolly and the right-drag
     * pan.
     *
     * Disabling releases the pointer lock and drops every held key, so a key
     * still down when the freeze began cannot resume walking the moment it is
     * lifted — or, worse, keep walking through the freeze.
     *
     * Pose, heading, view mode, collider and NavMesh constraint are all left
     * exactly as they are: this stops the agent being DRIVEN, and changes
     * nothing about where it stands.
     *
     * @param {boolean} enabled
     */
    setInputEnabled(enabled) {
      inputEnabled = Boolean(enabled);

      // Keys and look move together by default; setLookEnabled() below can
      // then re-open looking on its own, which is what a diagnostic benchmark
      // run needs.
      this.setLookEnabled(inputEnabled);

      if (!inputEnabled) {
        keys.clear();
        panning = false;
      }
    },

    /**
     * Gates MOUSE-LOOK alone.
     *
     * PointerLockControls rotates the camera from its OWN mousemove listener,
     * which none of the handlers here can intercept. It does honour
     * `enabled`, so this is the one deterministic way to stop mouse
     * orientation: unlock() alone leaves a window open, because
     * exitPointerLock() resolves asynchronously.
     *
     * @param {boolean} enabled
     */
    setLookEnabled(enabled) {
      lookEnabled = Boolean(enabled);
      controls.enabled = lookEnabled;
      if (!lookEnabled && controls.isLocked) controls.unlock();
    },

    /** True while mouse-look may rotate the agent. */
    get lookEnabled() {
      return lookEnabled;
    },

    /** True while this rig is accepting input. */
    get inputEnabled() {
      return inputEnabled;
    },

    setMode,
    get mode() {
      return mode;
    },
    setAvatar(a) {
      avatar = a;
      // The avatar is usually assigned AFTER the mode is established, so
      // visibility has to be applied here too — not only on a mode switch.
      applyAvatarVisibility();
    },
    setCollider(c) {
      collider = c;
    },

    /**
     * Enables or disables the "Constrain Avatar to NavMesh" feature.
     *
     * @param {((x: number, z: number, nearY: number) => number|null)|null} probe
     *   NavMesh height probe, or null to leave locomotion unconstrained —
     *   which reproduces the pre-feature behaviour exactly. Independent of
     *   setCollider(): either feature may be on without the other.
     */
    setNavmeshProbe(probe, { followElevation = false, footOffset = 0 } = {}) {
      navmeshProbe = typeof probe === "function" ? probe : null;
      navmeshFollowElevation = Boolean(navmeshProbe) && followElevation;
      navmeshFootOffset = Number.isFinite(footOffset) ? footOffset : 0;
      if (!navmeshProbe) lastNavmeshBlocked = false;
    },

    /** True when the last update()'s move was cut short by the NavMesh edge. */
    get lastNavmeshBlocked() {
      return lastNavmeshBlocked;
    },
    /** Live-tune movement/camera from the UI panel. */
    setTuning({ walkSpeed, runSpeed, distance, flySpeed, eyeHeight: eye, headHeight } = {}) {
      if (walkSpeed !== undefined) tp.walkSpeed = walkSpeed;
      if (runSpeed !== undefined) tp.runSpeed = runSpeed;
      if (distance !== undefined) tp.distance = distance;
      if (flySpeed !== undefined) speed = flySpeed;
      // Eye and head heights follow the avatar's visual scale. In first
      // person the camera IS the eye, so it is re-seated at once; in third
      // person the boom reads tp.headHeight every frame.
      if (eye !== undefined && Number.isFinite(eye)) {
        eyeHeight = eye;
        if (mode === "first") camera.position.set(0, eyeHeight, 0);
      }
      if (headHeight !== undefined && Number.isFinite(headHeight)) {
        tp.headHeight = headHeight;
      }
    },
    /** Notified when the wheel changes the third-person camera distance. */
    onDistanceChange(fn) {
      distanceListeners.add(fn);
      return () => distanceListeners.delete(fn);
    },

    /** The live third-person boom length — the one authoritative value. */
    get cameraDistance() {
      return tp.distance;
    },

    onModeChange(fn) {
      modeListeners.add(fn);
    },

    /** Timestamp (performance.now) of the last movement key or mouse-look input. */
    get lastInputTime() {
      return lastInputTime;
    },

    /** True if the avatar translated during the most recent update() tick. */
    get moving() {
      return lastMoving;
    },

    /**
     * Programmatic steering: set the horizontal direction the
     * avatar walks in during update() while no movement keys are held.
     * Normalized internally; degenerate input clears it and returns false.
     * Keyboard input always takes priority — check `lastMoveSource` after
     * update() to detect an override.
     */
    setExternalMove(x, z) {
      const len = Math.hypot(x, z);
      if (!Number.isFinite(len) || len < 1e-8) {
        externalMove = null;
        return false;
      }
      externalMove = { x: x / len, z: z / len };
      return true;
    },

    /** Remove any external steering direction (ends navigation-driven walking). */
    clearExternalMove() {
      externalMove = null;
    },

    /** True while an external steering direction is set. */
    get hasExternalMove() {
      return externalMove !== null;
    },

    /** True if the last update()'s move attempt was stopped by the collider. */
    get lastBlocked() {
      return lastBlocked;
    },

    /** Input source of the last update()'s move attempt: "keys" | "external" | null. */
    get lastMoveSource() {
      return lastMoveSource;
    },

    /**
     * Authoritative eye-space world quaternion.
     *
     * First-person: live camera world quaternion (yaw + pitch from pointer lock).
     * Third-person:  level quaternion from the avatar's last movement yaw.
     *
     * Returns a new [x, y, z, w] array each call. Use this for perception
     * capture — it is the single source of truth for where the avatar's eye
     * is looking, in both camera modes.
     */
    getEyeQuaternion,
    /**
     * Embodied eye pitch in radians (positive = up), for the view
     * getEyeQuaternion() describes. Gaze proprioception sent with each brain
     * frame; see getEyePitch above.
     */
    getEyePitch,
    getAgentPose,
    setAgentPose,

    /**
     * Rotate Seekr in place. Positive = left (CCW), negative = right.
     * Rotation only — no translation, no collision, no blocked state.
     * Works in both camera modes; see turnBy above.
     */
    turnBy,
    pitchBy,

    /**
     * Current eye yaw in Three.js camera convention (0 = −Z, +π/2 = +X).
     * Readable for diagnostics. Only meaningful in third-person; in first-
     * person the camera quaternion is the authoritative source.
     */
    get eyeYaw() {
      return _eyeYaw;
    },
  };
}
