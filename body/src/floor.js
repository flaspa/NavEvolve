/**
 * floor.js
 * Adds a solid ground plane and a GridHelper for spatial reference.
 *
 * Both objects are exported so other modules can hide them once a real world
 * asset is loaded.  To hide the grid temporarily:
 *   import { grid, floor } from './floor.js';
 *   grid.visible  = false;
 *   floor.visible = false;
 */

import * as THREE from 'three';
import { scene } from './scene.js';

// --- Solid ground plane ---
const floorGeometry = new THREE.PlaneGeometry(60, 60);
const floorMaterial = new THREE.MeshStandardMaterial({
  color:     0x1a1a2e,
  roughness: 0.9,
  metalness: 0.0,
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// --- Grid overlay ---
const grid = new THREE.GridHelper(60, 60, 0x444466, 0x333355);
grid.position.y = 0.001;
scene.add(grid);

export { floor, grid };
