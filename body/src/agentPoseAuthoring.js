/**
 * agentPoseAuthoring.js — pure helpers behind the AGENT POSE authoring
 * controls (X/Y/Z sliders and Reset to Scene Start).
 *
 * Two rules shape everything here:
 *
 *   1. Moving Seekr is not authoring. WASD, the XYZ sliders, the Heading
 *      slider, Snap and Reset all move the puppet and NOTHING else — they
 *      never touch the scene profile draft and never mark it dirty. Only P
 *      records a pose as the scene start.
 *
 *   2. A position edit is position-only. Each helper hands back a position
 *      and leaves orientation to the caller, so the authoritative quaternion
 *      is preserved by construction rather than by remembering to re-apply it.
 */

/**
 * Authoring headroom around the scene bounds, in metres. Seekr must be able
 * to leave the navigable volume deliberately — lifting him above the floor is
 * how "Snap to NavMesh" gets tested.
 */
export const AGENT_BOUNDS_MARGIN = 2;

/** Last-resort half-extent when a scene exposes no usable geometry at all. */
export const AGENT_BOUNDS_FALLBACK = 10;

/**
 * Slider bounds for the three position axes, derived from scene geometry
 * rather than a fixed global range — scenes differ far too much in extent for
 * one range to be usable.
 *
 * Bounds are in the same world/navigation frame as the agent's base position.
 * The Gaussian visualOffset frame is deliberately not involved.
 *
 * @param {THREE.Box3|null} box  navmesh bounds preferred, else world geometry
 * @param {object} [options]
 * @param {number} [options.margin]
 * @param {{x: number, y: number, z: number}} [options.around]  fallback centre
 * @returns {{x: {min: number, max: number},
 *            y: {min: number, max: number},
 *            z: {min: number, max: number}}}
 */
export function agentSliderBounds(box, { margin = AGENT_BOUNDS_MARGIN, around = null } = {}) {
  if (!box || box.isEmpty?.()) {
    const c = around ?? { x: 0, y: 0, z: 0 };
    const r = AGENT_BOUNDS_FALLBACK;
    return {
      x: { min: c.x - r, max: c.x + r },
      y: { min: c.y - r, max: c.y + r },
      z: { min: c.z - r, max: c.z + r },
    };
  }

  return {
    x: { min: box.min.x - margin, max: box.max.x + margin },
    y: { min: box.min.y - margin, max: box.max.y + margin },
    z: { min: box.min.z - margin, max: box.max.z + margin },
  };
}

/**
 * The position that results from changing ONE axis, as a plain triple.
 *
 * Returns a fresh object: the caller's live pose vector is never written
 * through, and the two untouched components are carried across bit-for-bit.
 *
 * @param {{x: number, y: number, z: number}} position  current base position
 * @param {"x"|"y"|"z"} axis
 * @param {number} value
 * @returns {{x: number, y: number, z: number}}
 */
export function withAxis(position, axis, value) {
  if (!["x", "y", "z"].includes(axis)) {
    throw new Error(`[agentPoseAuthoring] Unknown axis "${axis}"`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`[agentPoseAuthoring] Axis ${axis} needs a finite value`);
  }

  return {
    x: position.x,
    y: position.y,
    z: position.z,
    [axis]: value,
  };
}

/**
 * Resolves what "Reset to Scene Start" should restore.
 *
 * Reads the CURRENT in-memory draft, not the file on disk: after P records a
 * new start, Reset must return to that new pose even though it has not been
 * exported yet. A reload rebuilds the draft from scene.seekr.json, at which
 * point Reset goes back to the on-disk pose.
 *
 * Reset is "the exact authored start", never "the nearest navigable point" —
 * it deliberately does not consult the NavMesh.
 *
 * @param {{profile: object}|null} draft
 * @returns {{ok: true, position: number[], headingDeg: number} |
 *           {ok: false, reason: string}}
 */
export function resetTargetFromDraft(draft) {
  const start = draft?.profile?.defaultStart ?? null;

  if (!start) {
    return { ok: false, reason: "No scene start defined" };
  }

  const { position, headingDeg } = start;
  const valid =
    Array.isArray(position) &&
    position.length === 3 &&
    position.every((n) => Number.isFinite(n)) &&
    Number.isFinite(headingDeg);

  if (!valid) {
    return { ok: false, reason: "Scene start is malformed" };
  }

  // Copied, so a caller cannot mutate the draft through the returned value.
  return { ok: true, position: [...position], headingDeg };
}
