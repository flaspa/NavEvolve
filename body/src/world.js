/**
 * world.js
 * Loads the Gaussian Splat world, its NavMesh layer and (when a scene has one)
 * its collision mesh, then positions the camera to frame the complete scene.
 *
 * Dependencies:
 *   @sparkjsdev/spark  – SparkRenderer (Gsplat render pipeline) + SplatMesh
 *   three/examples/jsm – GLTFLoader (standard .glb/.gltf loader)
 *   three/examples/jsm – OrbitControls (mouse orbit, pan, zoom)
 *
 * The startup scene is described by its scene.seekr.json (sceneProfile.js),
 * fetched from the local dataset root. Every asset can be replaced at runtime
 * via replaceSplat()/replaceNavmesh()/replaceCollider(); this module stays
 * the single owner of world-asset loading.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SplatMesh, SparkRenderer } from "@sparkjsdev/spark";
import { scene } from "./scene.js";
import { camera } from "./camera.js";
import { renderer } from "./renderer.js";
import { floor, grid } from "./floor.js";
import { createCollider } from "./collision.js";
import { APP_CONFIG } from "./config/appConfig.js";
import { getSceneById } from "./config/scenes.js";
import { readSession, resolveStartupSceneId } from "./sessionPersistence.js";
import { loadSceneProfile } from "./sceneProfile.js";

/** Absolute URL of a catalog entry's scene.seekr.json. */
export function sceneProfileUrl(sceneEntry) {
  return `${APP_CONFIG.habitatDataUrl.replace(/\/+$/, "")}/${sceneEntry.profile}`;
}

// ---------------------------------------------------------------------------
// Startup scene — a saved session may name a different scene; it is honoured
// only when the registry can still reopen it by id.
// ---------------------------------------------------------------------------
const startupSession = APP_CONFIG.sessionPersistenceEnabled ? readSession() : null;

const startupSelection = resolveStartupSceneId(
  startupSession,
  APP_CONFIG.defaultSceneId,
  getSceneById,
);

const startupScene = getSceneById(startupSelection.sceneId);

if (!startupScene) {
  throw new Error(
    `[world] Unknown APP_CONFIG.defaultSceneId: "${APP_CONFIG.defaultSceneId}"`,
  );
}

if (startupSession && startupSelection.source === "default") {
  console.log(
    `[session] Saved scene "${startupSession.sceneId}" is not reopenable by ` +
      `id — starting the configured default instead.`,
  );
}

/** The active descriptor, set once the startup profile resolves. */
let sceneDescriptor = null;

/** Reports a registered-asset failure with everything needed to diagnose it. */
function reportAssetError(assetKey, url, err) {
  console.error(
    `[world] Failed to load registered asset\n` +
      `  scene: ${sceneDescriptor?.id ?? startupScene.id}\n` +
      `  asset: ${assetKey}\n` +
      `  url:   ${url}\n` +
      `  error: ${err?.message ?? err}`,
    err,
  );
}

// ---------------------------------------------------------------------------
// Loading overlay helpers
// ---------------------------------------------------------------------------
const loadingEl = document.createElement("div");
loadingEl.id = "loading";
loadingEl.textContent = "Loading world…";
Object.assign(loadingEl.style, {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  color: "#e0e0ff",
  fontFamily: "system-ui, sans-serif",
  fontSize: "1.2rem",
  background: "rgba(0,0,0,0.6)",
  padding: "0.6em 1.4em",
  borderRadius: "6px",
  pointerEvents: "none",
  zIndex: "10",
});
document.body.appendChild(loadingEl);

function setStatus(msg) {
  loadingEl.textContent = msg;
}

function hideStatus() {
  loadingEl.style.display = "none";
}

// ---------------------------------------------------------------------------
// SparkRenderer — hooks into Three.js via onBeforeRender.
// ---------------------------------------------------------------------------
const sparkRenderer = new SparkRenderer({ renderer });
scene.add(sparkRenderer);

// ---------------------------------------------------------------------------
// Parent group — the splat, the NavMesh layer and the collider share this
// transform (the scene's `environment`, applied by main.js).
// ---------------------------------------------------------------------------
const worldGroup = new THREE.Group();
worldGroup.name = "worldGroup";
scene.add(worldGroup);
worldGroup.updateMatrixWorld(true);

