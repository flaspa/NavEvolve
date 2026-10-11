/**
 * navmeshFootprint.js — the walkable area of the browser NavMesh, flattened
 * to a top-down 2D outline for the minimap.
 *
 * ── DIAGNOSTIC VISUALIZATION ONLY ─────────────────────────────────────────
 * This reads `<scene>.navmesh.glb`, the browser-readable geometric conversion
 * used for locomotion support and debug drawing. It is NOT an evaluator
 * authority and never becomes one:
 *
 *   - the native Habitat `<scene>.navmesh` remains the sole authority for
 *     geodesic EVALUATION. It does not resolve benchmark translation either:
 *     Seekr executes benchmark movement directly in his own runtime frame;
 *   - nothing here plans a path, snaps a pose, answers a distance, or
 *     influences movement of any kind;
 *   - nothing here is sent to the brain, so Qwen never sees the map it is
 *     supposed to be solving ObjectNav without.
 *
 * It answers exactly one question, for a human looking at the TOP VIEW:
 * "does the NavMesh actually contain a hole around that furniture, or does it
 * consider the whole region walkable?"
 *
 * ── WHY A FOOTPRINT AND NOT A WIREFRAME ───────────────────────────────────
 * Drawing every triangle edge of a navmesh at minimap scale produces an
 * unreadable hatch in which a real hole is indistinguishable from dense
 * tessellation. So the triangles are filled as ONE region — internal edges
 * vanish into the fill, and the only ink left is where the surface genuinely
 * ends. Holes stay holes because no triangle covers them.
 *
 * Filling a union of triangles with the nonzero winding rule only works if
 * they all wind the same way once projected, which a mesh does not guarantee
 * (a down-facing triangle flips when its Y is dropped). Every triangle is
 * therefore rewound to positive projected area before it is emitted; two
 * opposite windings would otherwise cancel and punch a fake hole.
 *
 * ── THE OUTLINE ───────────────────────────────────────────────────────────
 * Boundary edges — the edges belonging to exactly one triangle — are the
 * true silhouette of the walkable surface, outer border and hole rims alike.
 * They are found in 3D, before projection, so two floors stacked in Y are not
 * welded into one sheet by the flattening.
 */
import * as THREE from "three";

/**
 * Vertex welding tolerance for edge matching, in metres.
 *
 * GLTF exports routinely duplicate shared vertices, so adjacency has to be
 * recovered by position rather than by index. 0.1 mm is far below any real
 * navmesh feature and far above float round-trip noise.
 */
export const FOOTPRINT_WELD_EPSILON = 1e-4;

/**
 * Smallest projected triangle area kept, in square metres.
 *
 * A near-vertical triangle collapses to a sliver from above and contributes
 * nothing but spurious boundary edges.
 */
export const FOOTPRINT_MIN_AREA = 1e-9;

/**
 * Above this ratio of boundary edges to triangles the mesh is too poorly
 * welded for the outline to mean anything, and drawing it would recreate the
 * exact hatch the fill exists to avoid. The fill is still correct, so only
 * the outline is dropped.
 */
export const FOOTPRINT_OUTLINE_MAX_RATIO = 1.5;

/** Distinct footprints get distinct ids, so consumers can cache on one. */
let nextRevision = 1;

const weldKey = (v) => Math.round(v / FOOTPRINT_WELD_EPSILON);

/**
 * Builds a footprint from flat WORLD-SPACE triangle vertices.
 *
 * Pure: no Three.js objects, no DOM, no scene — `positions` is
 * [x0,y0,z0, x1,y1,z1, x2,y2,z2, …], nine numbers per triangle.
 *
 * @param {ArrayLike<number>} positions
 * @returns {{
 *   revision: number,
 *   triangleCount: number,
 *   triangles: Float32Array,
 *   outline: Float32Array,
 *   outlineReliable: boolean,
 *   bounds: {minX: number, maxX: number, minZ: number, maxZ: number},
 * } | null} null when there is nothing walkable to draw
 */
