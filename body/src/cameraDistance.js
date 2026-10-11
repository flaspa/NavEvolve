/**
 * cameraDistance.js — third-person camera dolly distance.
 *
 * One authoritative value, `tp.distance` in player.js, written by BOTH the
 * Controls "Camera" slider and the mouse wheel. The limits live here so the
 * two inputs cannot drift apart: the slider is built from them and the wheel
 * clamps to them.
 *
 * This is a dolly, not a zoom — the camera moves along the boom; the field of
 * view is never touched.
 */

/** Shared limits for the third-person boom length, in metres. */
export const CAMERA_DISTANCE = Object.freeze({
  min: 1,
  max: 12,
  step: 0.1,
});

/**
 * The distance after one wheel notch.
 *
 * Uses `Math.sign` rather than the raw delta: trackpads and mice report wildly
 * different magnitudes, and multiplying those into metres makes the dolly
 * unpredictable. One notch is one slider step, in either direction.
 *
 * Wheel UP (negative deltaY, per the DOM convention) moves the camera CLOSER.
 *
 * @param {number} current  metres
 * @param {number} deltaY   WheelEvent.deltaY
 * @param {{min: number, max: number, step: number}} [limits]
 * @returns {number} the clamped new distance
 */
export function nextCameraDistance(current, deltaY, limits = CAMERA_DISTANCE) {
  if (!Number.isFinite(current)) return limits.min;
  if (!Number.isFinite(deltaY) || deltaY === 0) return current;

  // deltaY > 0 is a downward scroll, which pushes the camera farther out.
  const next = current + Math.sign(deltaY) * limits.step;

  // Snap to the step grid so repeated notches cannot accumulate float noise
  // (1.5 + 0.1 = 1.6000000000000001), which would make the slider jitter.
  const snapped = Math.round(next / limits.step) * limits.step;

  return Math.min(limits.max, Math.max(limits.min, +snapped.toFixed(6)));
}
