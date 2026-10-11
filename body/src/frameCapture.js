/**
 * frameCapture.js — Frame capture utilities.
 *
 * captureExplorerFrame  — grabs whatever is currently on the renderer canvas.
 *                         UNSAFE on its own from async code: the renderer has
 *                         preserveDrawingBuffer: false, so the buffer is
 *                         cleared after the browser composites and the read
 *                         comes back black. Only call it in the same
 *                         synchronous block as a renderer.render() — which is
 *                         exactly what captureEgoFrame does. Prefer
 *                         captureEgoFrame for anything sent to the brain.
 *
 * captureEgoFrame       — renders the scene from the avatar's first-person eye
 *   (Step 1 addition)     position, captures it, then immediately restores the
 *                         user's original view. Works regardless of whether the
 *                         player is currently in first- or third-person mode.
 *                         The re-render happens synchronously before the browser
 *                         paints so there is no visible camera flicker.
 */
import * as THREE from "three";

/**
 * Capture the current Three.js renderer canvas as a compressed JPEG.
 *
 * Call this immediately after a rendered frame. For a more robust production
 * capture pipeline, use a WebGLRenderTarget and readRenderTargetPixels().
 */
export function captureExplorerFrame(
  renderer,
  { quality = 0.65, maxWidth = 768 } = {},
) {
  const sourceCanvas = renderer.domElement;

  const scale = Math.min(1, maxWidth / sourceCanvas.width);

  const width = Math.max(1, Math.round(sourceCanvas.width * scale));

  const height = Math.max(1, Math.round(sourceCanvas.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  context.drawImage(sourceCanvas, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Capture a first-person frame from the avatar's eye position.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene}         scene
 * @param {THREE.Camera}        mainCamera  The user's current on-screen camera.
 * @param {object|null}         egoView     Object from getCaptureEgoView():
 *                                            { position: [x,y,z], heading: radians,
 *                                              hide: [Object3D, …] }
 *                                          Pass null to fall back to the current canvas.
 * @param {object}              [options]
 * @param {number}              [options.quality=0.70]   JPEG quality 0–1.
 * @param {number}              [options.maxWidth=768]   Output pixel width cap.
 * @returns {{
 *   dataUrl:        string,
 *   width:          number,
 *   height:         number,
 *   cameraSnapshot: {
 *     position:   number[],
 *     quaternion: number[],
 *     fov:    number,
 *     aspect: number,
 *     near:   number,
 *     far:    number,
 *   },
 * }}
 *   The encoded JPEG data URL, the exact pixel dimensions of the output image
 *   (after any downscale applied by the maxWidth cap), and a frozen snapshot
 *   of the camera used for this render so the localization pipeline can cast
 *   rays through the exact same frustum regardless of when Qwen responds.
 */
export function captureEgoFrame(
  renderer,
  scene,
  mainCamera,
  egoView,
  { quality = 0.70, maxWidth = 768 } = {},
) {
  // No ego view available (e.g. avatar not yet loaded) — fall back to the
  // user's current view.  Snapshot mainCamera so the caller still gets a
  // usable cameraSnapshot for the localization pipeline.
  if (!egoView) {
    const src = renderer.domElement;
    const scale = Math.min(1, maxWidth / src.width);
    const width  = Math.max(1, Math.round(src.width  * scale));
    const height = Math.max(1, Math.round(src.height * scale));
    // The renderer is created WITHOUT preserveDrawingBuffer, so the drawing
    // buffer is cleared once the browser composites a frame. Reading the
    // canvas from an async caller (a chat submit handler, a WebSocket
    // callback) therefore yields a black image unless a render happens
    // first, in this same synchronous block. Re-render the user's own view:
    // pixel-identical to what is on screen, so there is nothing to restore.
    if (scene) renderer.render(scene, mainCamera);
    const dataUrl = captureExplorerFrame(renderer, { quality, maxWidth });
    mainCamera.updateMatrixWorld(true);
    const cameraSnapshot = Object.freeze({
      position:  mainCamera.position.toArray(),
      quaternion: mainCamera.quaternion.toArray(),
      fov:    mainCamera.fov,
      aspect: mainCamera.aspect,
      near:   mainCamera.near,
      far:    mainCamera.far,
    });
    return { dataUrl, width, height, cameraSnapshot };
  }

  const src = renderer.domElement;

  if (!src.width || !src.height) {
    throw new Error("Renderer canvas has no dimensions.");
  }

  // ------------------------------------------------------------------
  // Build a temporary camera placed at the avatar's eye.
  // heading 0 = facing -Z (Three.js convention).
  // ------------------------------------------------------------------
  const egoCam = new THREE.PerspectiveCamera(
    mainCamera.fov,
    src.width / src.height,
    0.05,
    1000,
  );
  egoCam.position.set(
    egoView.position[0],
    egoView.position[1],
    egoView.position[2],
  );

  // Prefer the full world quaternion when available.  getCaptureEgoView()
  // now always provides one via player.getEyeQuaternion() regardless of
  // camera mode, so this branch is the normal path.
  //
  // The heading-only fallback is retained as a safety net for callers that
  // do not have access to the player instance.  Note the required + Math.PI:
  // egoView.heading = atan2(move.x, move.z) which measures from world +Z,
  // but a Three.js camera at rotation.y=θ looks toward (−sinθ, 0, −cosθ).
  // Adding π converts from "+Z reference" to "camera −Z convention" so the
  // perception camera faces the same direction as the avatar's body.
  if (egoView.quaternion) {
    egoCam.quaternion.set(
      egoView.quaternion[0],
      egoView.quaternion[1],
      egoView.quaternion[2],
      egoView.quaternion[3],
    );
  } else {
    egoCam.rotation.set(0, egoView.heading + Math.PI, 0);
  }
  egoCam.updateProjectionMatrix();
  egoCam.updateMatrixWorld(true);

  // Snapshot the ego camera's exact state — position, quaternion, and
  // projection parameters — BEFORE any render call so the localization
  // pipeline can reconstruct the exact frustum used for this frame.
  const cameraSnapshot = Object.freeze({
    position:  egoCam.position.toArray(),
    quaternion: egoCam.quaternion.toArray(),
    fov:    egoCam.fov,
    aspect: egoCam.aspect,
    near:   egoCam.near,
    far:    egoCam.far,
  });

  // ------------------------------------------------------------------
  // Hide avatar body so it does not appear in the perception image,
  // but only objects that are currently visible (avoids accidentally
  // un-hiding things the user explicitly toggled off).
  // ------------------------------------------------------------------
  const hidden = (egoView.hide ?? []).filter((o) => o && o.visible);
  for (const o of hidden) o.visible = false;

  // Render the scene from the avatar's eyes.
  // This overwrites the renderer canvas — restored below.
  renderer.render(scene, egoCam);

  // ------------------------------------------------------------------
  // Downscale and encode as JPEG while the ego frame is on the canvas.
  // ------------------------------------------------------------------
  const scale = Math.min(1, maxWidth / src.width);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(src, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);

  // ------------------------------------------------------------------
  // Restore: un-hide the avatar and re-render the user's original view.
  // This happens synchronously before the browser paints, so there is
  // no visible flicker even for a single frame.
  // ------------------------------------------------------------------
  for (const o of hidden) o.visible = true;
  renderer.render(scene, mainCamera);

  return { dataUrl, width, height, cameraSnapshot };
}