let colliderMesh = null;
let worldCollider = null;

// ---------------------------------------------------------------------------
// OrbitControls — disposed once the player takes over the camera.
// ---------------------------------------------------------------------------
export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;

function fitCameraToBox(box) {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fovRad = (camera.fov * Math.PI) / 180;
  const distance = (maxDim / 2 / Math.tan(fovRad / 2)) * 1.4;

  camera.position.set(center.x, center.y + size.y * 0.3, center.z + distance);
  camera.near = distance * 0.01;
  camera.far = distance * 10;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

// ---------------------------------------------------------------------------
// Gaussian Splat (.gs.ply / .spz via SplatMesh — Spark detects the format)
// ---------------------------------------------------------------------------
let splatMesh = null; // `let`: replaceSplat() rebinds it (live export)

function loadSplatAsset(url) {
  splatMesh = new SplatMesh({
    url,
    onLoad: () => {
      console.log("[world] Gaussian Splat loaded:", url);
    },
  });
  worldGroup.add(splatMesh);

  return splatMesh.initialized.catch((err) => {
    reportAssetError("splat", url, err);
    setStatus("Error: could not load scene — check console");
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Collider GLB (Three.js GLTFLoader) — optional; Habitat-GS scenes ship none.
// ---------------------------------------------------------------------------
const gltfLoader = new GLTFLoader();

function buildColliderGroup(gltfScene) {
  const group = new THREE.Group();
  group.name = "collider";

  gltfScene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.material = new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true });
  });

  group.add(gltfScene);
  return group;
}

/** Releases the GPU resources of a group we are about to drop. */
function disposeGroup(group) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material?.dispose();
  });
}

function loadColliderAsset(GLB_URL) {
  if (!GLB_URL) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    gltfLoader.load(
      GLB_URL,
      (gltf) => {
        console.log("[world] Collider GLB loaded:", GLB_URL);
        const group = buildColliderGroup(gltf.scene);
        group.visible = false;
        worldGroup.add(group);
        worldGroup.updateMatrixWorld(true);
        worldCollider = createCollider(group);
        colliderMesh = group;
        resolve(group);
      },
      (progress) => {
        if (progress.total > 0) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          setStatus(`Loading world… ${pct}%`);
        }
      },
      (err) => {
        reportAssetError("collider", GLB_URL, err);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// NavMesh layer (seekrNavmesh)
//
// A WALKABLE SURFACE, kept deliberately separate from the obstacle collider:
//   - never passed to createCollider(), so no collision BVH is built from it
//   - never handed to player.setCollider()
//
// Its non-visual uses are the spatial queries in navmeshQuery.js (locomotion
// constraint, start-pose validation, floor height) via getNavmeshMeshes().
// ---------------------------------------------------------------------------
let navmeshMesh = null;
const navmeshMeshes = [];
const navmeshRaycaster = new THREE.Raycaster();

/** Builds the NavMesh visual layer from a loaded GLTF scene. */
function buildNavmeshGroup(gltfScene) {
  const group = new THREE.Group();
  group.name = "navmesh";
  const meshes = [];

  gltfScene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    // Opaque, depth-writing wireframe: a transparent version fell into the
    // same alpha-blended pass as the Gaussian splats and painted over them.
    child.material = new THREE.MeshBasicMaterial({
      color: 0x4aa3ff,
      wireframe: true,
      side: THREE.DoubleSide,
    });
    meshes.push(child);
  });

  group.add(gltfScene);
  return { group, meshes };
}

function loadNavmeshAsset(NAVMESH_URL) {
  if (!NAVMESH_URL) return Promise.resolve(null);

  return gltfLoader
    .loadAsync(NAVMESH_URL)
    .then((gltf) => {
      const built = buildNavmeshGroup(gltf.scene);
      worldGroup.add(built.group);
      worldGroup.updateMatrixWorld(true);
      navmeshMesh = built.group;
      navmeshMeshes.push(...built.meshes);
      console.log(`[world] NavMesh layer ready: ${navmeshMeshes.length} mesh(es)`);
      return built.group;
    })
    .catch((err) => {
      reportAssetError("seekrNavmesh", NAVMESH_URL, err);
      // A missing navmesh is not fatal — the scene still renders.
      return null;
    });
}

