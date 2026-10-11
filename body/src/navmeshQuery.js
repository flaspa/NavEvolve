/**
 * navmeshQuery.js — spatial queries against the NavMesh.
 *
 * The NavMesh answers "where may Seekr stand?". It is NOT obstacle geometry:
 * nothing here builds a player collider, and none of these functions is wired
 * to `Collision enabled`. Seekr moves to the NavMesh; the NavMesh never moves
 * to Seekr.
 *
 * ── WHICH NAVMESH THIS IS ─────────────────────────────────────────────────
 * These queries run against `<scene>.navmesh.glb`, our browser-readable
 * geometric conversion, used for visualization and lightweight point queries.
 * The native Habitat `<scene>.navmesh` remains the future authority for
 * Habitat-compatible pathfinding and evaluation.
 *
 * This is deliberately NOT a reimplementation of Habitat-Sim
 * `PathFinder.snap_point()`. It is a closest-point-on-triangle-soup query and
 * makes no claim to reproduce Habitat's navigation semantics (island handling,
 * agent radius, edge margins). Benchmark work will use the official API.
 *
 * ── IMMUTABILITY ──────────────────────────────────────────────────────────
 * No function here writes to a mesh's position/quaternion/scale, nor to its
 * geometry attributes. BVH acceleration structures are held in a WeakMap
 * keyed by geometry rather than assigned onto it, so the NavMesh objects are
 * left exactly as loaded.
 */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

/**
 * A start pose whose Y is within this of the NavMesh surface is accepted
 * as-is. Sized for float/export noise and modelling slop, not for silently
 * relocating a curated pose — 5 cm, deliberately small and testable.
 */
export const NAVMESH_Y_TOLERANCE = 0.05;

/**
 * How far a resolved STARTUP pose may be nudged onto the navigable surface.
 *
 * Deliberately small: this exists to absorb authoring slop, float noise and
 * export/conversion drift — never to find a different place to spawn. A start
 * further off than this is a scene-configuration problem, so it is reported
 * and left alone rather than silently relocated.
 */
export const START_NAVMESH_SNAP_MAX_DISTANCE = 0.25;

/**
 * Vertical band searched around a candidate position when asking "what is the
 * floor here?". Bounded rather than infinite so that, in a multi-level scene,
 * the probe finds the surface at the agent's own level instead of the topmost
 * one in the building.
 */
export const NAVMESH_PROBE_UP = 1.5;
export const NAVMESH_PROBE_DOWN = 1.5;

// Acceleration structures, cached off-object so geometry stays untouched.
const bvhCache = new WeakMap();

const _ray = new THREE.Ray();
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();
const _local = new THREE.Vector3();
const _world = new THREE.Vector3();
const _hit = {};
const _mat = new THREE.Matrix4();

function bvhFor(geometry) {
  let bvh = bvhCache.get(geometry);
  if (!bvh) {
    bvh = new MeshBVH(geometry);
    bvhCache.set(geometry, bvh);
  }
  return bvh;
}

/** Refreshes cached world matrices without touching any local transform. */
function refreshMatrices(meshes) {
  for (const mesh of meshes) mesh.updateWorldMatrix(true, false);
}

function usable(meshes) {
  return Array.isArray(meshes) && meshes.length > 0;
}

/**
 * Height of the navigable surface near (x, z), searching a bounded vertical
 * band around `nearY`. Returns null when the band contains no NavMesh.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {number} x
 * @param {number} z
 * @param {object} [options]
 * @param {number} [options.nearY]  level to search around (default: far above)
 * @returns {number|null} world-space Y, or null
 */
export function floorHeightAt(meshes, x, z, { nearY = null } = {}) {
  if (!usable(meshes)) return null;
  refreshMatrices(meshes);

  // No level given: fall back to a wide top-down probe (single-floor scenes
  // and the legacy spawn search rely on this).
  const fromY = nearY === null ? 1000 : nearY + NAVMESH_PROBE_UP;
  const maxDrop =
    nearY === null ? 2000 : NAVMESH_PROBE_UP + NAVMESH_PROBE_DOWN;

  _origin.set(x, fromY, z);

  let bestY = null;
  let bestDistance = Infinity;

  for (const mesh of meshes) {
    if (!mesh.geometry) continue;

    // Ray is taken into geometry-local space and the hit brought back out.
    _mat.copy(mesh.matrixWorld).invert();
    _ray.origin.copy(_origin).applyMatrix4(_mat);
    _ray.direction.copy(_down).transformDirection(_mat).normalize();

    // DoubleSide explicitly: a navigable surface is walkable from above
    // regardless of triangle winding, and this query must not depend on
    // whichever material the visualization layer happens to have set.
    const hits = bvhFor(mesh.geometry).raycast(
      _ray,
      THREE.DoubleSide,
      0,
      maxDrop,
    );

    for (const hit of hits) {
      _world.copy(hit.point).applyMatrix4(mesh.matrixWorld);
      const distance = _origin.distanceTo(_world);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestY = _world.y;
      }
    }
  }

  return bestY;
}

