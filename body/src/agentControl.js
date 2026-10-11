// REUSED from teammate Jun Jiang's NavEvolve branch (flaspa/NavEvolve PR #1, commit 5a8b689), verbatim.

/**
 * agentControl.js — the browser half of the brain's Body: capture / goto / turn /
 * face / pose / frontiers / reset (docs/CONTRACTS.md §1). Walking is driven by
 * update(delta) each frame through player.setExternalMove, so every step still
 * passes the player's NavMesh constraint (constrainDisplacementToNavmesh).
 */
import * as THREE from "three";
import { headingDegToQuaternion, quaternionToHeadingDeg } from "./agentPose.js";
import { closestPointOnNavmesh, floorHeightAt } from "./navmeshQuery.js";
import { buildGrid, astar, smooth, snapCell, cellOf, cellCentre, isWalk, CELL } from "./navPath.js";

const VIEW_RANGE_M = 3;
const STALL_S = 1.5; // no progress for this long => "blocked"
const GOTO_TIMEOUT_S = 60;
// Background tabs get no animation frames, so waiting would hang until the brain times out.
const nextFrame = () => document.hidden
  ? Promise.reject(new Error("tab is in the background — bring the NavEvolve tab to the front"))
  : new Promise((r) => requestAnimationFrame(r));
const r3 = (v) => +v.toFixed(3);

