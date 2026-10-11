/**
 * loop.js
 * Starts and owns the animation loop.
 *
 * The per-frame callback runs before rendering.
 * The after-render callback runs immediately after rendering.
 */

export function startLoop(renderer, scene, camera, onFrame, afterRender) {
  let lastTime = performance.now();

  renderer.setAnimationLoop((time) => {
    const delta = Math.min((time - lastTime) / 1000, 0.05);

    lastTime = time;

    onFrame?.(delta);

    renderer.render(scene, camera);

    afterRender?.(delta);
  });
}