/**
 * "Where is the navigable floor under (x, z)?" — plain downward raycast
 * against the NavMesh triangles. Returns null when nothing walkable is below.
 */
function getNavmeshFloorHeight(x, z, fromY = 100, maxDrop = 200) {
  if (!navmeshMeshes.length) return null;
  worldGroup.updateMatrixWorld(true);
  navmeshRaycaster.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  navmeshRaycaster.far = maxDrop;
  const hit = navmeshRaycaster.intersectObjects(navmeshMeshes, false)[0];
  return hit ? hit.point.y : null;
}

/** The live NavMesh meshes, for the spatial queries in navmeshQuery.js. */
function getNavmeshMeshes() {
  return navmeshMeshes;
}

/** Object URL backing a NavMesh loaded from a local File. */
let navmeshObjectUrl = null;

function disposeNavmesh() {
  if (navmeshMesh) {
    worldGroup.remove(navmeshMesh);
    disposeGroup(navmeshMesh);
  }
  navmeshMesh = null;
  navmeshMeshes.length = 0;
}

/** Replaces the NavMesh layer. A failed load leaves the previous one in place. */
export async function replaceNavmesh(source) {
  const { url, owned } = replacementUrl(source);
  let built = null;

  try {
    const gltf = await gltfLoader.loadAsync(url);
    built = buildNavmeshGroup(gltf.scene);
    built.group.visible = navmeshMesh ? navmeshMesh.visible : true;
  } catch (err) {
    if (owned) URL.revokeObjectURL(url);
    throw err;
  }

  const previousUrl = navmeshObjectUrl;
  disposeNavmesh();

  worldGroup.add(built.group);
  worldGroup.updateMatrixWorld(true);
  navmeshMesh = built.group;
  navmeshMeshes.push(...built.meshes);
  navmeshObjectUrl = owned ? url : null;

  if (previousUrl) URL.revokeObjectURL(previousUrl);

  console.log(`[world] NavMesh replaced: ${navmeshMeshes.length} mesh(es)`);
  return built.group;
}

/** Removes the NavMesh entirely — for a scene that registers none. */
export function clearNavmesh() {
  disposeNavmesh();
  if (navmeshObjectUrl) {
    URL.revokeObjectURL(navmeshObjectUrl);
    navmeshObjectUrl = null;
  }
}

/** Removes the obstacle collider entirely. Callers must detach it from the player. */
export function clearCollider() {
  if (colliderMesh) {
    worldGroup.remove(colliderMesh);
    worldCollider?.dispose();
    disposeGroup(colliderMesh);
  }
  colliderMesh = null;
  worldCollider = null;

  if (colliderObjectUrl) {
    URL.revokeObjectURL(colliderObjectUrl);
    colliderObjectUrl = null;
  }
}

/** groundY-only probe with the shape findSpawnPoint() expects. */
const navmeshFloorProbe = { groundY: getNavmeshFloorHeight };

// ---------------------------------------------------------------------------
// Bootstrap — async because the descriptor comes from a fetched profile.
// ---------------------------------------------------------------------------
const worldReady = (async () => {
  const profileUrl = sceneProfileUrl(startupScene);
  setStatus("Loading scene profile…");
  console.log(`[world] Scene profile: ${profileUrl}`);
  sceneDescriptor = await loadSceneProfile(profileUrl, fetch);

  const { splat, collider, seekrNavmesh } = sceneDescriptor.assets;

  console.log(`[world] Startup scene "${sceneDescriptor.id}"`);
  console.log(`[scene] Splat: ${splat ?? "—"}`);
  console.log(`[scene] Seekr NavMesh GLB: ${seekrNavmesh ?? "—"}`);
  console.log(`[scene] Collider: ${collider ?? "— (NavMesh is the walkability authority)"}`);

  if (!splat) {
    throw new Error(`[world] Scene "${sceneDescriptor.id}" declares no splat asset.`);
  }

  const [splatResult, colliderResult, navmeshResult] = await Promise.allSettled([
    loadSplatAsset(splat),
    loadColliderAsset(collider),
    loadNavmeshAsset(seekrNavmesh),
  ]);

  const bothOk =
    splatResult.status === "fulfilled" && colliderResult.status === "fulfilled";

  // Prefer whichever ground geometry exists for framing.
  const boundsSource =
    (colliderResult.status === "fulfilled" && colliderResult.value) ||
    (navmeshResult.status === "fulfilled" && navmeshResult.value) ||
    null;

  if (boundsSource) {
    const box = new THREE.Box3().setFromObject(boundsSource);
    if (!box.isEmpty()) fitCameraToBox(box);
  } else if (splatResult.status === "fulfilled") {
    try {
      const box = splatMesh.getBoundingBox();
      if (!box.isEmpty()) fitCameraToBox(box);
    } catch (_) {
      // Bounding box may not yet be available.
    }
  }

  floor.visible = false;
  grid.visible = false;

  if (bothOk) {
    setStatus("World loaded");
    setTimeout(hideStatus, 2500);
  }

  return {
    bothOk,
    collider: worldCollider,
    colliderMesh,
    navmeshMesh,
    navmeshFloorProbe: navmeshMeshes.length ? navmeshFloorProbe : null,
    splatMesh,
    scene: sceneDescriptor,
  };
})();