export function createAgentControl({ getPlayer, getMeshes, captureEgo, measureRange, brainUrl }) {
  // player is created after the scene loads; resolve it lazily.
  const player = new Proxy({}, { get: (_, k) => { const p = getPlayer(); const v = p[k]; return typeof v === "function" ? v.bind(p) : v; } });
  let grid = null, gridKey = null, visited = null;
  let job = null;

  function ensureGrid() {
    const meshes = getMeshes();
    if (!meshes.length) return null;
    if (gridKey !== meshes[0]) {
      grid = buildGrid(meshes);
      visited = new Uint8Array(grid.walk.length);
      gridKey = meshes[0];
    }
    return grid;
  }

  function pose() {
    const p = player.getAgentPose();
    return {
      x: r3(p.position.x), y: r3(p.position.y), z: r3(p.position.z),
      headingDeg: +quaternionToHeadingDeg(p.rotation).toFixed(1),
      pitchDeg: +(player.getEyePitch?.() ?? 0).toFixed(1),
    };
  }

  const setHeading = (deg) => player.setAgentPose({ rotation: headingDegToQuaternion(deg) });

  function markVisited(x, z, headingDeg, fovDeg, aspect) {
    if (!ensureGrid()) return;
    const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * aspect); // horizontal half-fov
    const h = THREE.MathUtils.degToRad(headingDeg);
    const [ci, cj] = cellOf(grid, x, z);
    const R = Math.ceil(VIEW_RANGE_M / CELL);
    for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
      if (!isWalk(grid, i, j)) continue;
      const [cx, cz] = cellCentre(grid, i, j);
      const d = Math.hypot(cx - x, cz - z);
      if (d > VIEW_RANGE_M) continue;
      let da = Math.abs(Math.atan2(cx - x, cz - z) - h) % (2 * Math.PI);
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (d < 0.5 || da <= half) visited[j * grid.nx + i] = 1;
    }
  }

  async function postObservation(frame, range) {
    try {
      const res = await fetch(`${brainUrl}/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_data_url: frame.dataUrl, scene_id: frame.sceneId, timestamp: frame.timestamp,
          trigger: "agent", pose: frame.observedFrom, camera_snapshot: frame.cameraSnapshot,
          image_width: frame.width, image_height: frame.height, range,
        }),
      });
      return res.ok ? (await res.json()).id : null;
    } catch {
      return null; // brain down: frames still returned, without obsId
    }
  }

  function finish(status) {
    const j = job;
    job = null;
    player.clearExternalMove();
    player.setInputEnabled(j.inputWas);
    j.resolve({ status, pose: pose(), pathLength: r3(j.length), path: j.path.map(([x, z]) => [r3(x), r3(z)]) });
  }

  const agent = {
    /** Per-frame driver; call before player.update(). */
    update(delta) {
      if (!job) return;
      const p = player.getAgentPose().position;
      job.elapsed += delta;
      if (job.elapsed > GOTO_TIMEOUT_S) return finish("blocked");

      // Stall check: must gain 0.1 m of ground every STALL_S seconds.
      if (job.elapsed - job.checkAt >= STALL_S) {
        if (Math.hypot(p.x - job.checkX, p.z - job.checkZ) < 0.1) return finish("blocked");
        job.checkAt = job.elapsed; job.checkX = p.x; job.checkZ = p.z;
      }

      const last = job.idx === job.path.length - 1;
      let [wx, wz] = job.path[job.idx];
      let d = Math.hypot(wx - p.x, wz - p.z);
      if (last ? d <= job.stopWithin : d < 0.15) {
        if (last) return finish("arrived");
        job.idx += 1;
        [wx, wz] = job.path[job.idx];
        d = Math.hypot(wx - p.x, wz - p.z);
      }
      setHeading(THREE.MathUtils.radToDeg(Math.atan2(wx - p.x, wz - p.z)));
      player.setExternalMove(wx - p.x, wz - p.z);
    },

    /** Test helpers (not part of the brain contract). */
    debug: {
      onNavmesh: (x, z) => floorHeightAt(getMeshes(), x, z) !== null,
      randomPoint() {
        const g = ensureGrid();
        let i, j;
        do { i = Math.floor(Math.random() * g.nx); j = Math.floor(Math.random() * g.nz); } while (!isWalk(g, i, j));
        const [x, z] = cellCentre(g, i, j);
        return { x, z };
      },
    },

    /** Abandon any walk in progress (new goal / Stop). */
    halt() { if (job) finish("blocked"); },

    async pose() { return { pose: pose() }; },

    async turn({ deg }) {
      setHeading(pose().headingDeg + deg);
      await nextFrame();
      return { pose: pose() };
    },

    async face({ x, z }) {
      const p = pose();
      setHeading(THREE.MathUtils.radToDeg(Math.atan2(x - p.x, z - p.z)));
      await nextFrame();
      return { pose: pose() };
    },

    async capture({ headings = 1 } = {}) {
      const frames = [];
      for (let i = 0; i < headings; i++) {
        if (i > 0) await agent.turn({ deg: 360 / headings });
        await nextFrame();
        const f = captureEgo();
        if (!f) throw new Error("no scene loaded");
        const range = measureRange(f);
        const obsId = await postObservation(f, range);
        const o = f.observedFrom, cam = f.cameraSnapshot;
        markVisited(o.x, o.z, o.headingDeg, cam.fov, cam.aspect);
        frames.push({
          frameId: obsId ?? `${f.sceneId}-${f.timestamp}-${i}`, obsId, sceneId: f.sceneId,
          jpegDataUrl: f.dataUrl, pose: { ...o },
          camera: { fovDeg: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far },
          rangeM: range?.distanceM ?? null, ts: new Date(f.timestamp).toISOString(),
        });
        window.__seekr?.agentPanel?.frame(frames.at(-1)); // thumbnails for thoughts
      }
      if (headings > 1) await agent.turn({ deg: 360 / headings });
      return { frames };
    },

    async goto({ x, z, stopWithin = 0.3 }) {
      if (job) throw new Error("goto already in progress");
      const g = ensureGrid();
      const here = player.getAgentPose().position;
      const fail = (status) => ({ status, pose: pose(), pathLength: 0, path: [] });
      if (!g) return fail("unreachable");
      const [ti, tj] = cellOf(g, x, z);
      const start = snapCell(g, here.x, here.z);
      if (!isWalk(g, ti, tj) || !start) return fail("unreachable");
      const cells = astar(g, start, [ti, tj]);
      if (!cells) return fail("unreachable");
      const path = smooth(g, cells).slice(1);
      path.push([x, z]); // exact target replaces the goal cell centre
      let length = 0, px = here.x, pz = here.z;
      for (const [wx, wz] of path) { length += Math.hypot(wx - px, wz - pz); px = wx; pz = wz; }
      return new Promise((resolve) => {
        job = {
          path, idx: 0, stopWithin, length, resolve, elapsed: 0,
          checkAt: 0, checkX: here.x, checkZ: here.z, inputWas: player.inputEnabled,
        };
        player.setInputEnabled(false);
      });
    },

    async frontiers() {
      const g = ensureGrid();
      if (!g) return { frontiers: [], coverage: 0 };
      const isFront = (i, j) =>
        isWalk(g, i, j) && !visited[j * g.nx + i] &&
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => isWalk(g, i + a, j + b) && visited[(j + b) * g.nx + i + a]);
      const seen = new Set(), clusters = [];
      for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
        if (!isFront(i, j) || seen.has(j * g.nx + i)) continue;
        const cells = [], stack = [[i, j]];
        seen.add(j * g.nx + i);
        while (stack.length) {
          const [ci, cj] = stack.pop();
          cells.push([ci, cj]);
          for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
            const k = (cj + b) * g.nx + ci + a;
            if ((a || b) && isFront(ci + a, cj + b) && !seen.has(k)) { seen.add(k); stack.push([ci + a, cj + b]); }
          }
        }
        clusters.push(cells);
      }
      clusters.sort((a, b) => b.length - a.length);
      const frontiers = clusters.slice(0, 8).map((cells) => {
        const mi = cells.reduce((s, c) => s + c[0], 0) / cells.length, mj = cells.reduce((s, c) => s + c[1], 0) / cells.length;
        const [bi, bj] = cells.reduce((b, c) => (Math.hypot(c[0] - mi, c[1] - mj) < Math.hypot(b[0] - mi, b[1] - mj) ? c : b));
        const [x, z] = cellCentre(g, bi, bj); // cluster cell nearest the centroid, so it is walkable
        return { x: r3(x), z: r3(z), size: cells.length };
      });
      let walk = 0, seenW = 0;
      for (let k = 0; k < g.walk.length; k++) { walk += g.walk[k]; seenW += g.walk[k] & visited[k]; }
      return { frontiers, coverage: walk ? +(seenW / walk).toFixed(4) : 0 };
    },

    async reset({ x, z, headingDeg }) {
      if (job) finish("blocked");
      const meshes = getMeshes();
      const cur = player.getAgentPose().position;
      const hit = closestPointOnNavmesh(meshes, new THREE.Vector3(x, cur.y, z));
      player.setAgentPose({ position: hit ? hit.point : [x, cur.y, z], rotation: headingDegToQuaternion(headingDeg) });
      gridKey = null; // rebuilds grid + clears visited on next use
      ensureGrid();
      await nextFrame();
      return { pose: pose() };
    },
  };
  return agent;
}
