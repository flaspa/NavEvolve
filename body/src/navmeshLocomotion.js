/**
 * navmeshLocomotion.js — keeps ordinary locomotion on the browser NavMesh.
 *
 * SIMULATOR FEATURE, not benchmark logic. ObjectNav benchmark movement is
 * resolved by native Habitat PathFinder try_step() and never comes through
 * here; this constrains ordinary WASD and the ordinary external-steering path
 * so a scene with no collision mesh is still not walk-through-anything.
 *
 * ── SWEPT, NEVER SNAPPED ──────────────────────────────────────────────────
 * The obvious implementation — "move wherever you asked, then snap to the
 * nearest NavMesh point" — is wrong in a way that looks right: the nearest
 * point to a spot inside a hole, or beyond a railing, is frequently on the
 * far side of it, so the agent teleports across the very gap the NavMesh
 * exists to describe.
 *
 * So the requested displacement is WALKED instead. Short successive positions
 * are tested from the current valid position outward, and the last valid one
 * wins. Nothing is ever snapped, and no position is accepted unless every
 * position leading to it was also valid — which is what makes crossing a hole
 * structurally impossible rather than merely unlikely.
 *
 * ── CHEAP BY CONSTRUCTION ─────────────────────────────────────────────────
 * Substeps are ~5 cm, so the cost scales with distance actually travelled,
 * not with scene size. At 60 fps that is 1 probe at walk speed (1.5 m/s →
 * 25 mm/frame) and 2 at run speed (3.5 m/s → 58 mm/frame). A stationary frame
 * costs zero: no translation, no query. There is no pathfinding, no graph, no
 * whole-mesh scan — just raycasts against the NavMesh's already-cached BVH.
 */

/** Spacing between probes along the requested displacement, in metres. */
export const NAVMESH_SUBSTEP_M = 0.05;

/**
 * Hard ceiling on probes for one displacement.
 *
 * A frame delta can spike arbitrarily (a backgrounded tab, a long GC pause),
 * and an unbounded loop would turn that into a freeze. 32 substeps covers
 * 1.6 m — far beyond any legitimate single frame — after which the remaining
 * displacement is simply refused, which is the safe direction to fail.
 */
export const NAVMESH_MAX_SUBSTEPS = 32;

/**
 * Furthest point along a requested displacement that stays on the NavMesh.
 *
 * Pure: the NavMesh itself arrives as `probe`, so this is testable without
 * geometry, a renderer, or a browser.
 *
 * ── FAIL-OPEN, DELIBERATELY ───────────────────────────────────────────────
 * When there is no probe, or the CURRENT position is not itself on the
 * NavMesh, the displacement is returned unchanged. Two reasons: a scene with
 * no NavMesh loaded must keep behaving exactly as it does today, and an agent
 * already standing somewhere the NavMesh does not describe would otherwise be
 * frozen in place with no way out. If we cannot validate where the agent IS,
 * we cannot meaningfully constrain where it is GOING.
 *
 * @param {object}   params
 * @param {number}   params.fromX   current position, assumed valid
 * @param {number}   params.fromZ
 * @param {number}   params.fromY   used as the vertical reference for probes,
 *   which is what keeps an upstairs agent from being validated against
 *   downstairs geometry
 * @param {number}   params.dx      requested displacement for this frame
 * @param {number}   params.dz
 * @param {(x: number, z: number, nearY: number) => number|null} [params.probe]
 *   Navigable surface height near (x, z) within a bounded band around nearY,
 *   or null when that band contains no NavMesh. `floorHeightAt` in
 *   navmeshQuery.js has exactly this shape.
 * @returns {{x: number, z: number, blocked: boolean, checks: number}}
 *   The furthest valid position, whether the move was cut short, and how many
 *   probes it cost (for diagnostics and for the performance tests).
 */
export function constrainDisplacementToNavmesh({
  fromX,
  fromZ,
  fromY,
  dx,
  dz,
  probe = null,
}) {
  const unconstrained = {
    x: fromX + dx,
    z: fromZ + dz,
    blocked: false,
    checks: 0,
  };

  if (typeof probe !== "function") return unconstrained;

  const distance = Math.hypot(dx, dz);
  // A stationary frame must cost nothing at all.
  if (!(distance > 0)) {
    return { x: fromX, z: fromZ, blocked: false, checks: 0 };
  }

  let checks = 0;

  // Is the agent standing somewhere the NavMesh describes? If not, constrain
  // nothing — see FAIL-OPEN above.
  checks += 1;
  const startY = probe(fromX, fromZ, fromY);
  if (startY === null || startY === undefined) {
    return { ...unconstrained, checks };
  }

  const substeps = Math.min(
    NAVMESH_MAX_SUBSTEPS,
    Math.max(1, Math.ceil(distance / NAVMESH_SUBSTEP_M)),
  );

  let validX = fromX;
  let validZ = fromZ;
  // Each probe is referenced to the last VALID surface height, not to the
  // starting height, so walking a ramp or stair stays validated against the
  // surface actually underfoot.
  let validY = startY;

  for (let step = 1; step <= substeps; step += 1) {
    const t = step / substeps;
    const x = fromX + dx * t;
    const z = fromZ + dz * t;

    checks += 1;
    const y = probe(x, z, validY);

    // First invalid position ends the move. The previous one is kept — never
    // the requested one, and never anything beyond the gap.
    if (y === null || y === undefined) {
      return { x: validX, z: validZ, blocked: true, checks };
    }

    validX = x;
    validZ = z;
    validY = y;
  }

  // Every substep was navigable, including the last: the full move stands.
  return { x: validX, z: validZ, blocked: false, checks };
}