/**
 * Genuine 3D closest point on the NavMesh surface.
 *
 * Uses true surface distance rather than "nearest in X/Z", so in a multi-level
 * scene a point on the upper floor snaps to the upper floor: the query point's
 * own Y disambiguates which surface is actually closest.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {THREE.Vector3} point   world-space query point
 * @returns {{point: THREE.Vector3, distance: number}|null}
 */
export function closestPointOnNavmesh(meshes, point) {
  if (!usable(meshes)) return null;
  refreshMatrices(meshes);

  let best = null;

  for (const mesh of meshes) {
    if (!mesh.geometry) continue;

    // BVH works in geometry-local space, so bring the query point in and take
    // the result back out. Distance is measured in WORLD space so a scaled
    // NavMesh cannot skew the comparison between meshes.
    _local.copy(point).applyMatrix4(
      _mat.copy(mesh.matrixWorld).invert(),
    );

    const result = bvhFor(mesh.geometry).closestPointToPoint(_local, _hit);
    if (!result) continue;

    _world.copy(result.point).applyMatrix4(mesh.matrixWorld);
    const distance = _world.distanceTo(point);

    if (!best || distance < best.distance) {
      best = { point: _world.clone(), distance };
    }
  }

  return best;
}

/**
 * Is this world-space point on the navigable surface, within `tolerance`?
 *
 * @param {THREE.Mesh[]} meshes
 * @param {THREE.Vector3} point
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function isPointOnNavmesh(meshes, point, tolerance = NAVMESH_Y_TOLERANCE) {
  const nearest = closestPointOnNavmesh(meshes, point);
  return nearest !== null && nearest.distance <= tolerance;
}

/**
 * Full 3D projection onto the navigable surface — the nearest navigable point,
 * horizontal component included.
 *
 * ── AUTHORING vs BENCHMARK ────────────────────────────────────────────────
 * This is the BENCHMARK/navigation primitive, kept for future deterministic
 * motion: Habitat-compatible stepping, constrained WASD experiments, and any
 * explicit "move me to the nearest navigable point" tool.
 *
 * It is deliberately NOT wired to the authoring UI. The authoring action
 * ("Align Feet to NavMesh") is Y-only, because a projection that also slides
 * Seekr horizontally fights the X/Z sliders the author is using to place him.
 *
 * @returns {{point: THREE.Vector3, distance: number}|null} null with no NavMesh
 */
export function findNearestNavigablePoint(meshes, point) {
  return closestPointOnNavmesh(meshes, point);
}

/**
 * One-shot validation of a resolved STARTUP pose against the NavMesh.
 *
 * Position only — the caller's heading is never read, so it cannot change.
 *
 * Reusable by design: it takes a bare position, so a future restored
 * same-scene session pose can be validated through this identical path
 * without duplicating any NavMesh logic.
 *
 * Uses the genuine 3D nearest-point query, so on a multi-level scene the
 * pose's own height disambiguates which surface is closest — never "any
 * polygon with the same X/Z".
 *
 *   no NavMesh                  -> unchanged, no error
 *   already on the surface      -> unchanged, so float noise cannot nudge a
 *                                  verified pose
 *   slightly off (<= maxSnap)   -> corrected to the nearby navigable point
 *   further off                 -> UNCHANGED and reported; a bad authored
 *                                  start must stay visible, not be hidden
 *
 * This runs once, when a startup pose is chosen. It establishes no ongoing
 * constraint: nothing re-projects the agent afterwards.
 *
 * @param {THREE.Mesh[]} meshes
 * @param {number[]} position  [x, y, z] resolved start position
 * @param {object} [options]
 * @param {number} [options.tolerance]        "already on the surface" radius
 * @param {number} [options.maxSnapDistance]  largest correction allowed
 * @returns {{status: "no-navmesh"|"on-navmesh"|"snapped"|"too-far",
 *            position: number[], distance: number|null,
 *            nearest: {point: THREE.Vector3, distance: number}|null}}
 */
export function validateStartPose(
  meshes,
  position,
  {
    tolerance = NAVMESH_Y_TOLERANCE,
    maxSnapDistance = START_NAVMESH_SNAP_MAX_DISTANCE,
  } = {},
) {
  const [x, y, z] = position;
  // Copied, so a caller mutating the result can never reach the profile the
  // position came from.
  const unchanged = [x, y, z];

  if (!usable(meshes)) {
    return {
      status: "no-navmesh",
      position: unchanged,
      distance: null,
      nearest: null,
    };
  }

  const nearest = closestPointOnNavmesh(meshes, new THREE.Vector3(x, y, z));

  if (!nearest) {
    return {
      status: "no-navmesh",
      position: unchanged,
      distance: null,
      nearest: null,
    };
  }

  if (nearest.distance <= tolerance) {
    // Effectively on the surface already — keep the authored numbers exactly.
    return {
      status: "on-navmesh",
      position: unchanged,
      distance: nearest.distance,
      nearest,
    };
  }

  if (nearest.distance <= maxSnapDistance) {
    return {
      status: "snapped",
      position: [nearest.point.x, nearest.point.y, nearest.point.z],
      distance: nearest.distance,
      nearest,
    };
  }

  return {
    status: "too-far",
    position: unchanged,
    distance: nearest.distance,
    nearest,
  };
}
