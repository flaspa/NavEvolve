/**
 * egoRange.js — Gaussian Splat surface distance at the centre of an ego frame.
 *
 * REUSED (pre-hackathon) from flaspa/scavengeai @ 3334d40:
 *   cameraFromSnapshot()   ← src/egocentricRange.js (verbatim)
 *   measurementMetrics()   ← src/sceneMeasure.js (verbatim)
 *   the ranging itself     ← handleMeasurementClick() in src/main.js:
 *                            raycaster.setFromCamera(ndc, camera) +
 *                            raycaster.intersectObject(splatMesh, false),
 *                            i.e. Spark's SplatMesh.raycast() on the visible
 *                            Gaussian surface — no collision mesh, no NavMesh.
 *
 * NEW (hackathon): measureCenterRange() aims that same ray through the centre
 * of a captured ego image, rebuilt from its exact cameraSnapshot.
 */
import * as THREE from "three";

export const RANGE_METHOD = "splat-raycast-center";

/**
 * Rebuild the capture camera from a frameCapture `cameraSnapshot`, so a ray
 * through an image point is the ray the rendered pixel came from.
 *
 * @returns {THREE.PerspectiveCamera|null}  null when the snapshot is unusable
 */
export function cameraFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const { position, quaternion, fov, aspect } = snapshot;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) {
    return null;
  }
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(Number.isFinite)) {
    return null;
  }
  if (!Number.isFinite(fov) || !Number.isFinite(aspect) || aspect <= 0) return null;

  const near = Number.isFinite(snapshot.near) && snapshot.near > 0 ? snapshot.near : 0.05;
  const far = Number.isFinite(snapshot.far) && snapshot.far > near ? snapshot.far : 1000;
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.fromArray(position);
  camera.quaternion.fromArray(quaternion);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/**
 * World-space distance between two points, and the metres it represents.
 *
 *     metres = worldDistance × metersPerUnit / environmentScale
 */
export function measurementMetrics(a, b, { metersPerUnit, environmentScale } = {}) {
  if (!isFinitePoint(a) || !isFinitePoint(b)) {
    throw new Error("[measure] Both measurement points must be finite x/y/z");
  }
  if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) {
    throw new Error(
      `[measure] metersPerUnit must be a finite number greater than 0 (got ${JSON.stringify(metersPerUnit)})`,
    );
  }
  if (!Number.isFinite(environmentScale) || environmentScale <= 0) {
    throw new Error(
      `[measure] environment.scale must be a finite number greater than 0 (got ${JSON.stringify(environmentScale)})`,
    );
  }

  const distanceWorld = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const verticalWorld = Math.abs(b.y - a.y);
  const metersPerWorldUnit = metersPerUnit / environmentScale;

  return {
    distanceWorld,
    verticalWorld,
    distanceMeters: distanceWorld * metersPerWorldUnit,
    verticalMeters: verticalWorld * metersPerWorldUnit,
    metersPerWorldUnit,
  };
}

function isFinitePoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

const _centre = new THREE.Vector2(0, 0);
const _raycaster = new THREE.Raycaster();

/**
 * Distance from the capture eye to the first Gaussian surface under the image
 * centre. Always returns a record; `distanceM`/`point` are null on no hit.
 */
export function measureCenterRange({ splatMesh, cameraSnapshot, metersPerUnit, environmentScale }) {
  const result = { method: RANGE_METHOD, point: null, distanceM: null, distanceWorld: null };
  const camera = cameraFromSnapshot(cameraSnapshot);
  if (!splatMesh || !camera) return { ...result, error: "no splat or camera" };

  let hits = [];
  try {
    _raycaster.setFromCamera(_centre, camera);
    hits = _raycaster.intersectObject(splatMesh, false);
  } catch (err) {
    console.warn("[range] Splat raycast failed:", err);
    return { ...result, error: String(err?.message ?? err) };
  }
  if (!hits.length) return result;

  const p = hits[0].point;
  const m = measurementMetrics(camera.position, p, { metersPerUnit, environmentScale });
  return {
    ...result,
    point: [p.x, p.y, p.z],
    distanceM: +m.distanceMeters.toFixed(3),
    distanceWorld: +m.distanceWorld.toFixed(4),
  };
}