const colliderReady = worldReady.then((result) => result.collider);

// ---------------------------------------------------------------------------
// Runtime asset replacement (scene switching)
// ---------------------------------------------------------------------------
function replacementUrl(source) {
  return typeof source === "string"
    ? { url: source, owned: false }
    : { url: URL.createObjectURL(source), owned: true };
}

let splatObjectUrl = null;
let colliderObjectUrl = null;

/**
 * Replaces the runtime Gaussian Splat. Callers should re-apply the visual
 * offset. A failed load leaves the previous splat live.
 */
export async function replaceSplat(source) {
  const { url, owned } = replacementUrl(source);
  let next = null;

  try {
    next = new SplatMesh({ url });
    await next.initialized;
  } catch (err) {
    if (owned) URL.revokeObjectURL(url);
    try {
      next?.dispose();
    } catch (_) {
      // A partially constructed SplatMesh may not be disposable.
    }
    throw err;
  }

  const previous = splatMesh;
  const previousUrl = splatObjectUrl;

  if (previous) {
    next.visible = previous.visible;
    if ("opacity" in previous && "opacity" in next) next.opacity = previous.opacity;
  }

  worldGroup.add(next);
  splatMesh = next;
  splatObjectUrl = owned ? url : null;

  if (previous) {
    worldGroup.remove(previous);
    try {
      previous.dispose();
    } catch (err) {
      console.warn("[world] Failed to dispose previous splat:", err);
    }
  }
  if (previousUrl) URL.revokeObjectURL(previousUrl);

  console.log("[world] Gaussian Splat asset loaded:", url);
  return next;
}

/**
 * Replaces the runtime collision mesh through the same createCollider() path
 * as startup. Callers must hand the returned collider to player.setCollider().
 */
export async function replaceCollider(source) {
  const { url, owned } = replacementUrl(source);
  let group = null;
  let nextCollider = null;

  try {
    const gltf = await gltfLoader.loadAsync(url);
    group = buildColliderGroup(gltf.scene);
    group.visible = colliderMesh ? colliderMesh.visible : false;
    worldGroup.add(group);
    worldGroup.updateMatrixWorld(true);
    nextCollider = createCollider(group);
    if (nextCollider.meshCount === 0) {
      throw new Error("the GLB contains no triangle meshes");
    }
  } catch (err) {
    if (group) {
      worldGroup.remove(group);
      nextCollider?.dispose();
      disposeGroup(group);
    }
    if (owned) URL.revokeObjectURL(url);
    throw err;
  }

  const previousGroup = colliderMesh;
  const previousCollider = worldCollider;
  const previousUrl = colliderObjectUrl;

  colliderMesh = group;
  worldCollider = nextCollider;
  colliderObjectUrl = owned ? url : null;

  if (previousGroup) worldGroup.remove(previousGroup);
  previousCollider?.dispose();
  if (previousGroup) disposeGroup(previousGroup);
  if (previousUrl) URL.revokeObjectURL(previousUrl);

  console.log(`[world] Collider replaced: ${nextCollider.meshCount} mesh(es)`);
  return { collider: nextCollider, colliderMesh: group };
}

export {
  startupSession,
  worldGroup,
  splatMesh,
  colliderMesh,
  worldCollider,
  navmeshMesh,
  getNavmeshMeshes,
  getNavmeshFloorHeight,
  colliderReady,
  worldReady,
};
