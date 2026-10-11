/**
 * sceneName.js — human-friendly scene name for the HUD.
 *
 * Display only. The source of truth is the active scene's filename (the
 * bundled asset's basename at startup, the picked File.name after a runtime
 * replacement) — never PLY metadata, which this project does not parse.
 *
 * The lower WORLD ASSETS panel keeps showing the exact filename; this is the
 * cleaned-up version for the upper-left HUD.
 */

/**
 * Last path segment of an asset URL, for display.
 *
 * Optional assets are registered as null — a scene may legitimately ship a
 * splat and a navmesh but no obstacle collider — so this returns null instead
 * of throwing. Callers label the absence explicitly rather than fabricating a
 * filename.
 *
 * @param {string|null|undefined} url
 * @returns {string|null} e.g. "world.spz", or null when there is no asset
 */
export function assetFileName(url) {
  if (typeof url !== "string" || url === "") return null;
  return url.split("/").pop();
}

/**
 * Known Gaussian-scene filename suffixes, longest first so that
 * "scene.gs.ply" strips the whole ".gs.ply" rather than leaving "scene.gs".
 */
export const SCENE_SUFFIXES = [".3dgs.ply", ".gs.ply", ".spz", ".ply"];

/**
 * Strips one known Gaussian-scene suffix, case-insensitively. Periods that
 * are not part of a known suffix are left alone, so "my.room.v2.ply" becomes
 * "my.room.v2".
 *
 * @param {string} fileName  e.g. "interior_0516_840045.gs.ply"
 * @returns {string}         e.g. "interior_0516_840045"
 */
export function sceneDisplayName(fileName) {
  if (typeof fileName !== "string" || fileName === "") return "";

  const lower = fileName.toLowerCase();

  for (const suffix of SCENE_SUFFIXES) {
    if (!lower.endsWith(suffix)) continue;

    // Longest match wins, and it is the only one considered: a file named
    // exactly ".gs.ply" must keep its name rather than falling through to
    // ".ply" and rendering as ".gs".
    const base = fileName.slice(0, -suffix.length);
    return base === "" ? fileName : base;
  }

  return fileName;
}
