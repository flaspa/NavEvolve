/**
 * config/scenes.js — registry of the nine Habitat-GS (InteriorGS) validation
 * scenes.
 *
 * CATALOG POINTERS only. Each scene's authoritative assets, environment
 * transform, visualOffset and defaultStart live in its own scene.seekr.json
 * beside the assets (sceneProfile.js), served from the local dataset root
 * (APP_CONFIG.habitatDataUrl → C:\Flavia\Data\seekr-world-habitat-gs-validation
 * via vite.config.js). Nothing about a scene's contents is repeated here.
 *
 * These scenes ship a Gaussian splat (.gs.ply) and a NavMesh (.navmesh.glb)
 * and NO collision mesh: the NavMesh is the walkability authority.
 */

export const SCENE_IDS = Object.freeze([
  "interior_0516_840045",
  "interior_0518_839988",
  "interior_0633_840123",
  "interior_0635_839968",
  "interior_0637_841444",
  "interior_0651_841463",
  "interior_0695_841526",
  "interior_0733_841584",
  "interior_0759_839979",
]);

/** "interior_0518_839988" -> "InteriorGS 0518 / 839988". */
function validationDisplayName(id) {
  const [, a, b] = id.split("_");
  return a && b ? `InteriorGS ${a} / ${b}` : id;
}

export const SCENES = Object.freeze(
  SCENE_IDS.map((id) =>
    Object.freeze({
      id,
      displayName: validationDisplayName(id),
      // Path relative to the dataset root (the prepared `val/` folders).
      profile: `val/${id}/scene.seekr.json`,
    }),
  ),
);

/** Looks up a scene by id. Returns null for an unknown id; never throws. */
export function getSceneById(id) {
  return SCENES.find((scene) => scene.id === id) ?? null;
}
