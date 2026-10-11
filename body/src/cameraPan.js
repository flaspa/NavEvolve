/**
 * cameraPan.js — third-person inspection-pan math.
 *
 * Pan TRANSLATES the view; it never rotates it. Left-mouse orbit already owns
 * rotation (pointer-lock mouse-look driving `camera.quaternion`, which the
 * third-person boom follows), and nothing here touches that.
 *
 * The scale rule is Three.js OrbitControls' own: the world moves with the
 * cursor, and a given pixel drag covers the same on-screen distance whatever
 * the boom length or field of view. Dragging right moves the camera left, so
 * the scene appears to follow the pointer.
 *
 * OrbitControls itself is disposed once the player takes over the camera, so
 * its pan cannot simply be reused — this is the same formula applied to the
 * boom rig.
 */

const DEG2RAD = Math.PI / 180;

/**
 * How far to translate along the camera's local right and up axes for one
 * mouse-move delta.
 *
 * @param {object} args
 * @param {number} args.movementX       pointer delta in pixels
 * @param {number} args.movementY       pointer delta in pixels
 * @param {number} args.distance        boom length (metres)
 * @param {number} args.fovDeg          camera vertical FOV
 * @param {number} args.viewportHeight  canvas height in pixels
 * @returns {{right: number, up: number}} metres along each camera axis
 */
export function panScalars({
  movementX,
  movementY,
  distance,
  fovDeg,
  viewportHeight,
}) {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return { right: 0, up: 0 };
  }
  if (!Number.isFinite(movementX) || !Number.isFinite(movementY)) {
    return { right: 0, up: 0 };
  }

  // Half-height of the view frustum at the target's depth: the metres of world
  // that fill half the screen. Scaling by it keeps the drag 1:1 with content.
  const targetHalfHeight = distance * Math.tan((fovDeg / 2) * DEG2RAD);
  const perPixel = (2 * targetHalfHeight) / viewportHeight;

  return {
    // Negative: dragging right slides the camera left, so the world tracks
    // the cursor — the OrbitControls convention.
    right: -movementX * perPixel,
    up: movementY * perPixel,
  };
}
