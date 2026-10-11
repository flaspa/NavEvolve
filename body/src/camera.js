/**
 * camera.js
 * Creates and exports the shared PerspectiveCamera.
 *
 * PerspectiveCamera mimics how a real lens works:
 *   fov   – vertical field of view in degrees (75° is a wide-ish game view)
 *   aspect – width / height of the canvas (updated on resize)
 *   near  – anything closer than this is clipped
 *   far   – anything farther than this is clipped
 */

import * as THREE from 'three';

const camera = new THREE.PerspectiveCamera(
  75,                                    // fov
  window.innerWidth / window.innerHeight, // aspect (recalculated on resize)
  0.1,                                   // near clip plane
  200                                    // far clip plane
);

// Starting position: slightly elevated and pulled back so the floor is visible.
camera.position.set(0, 8, 16);
camera.lookAt(0, 0, 0);

export { camera };
