/**
 * scene.js
 * Creates and exports the shared Three.js Scene.
 *
 * A Scene is the root container for all 3-D objects, lights, and cameras.
 * Everything you want rendered must be added to it.
 */

import * as THREE from 'three';

const scene = new THREE.Scene();

// Subtle dark fog so distant objects fade into the background.
// Arguments: color, near distance, far distance (world units).
scene.fog = new THREE.Fog(0x111111, 20, 80);

// Ambient light gives every surface a baseline brightness so nothing is
// pitch-black in shadow.  Value 0.6 keeps it dim enough to show contrast.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

// Directional light acts like a distant sun: parallel rays, sharp shadows.
const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

export { scene };
