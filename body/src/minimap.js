/**
 * minimap.js — Top-down map with a path trail.
 *
 * Pure 2D canvas overlay (no second 3D render pass — cheap and crisp).
 * World mapping: top view centred on a world coordinate. World +X → map
 * right, world +Z → map down, so "up" on the map is world -Z (the
 * direction the player faces at spawn).
 *
 * That centre is a VIEWPORT ANCHOR, not a position of its own, and is never
 * persisted. Seekr's runtime pose remains the single source of truth — the
 * map holds still and the avatar arrow moves across it.
 *
 * Two things can set it, in this order of authority:
 *
 *   1. a NavMesh footprint, which frames the whole walkable area (the useful
 *      framing for diagnosing where Seekr may and may not go);
 *   2. otherwise reset(), at the lifecycle points where Seekr has just been
 *      placed — startup, scene activation, and every explicit teleport.
 *
 * Drawn each frame:
 *   - grid (1 line / 5 m) + border
 *   - the walkable NavMesh footprint, when a scene provides one
 *   - environment marker (tree: trunk dot + canopy ring)
 *   - the avatar's walked path as a polyline (the "trail")
 *   - avatar arrow (position + heading)
 *   - camera dot (useful in first-person flight)
 *
 * ── THE NAVMESH LAYER IS A PICTURE, NOTHING MORE ──────────────────────────
 * setNavmesh() takes a pre-projected footprint (see navmeshFootprint.js) and
 * draws it. It plans nothing, answers no query, and is never read back by
 * locomotion, the benchmark runner, the evaluator or the brain. The native
 * Habitat `.navmesh` remains the authority for benchmark movement and
 * scoring; this is the browser `.navmesh.glb` shown to a human.
 */

/**
 * Extent limits for the navmesh auto-fit, in metres from centre to edge.
 * Deliberately the same range as the MINIMAP > Extent slider, so a fitted
 * value is always one the user can then adjust from — and wide enough that
 * no real scene is clamped, since a clamp would either clip the walkable
 * area or leave it swimming in empty map.
 */
export const MINIMAP_MIN_EXTENT = 2;
export const MINIMAP_MAX_EXTENT = 200;

/**
 * Breathing room left around the walkable area when auto-fitting, as a
 * fraction of the fitted half-span. 8% keeps the footprint clear of the
 * canvas edge without wasting the square.
 */
export const MINIMAP_FIT_PADDING = 0.08;

/**
 * The square viewport that shows a whole NavMesh.
 *
 * Pure, and exported so the framing can be asserted arithmetically rather
 * than by reading pixels back off a canvas.
 *
 * ── WHY THE LARGER HALF-SPAN ──────────────────────────────────────────────
 * The minimap is a square with ONE extent, used for both axes, so X and Z
 * share a scale and the picture cannot be stretched. A viewport sized to the
 * smaller half-span would therefore clip the longer axis; the larger one is
 * what guarantees the complete walkable region is on screen.
 *
 * ── WHY THE BOUNDS CENTRE, NOT SEEKR ──────────────────────────────────────
 * Sizing the view from Seekr's position means an agent standing near one
 * corner needs a viewport twice as wide as the scene, and the walkable area
 * then sits in a corner of the map occupying a fraction of it. The bounds
 * centre is the only anchor that makes "fits, and fills" simultaneously true.
 *
 * @param {{minX: number, maxX: number, minZ: number, maxZ: number}} bounds
 * @returns {{centerX: number, centerZ: number, extent: number}|null}
 */
export function navmeshViewport(bounds) {
  if (!bounds) return null;

  const { minX, maxX, minZ, maxZ } = bounds;
  if (![minX, maxX, minZ, maxZ].every(Number.isFinite)) return null;

  const halfWidth = (maxX - minX) / 2;
  const halfDepth = (maxZ - minZ) / 2;
  const extent = Math.max(halfWidth, halfDepth) * (1 + MINIMAP_FIT_PADDING);

  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    extent: Math.min(MINIMAP_MAX_EXTENT, Math.max(MINIMAP_MIN_EXTENT, extent)),
  };
}

/**
 * Canvas rotation, in radians, that points the avatar arrow along Seekr's
 * embodied heading.
 *
 * PRESENTATION ONLY. It adapts to the existing heading convention and never
 * defines one: `heading` is the repo's embodied yaw in RADIANS (0 = world +Z,
 * +π/2 = world +X, see agentPose.js), exactly as supplied.
 *
 * ── WHY π − h AND NOT h ──────────────────────────────────────────────────
 * The map draws world +X to canvas RIGHT and world +Z to canvas DOWN, so the
 * world forward vector (sin h, cos h) is already the canvas direction the
 * nose must point along. But the arrow is authored nose-up, at local
 * (0, −r), and canvas rotate(θ) sends that to (r·sin θ, −r·cos θ) — because
 * canvas Y points DOWN, a positive θ turns clockwise on screen. Matching the
 * two:
 *
 *     sin θ =  sin h        ⇒   θ = π − h
 *     cos θ = −cos h
 *
 * The earlier formula, h + π, satisfies only the second equation. The two
 * agree wherever sin h = 0, which is why 0° and 180° looked correct while
 * 90°, 270° and every diagonal came out mirrored left-to-right.
 *
 * @param {number} heading  embodied yaw in radians
 * @returns {number} canvas rotation in radians
 */
