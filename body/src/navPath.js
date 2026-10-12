/**
 * navPath.js — walkable grid over the NavMesh + A* on it.
 * Cells are walkable iff a top-down probe hits the NavMesh (single-floor scenes).
 * ponytail: one Y per (x,z); multi-level scenes need a per-floor grid.
 */
import * as THREE from "three";
import { floorHeightAt } from "./navmeshQuery.js";

export const CELL = 0.25;

export function buildGrid(meshes) {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  const minX = box.min.x, minZ = box.min.z;
  const nx = Math.ceil((box.max.x - minX) / CELL), nz = Math.ceil((box.max.z - minZ) / CELL);
  const walk = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (floorHeightAt(meshes, minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL) !== null) walk[j * nx + i] = 1;
    }
  }
  return { minX, minZ, nx, nz, walk };
}

export const cellOf = (g, x, z) => [Math.floor((x - g.minX) / CELL), Math.floor((z - g.minZ) / CELL)];
export const cellCentre = (g, i, j) => [g.minX + (i + 0.5) * CELL, g.minZ + (j + 0.5) * CELL];
export const isWalk = (g, i, j) => i >= 0 && j >= 0 && i < g.nx && j < g.nz && g.walk[j * g.nx + i] === 1;

/** Cell nearest (x,z) that is walkable within `r` cells, else null. */
export function snapCell(g, x, z, r = 2) {
  const [ci, cj] = cellOf(g, x, z);
  let best = null, bd = Infinity;
  for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
    const d = (i - ci) ** 2 + (j - cj) ** 2;
    if (isWalk(g, i, j) && d < bd) { bd = d; best = [i, j]; }
  }
  return best;
}

const edgeCost = (g, i, j) =>
  isWalk(g, i + 1, j) && isWalk(g, i - 1, j) && isWalk(g, i, j + 1) && isWalk(g, i, j - 1) ? 0 : 1.5;

/** 8-connected A* (no corner cutting, edge cells penalised). Returns [[x,z],...] cell centres or null. */
export function astar(g, [si, sj], [ti, tj]) {
  const id = (i, j) => j * g.nx + i;
  const cost = new Map([[id(si, sj), 0]]), from = new Map(), closed = new Set();
  const open = [[0, si, sj]]; // ponytail: sorted-array open list, binary heap if grids get large
  const h = (i, j) => Math.hypot(i - ti, j - tj);
  while (open.length) {
    open.sort((a, b) => b[0] - a[0]);
    const [, i, j] = open.pop();
    const k = id(i, j);
    if (closed.has(k)) continue;
    closed.add(k);
    if (i === ti && j === tj) {
      const path = [];
      for (let c = k; c !== undefined; c = from.get(c)) path.push(cellCentre(g, c % g.nx, Math.floor(c / g.nx)));
      return path.reverse();
    }
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (!isWalk(g, ni, nj) || (di && dj && !(isWalk(g, i + di, j) && isWalk(g, i, j + dj)))) continue;
      const c = cost.get(k) + Math.hypot(di, dj) + edgeCost(g, ni, nj);
      const nk = id(ni, nj);
      if (c < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, c); from.set(nk, k);
        open.push([c + h(ni, nj), ni, nj]);
      }
    }
  }
  return null;
}

/** Drop waypoints whose neighbours see each other over fully walkable, edge-free cells. */
export function smooth(g, path) {
  const clear = ([ax, az], [bx, bz]) => {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 2));
    for (let s = 0; s <= n; s++) {
      const [i, j] = cellOf(g, ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n);
      if (!isWalk(g, i, j) || edgeCost(g, i, j) > 0) return false;
    }
    return true;
  };
  const out = [path[0]];
  let a = 0;
  while (a < path.length - 1) {
    let b = path.length - 1;
    while (b > a + 1 && !clear(path[a], path[b])) b--;
    out.push(path[b]);
    a = b;
  }
  return out;
}
