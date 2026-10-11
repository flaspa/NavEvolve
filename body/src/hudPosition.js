/**
 * hudPosition.js — HUD position read-out formatting.
 *
 * Display/debug only. Nothing here owns state or influences simulation — the
 * numbers are read from the existing authoritative sources every frame:
 *
 *   Seekr floorplan position → avatar.object.position
 *       Written by BOTH updateFirst() and updateThird() in player.js (the rig
 *       is parked onto it in first-person), so it is mode-independent: it
 *       changes only when Seekr actually walks, never on a camera-mode switch.
 *       Projected to the horizontal floor plane — x and z only.
 *
 *   Active camera position → camera.getWorldPosition()
 *       The real world position of whichever camera is live. In third-person
 *       this sits behind/above Seekr (the boom), so its x/z legitimately
 *       differ from Seekr's; in first-person it sits at Seekr's x/z with y at
 *       eye height.
 *
 * The two used to share one "pos [x, y, z]" line that silently switched
 * source with the camera mode, which made it impossible to tell whether a
 * coordinate described Seekr or the camera.
 */

/** Decimal places for HUD coordinates. */
export const COORD_PRECISION = 2;

/**
 * Format one coordinate. Non-finite values (NaN before the world loads, or a
 * missing source) render as an em dash rather than "NaN".
 *
 * @param {number} value
 * @returns {string}
 */
export function formatCoordinate(value) {
  return Number.isFinite(value) ? value.toFixed(COORD_PRECISION) : "—";
}

/**
 * Seekr's position projected onto the horizontal floor plane.
 *
 * @returns {string} e.g. "Seekr Floorplan Pos [x: 3.36, z: 4.12]"
 */
export function formatFloorplanPosition(x, z) {
  return `Seekr Floorplan Pos [x: ${formatCoordinate(x)}, z: ${formatCoordinate(z)}]`;
}

/**
 * Label for the active camera read-out.
 *
 * @param {"first"|"third"} mode  player.mode
 * @returns {string}
 */
export function cameraLabelForMode(mode) {
  return mode === "third" ? "Third Person View Camera" : "Eye Level Camera Pos";
}

/**
 * Active camera world position, labelled by camera mode.
 *
 * @returns {string} e.g. "Third Person View Camera [x: 1.20, y: 2.85, z: 5.90]"
 */
export function formatCameraPosition(mode, x, y, z) {
  return (
    `${cameraLabelForMode(mode)} ` +
    `[x: ${formatCoordinate(x)}, y: ${formatCoordinate(y)}, z: ${formatCoordinate(z)}]`
  );
}