export function minimapArrowRotation(heading) {
  // atan2 of the components wraps any input into (−π, π] before use, so a
  // heading that has accumulated many turns still maps to one direction.
  const h = Number.isFinite(heading)
    ? Math.atan2(Math.sin(heading), Math.cos(heading))
    : 0;
  return Math.PI - h;
}

export function createMinimap({
  mount,
  extent = 15,       // world metres from centre to map edge
  trailMinStep = 0.15, // metres between recorded trail points
  maxTrailPoints = 3000,
} = {}) {
  const wrap = document.createElement("div");
  wrap.id = "minimap";
  wrap.innerHTML = `<span class="minimap-label">TOP VIEW</span>`;
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  mount.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  let cssSize = 0;

  const ro = new ResizeObserver(() => {
    cssSize = wrap.clientWidth;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = canvas.style.height = `${cssSize}px`;
  });
  ro.observe(wrap);

  let mapExtent = extent;
  // World coordinate at the middle of the canvas. Origin until a scene either
  // places Seekr (see reset()) or supplies a NavMesh (see setNavmesh()).
  let centerX = 0;
  let centerZ = 0;
  /**
   * Where reset() last put Seekr. Kept even while a NavMesh owns the
   * viewport, so clearing the NavMesh falls back to a sensible centre
   * instead of stranding the map over the previous scene.
   */
  let anchorX = 0;
  let anchorZ = 0;
  /**
   * True while the viewport comes from the NavMesh bounds rather than from
   * Seekr.
   *
   * This is what stops `Reset to Scene Start` from undoing the fit: a reset
   * still clears the trail and re-anchors the fallback, but a map framed on
   * the walkable area must keep showing the walkable area — recentring on
   * the agent would push most of the scene off the edge.
   */
  let viewFromNavmesh = false;
  const trail = []; // flat [x0, z0, x1, z1, ...] in world coords
  let lastX = null;
  let lastZ = null;

  /**
   * The walkable footprint of the browser NavMesh, in world coordinates, or
   * null for a scene that ships none. Owned by whoever calls setNavmesh();
   * this module only ever reads it.
   */
  let navmesh = null;
  /**
   * The same footprint in CANVAS coordinates, rebuilt only when the mapping
   * actually changes (extent, centre, or canvas size). Projecting thousands
   * of triangles every frame is the one thing that would stop this being a
   * cheap overlay, and none of those inputs changes per frame.
   */
  let navmeshCanvasTriangles = null;
  let navmeshCanvasOutline = null;
  let navmeshProjectionKey = "";

  const toX = (x) =>
    canvas.width / 2 + ((x - centerX) / mapExtent) * (canvas.width / 2);
  const toY = (z) =>
    canvas.height / 2 + ((z - centerZ) / mapExtent) * (canvas.height / 2);

  function drawGrid() {
    const s = canvas.width;
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = "rgba(14, 14, 18, 0.75)";
    ctx.fillRect(0, 0, s, s);

    // Lines stay anchored to world multiples of 5 rather than to the map
    // centre, so they read as fixed world features. X and Z need separate
    // sweeps now that the view is not symmetric about the origin.
    const step = 5;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (
      let x = Math.ceil((centerX - mapExtent) / step) * step;
      x <= centerX + mapExtent;
      x += step
    ) {
      ctx.moveTo(toX(x), 0);
      ctx.lineTo(toX(x), s);
    }
    for (
      let z = Math.ceil((centerZ - mapExtent) / step) * step;
      z <= centerZ + mapExtent;
      z += step
    ) {
      ctx.moveTo(0, toY(z));
      ctx.lineTo(s, toY(z));
    }
    ctx.stroke();

    // World origin, brighter. Simply off-canvas (and harmlessly clipped) in
    // scenes whose walkable area sits far from it.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.beginPath();
    ctx.moveTo(toX(0), 0);
    ctx.lineTo(toX(0), s);
    ctx.moveTo(0, toY(0));
    ctx.lineTo(s, toY(0));
    ctx.stroke();
  }

  /** Re-projects the footprint into canvas space if the mapping moved. */
  function projectNavmesh() {
    const key = `${navmesh.revision}|${mapExtent}|${centerX}|${centerZ}|${canvas.width}`;
    if (key === navmeshProjectionKey) return;

    const { triangles, outline } = navmesh;
    const projectedTriangles = new Float64Array(triangles.length);
    for (let i = 0; i < triangles.length; i += 2) {
      projectedTriangles[i] = toX(triangles[i]);
      projectedTriangles[i + 1] = toY(triangles[i + 1]);
    }

    const projectedOutline = new Float64Array(outline.length);
    for (let i = 0; i < outline.length; i += 2) {
      projectedOutline[i] = toX(outline[i]);
      projectedOutline[i + 1] = toY(outline[i + 1]);
    }

    navmeshCanvasTriangles = projectedTriangles;
    navmeshCanvasOutline = projectedOutline;
    navmeshProjectionKey = key;
  }

  /**
   * The walkable area, as a filled region.
   *
   * Every triangle goes into ONE path and is filled once with the default
   * nonzero rule, so shared internal edges disappear and what remains is the
   * union. The footprint has already rewound each triangle to a consistent
   * projected winding — without that, two neighbours of opposite winding
   * would cancel and open a hole that is not in the geometry.
   *
   * A hole in the navmesh is therefore simply an area no triangle covers: it
   * keeps the map's dark background, exactly like the region outside the mesh
   * altogether. The outline is what separates the two readings — it traces
   * the outer border and every hole rim, and nothing in between.
   */
  function drawNavmesh() {
    if (!navmesh) return;
    projectNavmesh();

    const tri = navmeshCanvasTriangles;
    ctx.fillStyle = "rgba(74, 163, 255, 0.20)";
    ctx.beginPath();
    for (let i = 0; i < tri.length; i += 6) {
      ctx.moveTo(tri[i], tri[i + 1]);
      ctx.lineTo(tri[i + 2], tri[i + 3]);
      ctx.lineTo(tri[i + 4], tri[i + 5]);
      ctx.closePath();
    }
    ctx.fill();

    // Skipped for a mesh whose vertices are too poorly welded for boundary
    // detection to mean anything — see FOOTPRINT_OUTLINE_MAX_RATIO. Drawing
    // it then would put back the triangle hatch the fill exists to remove.
    if (!navmesh.outlineReliable) return;

    const edges = navmeshCanvasOutline;
    ctx.strokeStyle = "rgba(120, 190, 255, 0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < edges.length; i += 4) {
      ctx.moveTo(edges[i], edges[i + 1]);
      ctx.lineTo(edges[i + 2], edges[i + 3]);
    }
    ctx.stroke();
  }

  function drawEnvironment(env) {
    if (!env) return;
    ctx.strokeStyle = "rgba(110, 231, 168, 0.45)";
    ctx.lineWidth = 1.5;
    if (env.rect) {
      // room / area footprint (world-space AABB)
      const s = canvas.width / (2 * mapExtent);
      ctx.strokeRect(
        toX(env.x) - (env.rect.w / 2) * s,
        toY(env.z) - (env.rect.d / 2) * s,
        env.rect.w * s,
        env.rect.d * s
      );
      return;
    }
    if (env.canopyRadius) {
      ctx.beginPath();
      ctx.arc(toX(env.x), toY(env.z), (env.canopyRadius / mapExtent) * (canvas.width / 2), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (env.trunkRadius) {
      ctx.fillStyle = "rgba(110, 231, 168, 0.9)";
      ctx.beginPath();
      ctx.arc(toX(env.x), toY(env.z), Math.max(2, (env.trunkRadius / mapExtent) * (canvas.width / 2)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTrail() {
    if (trail.length < 4) return;
    ctx.strokeStyle = "rgba(138, 184, 240, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(toX(trail[0]), toY(trail[1]));
    for (let i = 2; i < trail.length; i += 2) {
      ctx.lineTo(toX(trail[i]), toY(trail[i + 1]));
    }
    ctx.stroke();
  }

  function drawAvatar(x, z, heading) {
    const px = toX(x);
    const py = toY(z);
    const r = Math.max(5, canvas.width * 0.02);
    ctx.save();
    ctx.translate(px, py);
    // world facing vector (sin h, cos h) → canvas (x right, z down).
    // The maths, and why it is π − h, lives in minimapArrowRotation().
    ctx.rotate(minimapArrowRotation(heading));
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.moveTo(0, -r);          // nose
    ctx.lineTo(r * 0.7, r);     // back right
    ctx.lineTo(0, r * 0.55);    // tail notch
    ctx.lineTo(-r * 0.7, r);    // back left
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawCamera(x, z) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(toX(x), toY(z), 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  return {
    /**
     * Call once per frame.
     * @param {object} s { avatarX, avatarZ, heading, camX, camZ, environment }
     */
    update(s) {
      if (canvas.width === 0) return;

      // Record the trail only when the avatar actually moved.
      if (s.avatarX !== undefined) {
        if (lastX === null || Math.hypot(s.avatarX - lastX, s.avatarZ - lastZ) > trailMinStep) {
          trail.push(s.avatarX, s.avatarZ);
          lastX = s.avatarX;
          lastZ = s.avatarZ;
          if (trail.length > maxTrailPoints * 2) trail.splice(0, 2);
        }
      }

      drawGrid();
      // Under everything that describes Seekr: the walkable surface is the
      // backdrop the trail and the arrow are read against.
      drawNavmesh();
      drawEnvironment(s.environment);
      drawTrail();
      if (s.camX !== undefined) drawCamera(s.camX, s.camZ);
      if (s.avatarX !== undefined) drawAvatar(s.avatarX, s.avatarZ, s.heading ?? 0);
    },

    setExtent(v) {
      mapExtent = Math.max(2, v);
    },

    /**
     * Shows (or hides) the walkable NavMesh footprint.
     *
     * Visualization only. The footprint is drawn and nothing else: it is
     * never consulted for movement, never sent anywhere, and never becomes a
     * position source — Seekr's runtime pose still drives the arrow and the
     * trail, and reset() still owns the viewport anchor.
     *
     * @param {object|null} footprint  from projectNavmeshFootprint(), or null
     *   for a scene with no browser NavMesh (the map then draws exactly what
     *   it drew before: grid, environment, trail, arrow, camera dot).
     * @param {object}  [options]
     * @param {boolean} [options.fit]  size the viewport to the walkable area,
     *   so a scene larger than the default extent is not silently clipped.
     *   Only for a NEW scene's footprint — a re-projection after a scene
     *   transform edit must not fight the user's Extent slider.
     * @returns {number} the extent in force afterwards, so the caller can
     *   keep CONFIG and the Extent slider in step with an auto-fit.
     */
    setNavmesh(footprint, { fit = false } = {}) {
      navmesh = footprint ?? null;
      // The cached canvas-space copy belongs to the previous footprint.
      navmeshProjectionKey = "";
      navmeshCanvasTriangles = null;
      navmeshCanvasOutline = null;

      if (!navmesh) {
        // No walkable area to frame: the viewport goes back to Seekr, at
        // whatever pose the last reset anchored it to.
        viewFromNavmesh = false;
        centerX = anchorX;
        centerZ = anchorZ;
        return mapExtent;
      }

      if (fit) {
        const viewport = navmeshViewport(navmesh.bounds);
        if (viewport) {
          centerX = viewport.centerX;
          centerZ = viewport.centerZ;
          mapExtent = viewport.extent;
          viewFromNavmesh = true;
        }
      }

      return mapExtent;
    },

    clearTrail() {
      trail.length = 0;
      lastX = null;
      lastZ = null;
    },

    /**
     * Re-establishes the map around where Seekr actually is: drops the trail
     * and re-anchors the viewport.
     *
     * Call AFTER positioning has finished, with Seekr's real runtime pose —
     * never with an authored defaultStart, which a restored session pose may
     * have overridden. Moves the viewport only; Seekr is never moved to suit
     * the map.
     *
     * ── EVERY TELEPORT ENDS THE TRAIL ─────────────────────────────────────
     * Scene activation, Reset to Scene Start and a benchmark episode reset
     * all place Seekr somewhere he did not walk to. Without a break here the
     * trail draws a straight line across the scene between the two poses, and
     * that line is a claim about where the agent went. Clearing `lastX`/
     * `lastZ` as well as the points is what makes the NEXT recorded position
     * a fresh origin instead of the far end of a phantom segment.
     *
     * ── A NAVMESH KEEPS THE VIEWPORT ──────────────────────────────────────
     * When the map is framed on the walkable area, a reset re-anchors the
     * FALLBACK centre but leaves the view where it is. Recentring on the
     * agent would undo the fit and push most of the scene off the edge.
     */
    reset({ x, z } = {}) {
      trail.length = 0;
      lastX = null;
      lastZ = null;
      if (Number.isFinite(x) && Number.isFinite(z)) {
        anchorX = x;
        anchorZ = z;
        if (!viewFromNavmesh) {
          centerX = x;
          centerZ = z;
        }
      }
    },

    dispose() {
      ro.disconnect();
      wrap.remove();
      // Borrowed geometry: dropped, never disposed — world.js owns the
      // NavMesh and the footprint is a copy of its projected vertices.
      navmesh = null;
      navmeshCanvasTriangles = null;
      navmeshCanvasOutline = null;
      viewFromNavmesh = false;
    },
  };
}