export function footprintFromTriangles(positions) {
  if (!positions || positions.length < 9) return null;

  const triangles = [];
  // Edge key → [count, x0, z0, x1, z1]. Counted in 3D, drawn in 2D.
  const edges = new Map();

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const triCount = Math.floor(positions.length / 9);

  for (let t = 0; t < triCount; t += 1) {
    const o = t * 9;
    const ax = positions[o];
    const ay = positions[o + 1];
    const az = positions[o + 2];
    const bx = positions[o + 3];
    const by = positions[o + 4];
    const bz = positions[o + 5];
    const cx = positions[o + 6];
    const cy = positions[o + 7];
    const cz = positions[o + 8];

    if (
      !Number.isFinite(ax) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cz)
    ) {
      continue;
    }

    // Twice the signed projected area. The sign is the winding; the magnitude
    // says whether anything is actually covered when seen from above.
    const twiceArea = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(twiceArea) * 0.5 < FOOTPRINT_MIN_AREA) continue;

    // Rewound to positive projected area so the whole soup fills as a union.
    if (twiceArea < 0) {
      triangles.push(ax, az, cx, cz, bx, bz);
    } else {
      triangles.push(ax, az, bx, bz, cx, cz);
    }

    const corners = [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ];

    for (let e = 0; e < 3; e += 1) {
      const p = corners[e];
      const q = corners[(e + 1) % 3];
      const kp = `${weldKey(p[0])},${weldKey(p[1])},${weldKey(p[2])}`;
      const kq = `${weldKey(q[0])},${weldKey(q[1])},${weldKey(q[2])}`;
      // Undirected: an edge shared by two triangles arrives once each way.
      const id = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const seen = edges.get(id);
      if (seen) seen[0] += 1;
      else edges.set(id, [1, p[0], p[2], q[0], q[2]]);
    }

    for (const [x, z] of [
      [ax, az],
      [bx, bz],
      [cx, cz],
    ]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }

  if (!triangles.length) return null;

  const outline = [];
  for (const edge of edges.values()) {
    if (edge[0] === 1) outline.push(edge[1], edge[2], edge[3], edge[4]);
  }

  const triangleCount = triangles.length / 6;

  return {
    revision: nextRevision++,
    triangleCount,
    triangles: Float32Array.from(triangles),
    outline: Float32Array.from(outline),
    outlineReliable:
      outline.length / 4 <= triangleCount * FOOTPRINT_OUTLINE_MAX_RATIO,
    bounds: { minX, maxX, minZ, maxZ },
  };
}

/**
 * Footprint of the NavMesh meshes ALREADY LOADED for the active scene.
 *
 * Reuses the meshes world.js is holding — there is no second loader and no
 * second network fetch; the geometry is read out of the objects that are in
 * the scene graph right now.
 *
 * READ-ONLY by contract, exactly like navmeshQuery.js: world matrices are
 * refreshed (which writes no local transform) and vertices are copied out.
 * Nothing here re-parents, re-transforms or disposes a NavMesh.
 *
 * Vertices are taken through `matrixWorld`, so the footprint is expressed in
 * the same world coordinates Seekr's pose is — the scene rotation, scale and
 * offset in CONFIG.environment are already baked in.
 *
 * @param {THREE.Mesh[]} meshes
 */
export function projectNavmeshFootprint(meshes) {
  if (!Array.isArray(meshes) || meshes.length === 0) return null;

  const positions = [];
  const vertex = new THREE.Vector3();

  for (const mesh of meshes) {
    const geometry = mesh?.geometry;
    const attribute = geometry?.getAttribute?.("position");
    if (!attribute) continue;

    mesh.updateWorldMatrix(true, false);
    const matrix = mesh.matrixWorld;
    const index = geometry.getIndex?.() ?? null;
    const count = index ? index.count : attribute.count;

    for (let i = 0; i + 2 < count; i += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const at = index ? index.getX(i + corner) : i + corner;
        vertex.fromBufferAttribute(attribute, at).applyMatrix4(matrix);
        positions.push(vertex.x, vertex.y, vertex.z);
      }
    }
  }

  return footprintFromTriangles(positions);
}
