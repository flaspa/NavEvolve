/**
 * renderer.js
 * Creates and exports the WebGLRenderer, and wires up browser-resize handling.
 *
 * WebGLRenderer talks directly to the GPU via the browser's WebGL API.
 * antialias: true smooths jagged edges at a modest performance cost.
 */

import * as THREE from 'three';
import { camera } from './camera.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });

// Match the full browser window.
renderer.setSize(window.innerWidth, window.innerHeight);

// Respect high-DPI (Retina) screens, but cap at 2× to protect frame rate.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// Tone-mapping makes HDR lighting look more natural on an SDR screen.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// Inject the <canvas> element that Three.js creates into the page.
document.body.appendChild(renderer.domElement);

/**
 * Resize handler — keeps the camera aspect ratio and renderer resolution in
 * sync with the browser window whenever the user resizes or the Replit preview
 * panel changes size.
 */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  camera.aspect = w / h;
  camera.updateProjectionMatrix(); // must be called after changing camera props

  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

window.addEventListener('resize', onResize);

export { renderer };
