/**
 * agentPose.js — Seekr's start-pose representation and heading conversions.
 *
 * Two representations, deliberately:
 *
 *   headingDeg   human-facing. What a curated scene entry stores, what the
 *                Controls panel shows, what P copies to the clipboard.
 *   Quaternion   runtime/authoritative. What setAgentPose() consumes, so a
 *                Habitat episode's start_rotation can be applied directly
 *                without a degrees round-trip.
 *
 * All conversion math lives here so UI, player and scene startup cannot drift
 * apart. Rotation is about world Y only: Seekr is an upright walking agent, so
 * pitch and roll are camera/view concerns and never part of the agent heading.
 *
 * ── HEADING CONVENTION ────────────────────────────────────────────────────
 * Taken from Seekr's existing forward convention, not invented here:
 * applyBodyHeading() sets rotation.y = atan2(dir.x, dir.z), i.e. heading is
 * measured from world +Z. A model authored facing +Z (Soldier.glb,
 * facingOffset 0) rotated by θ about Y therefore faces (sin θ, 0, cos θ):
 *
 *     0°   → +Z   (0, 0, +1)
 *    90°   → +X   (+1, 0, 0)
 *   180°   → −Z   (0, 0, −1)
 *   270°   → −X   (−1, 0, 0)
 *
 * Range is [0, 360). Exactly 360 normalizes to 0 — the same orientation.
 */
import * as THREE from "three";

/** World up. Agent heading is rotation about this axis and nothing else. */
export const UP = Object.freeze(new THREE.Vector3(0, 1, 0));

/** Reference forward: heading 0° faces world +Z. */
export const FORWARD = Object.freeze(new THREE.Vector3(0, 0, 1));

/** Wraps any finite degree value into [0, 360). 360 → 0. */
export function normalizeHeadingDeg(deg) {
  if (!Number.isFinite(deg)) return NaN;
  // Already in range: return it untouched. The modulo below is exact for
  // most values but not all (84.6 comes back as 84.60000000000002), and a
  // curated start pose should survive the pipeline bit-for-bit.
  if (deg >= 0 && deg < 360) return deg;
  return ((deg % 360) + 360) % 360;
}

/**
 * headingDeg → authoritative agent quaternion (rotation about world Y).
 *
 * @param {number} deg
 * @returns {THREE.Quaternion}
 */
export function headingDegToQuaternion(deg) {
  const radians = THREE.MathUtils.degToRad(normalizeHeadingDeg(deg));
  return new THREE.Quaternion().setFromAxisAngle(UP, radians);
}

/**
 * Authoritative agent quaternion → headingDeg in [0, 360).
 *
 * Projects the rotated forward vector onto the floor plane, so a quaternion
 * carrying pitch/roll (e.g. straight from a Habitat episode) still yields a
 * sane floor-plane heading rather than NaN.
 *
 * @param {THREE.Quaternion} quaternion
 * @returns {number} degrees, or NaN if the heading is degenerate
 */
export function quaternionToHeadingDeg(quaternion) {
  const dir = FORWARD.clone().applyQuaternion(quaternion);
  dir.y = 0;
  if (dir.lengthSq() < 1e-12) return NaN; // looking straight up/down: no heading
  return normalizeHeadingDeg(THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z)));
}

/**
 * Validates a curated scene `defaultStart` entry.
 * Shape: { position: [x, y, z], headingDeg: number }
 */
export function isValidDefaultStart(start) {
  if (!start || typeof start !== "object") return false;
  const { position, headingDeg } = start;
  if (!Array.isArray(position) || position.length !== 3) return false;
  if (!position.every((v) => Number.isFinite(v))) return false;
  return Number.isFinite(headingDeg);
}

/**
 * Chooses the startup pose: a validated scene `defaultStart` wins, otherwise
 * the caller's legacy spawn. Pure, so startup selection is testable without
 * a browser.
 *
 * @param {object|null} scene     registry entry (may be null for ad-hoc scenes)
 * @param {{position: number[], headingDeg?: number|null}} fallback
 * @returns {{position: number[], headingDeg: number|null, source: "scene"|"fallback"}}
 */
export function resolveStartPose(scene, fallback) {
  const start = scene?.defaultStart ?? null;

  if (isValidDefaultStart(start)) {
    return {
      position: [...start.position],
      headingDeg: normalizeHeadingDeg(start.headingDeg),
      source: "scene",
    };
  }

  return {
    position: [...fallback.position],
    headingDeg: Number.isFinite(fallback.headingDeg) ? fallback.headingDeg : null,
    source: "fallback",
  };
}

/**
 * One-line human report of where Seekr is right now.
 *
 * Purely observational — this is what P shows. It records nothing.
 *
 * @returns {string} e.g. "X 3.278 · Y 0.200 · Z 0.992 · Heading 182.6°"
 */
export function formatPoseReport(position, headingDeg) {
  return (
    `X ${position.x.toFixed(3)} · ` +
    `Y ${position.y.toFixed(3)} · ` +
    `Z ${position.z.toFixed(3)} · ` +
    `Heading ${normalizeHeadingDeg(headingDeg).toFixed(1)}°`
  );
}

/**
 * Serializes a captured pose as a snippet that can be pasted straight into a
 * scene entry in src/config/scenes.js.
 *
 * Position keeps 6 decimals (sub-millimetre); heading keeps 1, matching the
 * Controls read-out. This is Seekr's BASE position and a heading derived from
 * his authoritative quaternion — never the eye camera or the orbit camera.
 */
export function formatDefaultStart(position, headingDeg) {
  const xyz = [position.x, position.y, position.z]
    .map((v) => v.toFixed(6))
    .join(", ");

  return (
    `defaultStart: {\n` +
    `  position: [${xyz}],\n` +
    `  headingDeg: ${normalizeHeadingDeg(headingDeg).toFixed(1)},\n` +
    `}`
  );
}
