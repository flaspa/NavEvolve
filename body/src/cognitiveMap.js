/**
 * cognitiveMap.js — renders the cognitive map (hackathon, Milestones 4–5).
 *
 * Read-only view of GET /cognitive-map: place nodes (sized by observation
 * count) and traversal edges. Node positions come from each place's
 * display_xz — a display aid only; the matching policy never sees pose. The
 * physical NavMesh is deliberately NOT drawn here.
 *
 * Milestone 5: every node is clickable and opens the Place Memory Inspector,
 * which browses that place's observations through the existing
 * GET /observations/{id} and GET /observations/{id}/image.jpg endpoints.
 */

export function createCognitiveMap({ mount, footer, brainUrl = "" }) {
  mount.textContent = "";
  const canvas = document.createElement("canvas");
  canvas.className = "cognitive-map-canvas";
  const empty = document.createElement("div");
  empty.className = "cognitive-map-empty";
  empty.textContent = "Awaiting observations";
  mount.append(canvas, empty);

  let lastGraph = null;
  let hitTargets = []; // [{ place, x, y, r }] in CSS pixels, from the last draw
  let hoveredId = null;
  let selectedId = null;

  function draw(graph) {
    lastGraph = graph;
    const places = graph?.places ?? [];
    empty.style.display = places.length ? "none" : "";
    const dpr = window.devicePixelRatio || 1;
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    hitTargets = [];
    if (!places.length) return;

    const xs = places.map((p) => p.display_xz[0]);
    const zs = places.map((p) => p.display_xz[1]);
    const pad = 18;
    const spanX = Math.max(1e-3, Math.max(...xs) - Math.min(...xs));
    const spanZ = Math.max(1e-3, Math.max(...zs) - Math.min(...zs));
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanZ);
    const ox = (w - spanX * scale) / 2 - Math.min(...xs) * scale;
    const oz = (h - spanZ * scale) / 2 - Math.min(...zs) * scale;
    const pos = new Map(places.map((p) => [p.place_id, [p.display_xz[0] * scale + ox, p.display_xz[1] * scale + oz]]));

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(158, 203, 255, 0.55)";
    for (const e of graph.edges ?? []) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }

    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of places) {
      const [x, y] = pos.get(p.place_id);
      const n = p.observation_ids.length;
      const r = 6 + Math.min(8, (n - 1) * 2.5);
      hitTargets.push({ place: p, x, y, r: r + 3 });
      const active = p.place_id === hoveredId || p.place_id === selectedId;
      if (active) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = n > 1 ? "rgba(224, 196, 138, 0.95)" : "rgba(158, 203, 255, 0.9)";
      ctx.fill();
      ctx.fillStyle = "#15161a";
      ctx.fillText(String(n), x, y + 0.5);
    }
  }

  function hitTest(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return hitTargets.find((t) => Math.hypot(t.x - x, t.y - y) <= t.r) ?? null;
  }

  canvas.addEventListener("mousemove", (event) => {
    const hit = hitTest(event);
    const id = hit?.place.place_id ?? null;
    canvas.style.cursor = hit ? "pointer" : "";
    if (id !== hoveredId) {
      hoveredId = id;
      draw(lastGraph);
    }
  });
  canvas.addEventListener("mouseleave", () => {
    if (hoveredId !== null) {
      hoveredId = null;
      draw(lastGraph);
    }
  });
  canvas.addEventListener("click", (event) => {
    const hit = hitTest(event);
    if (hit) inspector.open(hit.place);
  });

  function setFooter(data) {
    const g = data?.graph;
    const h = data?.harness ?? {};
    // The graph's policy is the one that built the displayed map; the metric
    // label names exactly what the harness measured (e.g. "held-out revisit F1").
    const version = g?.policy?.version;
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
    const baseline = h.baseline_version ? `v${h.baseline_version}` : "before";
    const metric = h.metric_label ?? "score";
    footer.policy.textContent =
      `Active policy: ${version ? `v${version}` : "—"} · ${metric}: ${baseline} ${fmt(h.score_before)} → ` +
      `${version ? `v${version}` : "after"} ${fmt(h.score_after)} · ${g?.places?.length ?? 0} places`;
    footer.policy.title = h.last_result ?? "";
    footer.harness.textContent = `Harness: ${h.status ?? "idle"}`;
    footer.harness.title = h.last_result ?? "";
  }

  const inspector = createPlaceInspector({
    brainUrl,
    anchor: mount,
    onClose: () => {
      selectedId = null;
      draw(lastGraph);
    },
  });

  window.addEventListener("resize", () => draw(lastGraph));

  return {
    update(data) {
      draw(data?.graph ?? null);
      setFooter(data);
      // Keep an open inspector attached to the same place after a refresh.
      if (selectedId) {
        const place = (data?.graph?.places ?? []).find((p) => p.place_id === selectedId);
        if (place) inspector.refresh(place);
        else inspector.close();
      }
    },
    /** Opens the inspector for a place id (also used by the debug handle). */
    openPlace(placeId) {
      const place = (lastGraph?.places ?? []).find((p) => p.place_id === placeId);
      if (place) inspector.open(place);
      return Boolean(place);
    },
    /** Node hit targets from the last draw, in canvas CSS pixels (debug). */
    hitTargets: () => hitTargets.map((t) => ({ place_id: t.place.place_id, x: t.x, y: t.y, r: t.r })),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Place Memory Inspector — a fixed panel beside the sidebar, so the map
  // stays visible. Everything it shows comes from /observations/{id}.
  // ─────────────────────────────────────────────────────────────────────────
  function createPlaceInspector({ brainUrl, anchor, onClose }) {
    const root = document.createElement("div");
    root.id = "place-inspector";
    root.hidden = true;
    root.innerHTML = `
      <div class="pi-head">
        <div>
          <div class="pi-title" data-role="title">Place</div>
          <div class="pi-sub" data-role="subtitle"></div>
        </div>
        <button type="button" class="pi-close" data-role="close" title="Close">×</button>
      </div>
      <div class="pi-photo">
        <img data-role="image" alt="Egocentric observation" />
        <div class="pi-photo-note" data-role="photo-note"></div>
      </div>
      <div class="pi-nav">
        <button type="button" data-role="prev" title="Previous observation">‹ Prev</button>
        <span data-role="index"></span>
        <button type="button" data-role="next" title="Next observation">Next ›</button>
      </div>
      <div class="pi-meta" data-role="meta"></div>
      <div class="pi-desc" data-role="description"></div>
      <div class="pi-objects" data-role="objects"></div>`;
    document.body.appendChild(root);

    // The panel sits above the world canvas, so its clicks never reach the
    // pointer-lock handler. Stop propagation as well, so no window-level
    // listener can mistake them for scene input.
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
      root.addEventListener(type, (e) => e.stopPropagation());
    }

    const el = (role) => root.querySelector(`[data-role="${role}"]`);
    const img = el("image");
    const cache = new Map(); // observation id → metadata document
    let place = null;
    let index = 0;
    let requestId = 0;

    el("close").addEventListener("click", close);
    el("prev").addEventListener("click", () => step(-1));
    el("next").addEventListener("click", () => step(1));
    img.addEventListener("error", () => {
      el("photo-note").textContent = "Image unavailable";
    });

    function position() {
      const rect = anchor.closest("#cognitive-map")?.getBoundingClientRect() ?? anchor.getBoundingClientRect();
      const sidebar = document.getElementById("sidebar")?.getBoundingClientRect();
      const right = sidebar ? window.innerWidth - sidebar.left + 10 : 324;
      root.style.right = `${right}px`;
      root.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - root.offsetHeight - 12))}px`;
    }

    async function fetchObservation(id) {
      if (cache.has(id)) return cache.get(id);
      const response = await fetch(`${brainUrl}/observations/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const doc = await response.json();
      cache.set(id, doc);
      return doc;
    }

    function describe(doc) {
      if (doc?.perception?.status !== "done") return "Not yet enriched.";
      const d = doc.description;
      if (d && typeof d === "object") {
        const parts = [];
        if (d.room_type) parts.push(`${d.room_type}`);
        if (d.summary) parts.push(d.summary);
        const landmarks = Array.isArray(d.landmarks) ? d.landmarks : [];
        if (landmarks.length) parts.push(`Landmarks: ${landmarks.join("; ")}`);
        if (parts.length) return parts.join("\n");
      }
      return doc.description_text || "Not yet enriched.";
    }

    async function loadObjects() {
      const box = el("objects");
      box.textContent = "";
      const sceneId = document.querySelector("#hud")?.dataset.sceneId ?? window.__seekr?.scene?.id;
      if (!sceneId) return;
      try {
        const r = await fetch(`${brainUrl}/places/${encodeURIComponent(place.place_id)}/objects?scene_id=${encodeURIComponent(sceneId)}`);
        if (!r.ok) return;
        const { items } = await r.json();
        if (!items.length) { box.textContent = "No object memories in this place yet."; return; }
        const title = document.createElement("div");
        title.className = "pi-objects-title";
        title.textContent = `${items.length} remembered object${items.length === 1 ? "" : "s"} here`;
        box.append(title);
        for (const o of items.slice(0, 12)) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "pi-object";
          const tag = o.location_method === "splat-bbox-raycast" ? "grounded" : o.position ? "approx." : "no position";
          row.textContent = `${o.display_name ?? o.name} · ${o.sighting_count ?? 1}× · ${tag}`;
          row.title = o.description ?? "";
          // Jump to a supporting observation of this object that belongs to this place.
          const target = (o.obs_ids ?? []).find((id) => place.observation_ids.includes(id));
          row.disabled = !target;
          row.addEventListener("click", () => { index = place.observation_ids.indexOf(target); show(); });
          box.append(row);
        }
      } catch (_) { /* backend offline: leave empty */ }
    }

    async function show() {
      const ids = place.observation_ids;
      const id = ids[index];
      const n = ids.length;
      const myRequest = ++requestId;
      el("title").textContent = `Place ${place.place_id}`;
      el("subtitle").textContent = `${n} observation${n === 1 ? "" : "s"}`;
      el("index").textContent = `${index + 1} / ${n}`;
      el("prev").disabled = index === 0;
      el("next").disabled = index >= n - 1;
      el("photo-note").textContent = "";
      img.src = `${brainUrl}/observations/${encodeURIComponent(id)}/image.jpg`;
      el("meta").textContent = `Observation ${id}`;
      el("description").textContent = "Loading…";
      try {
        const doc = await fetchObservation(id);
        if (myRequest !== requestId) return; // superseded by a newer navigation
        const range = doc.range?.distanceM;
        const when = Number.isFinite(doc.timestamp) ? new Date(doc.timestamp).toLocaleTimeString() : "";
        el("meta").textContent =
          `Observation ${id}\nRange ${Number.isFinite(range) ? `${range.toFixed(2)} m` : "no surface"} ahead` +
          `${when ? ` · ${when}` : ""}${doc.trigger ? ` · ${doc.trigger}` : ""}`;
        el("description").textContent = describe(doc);
      } catch (err) {
        if (myRequest !== requestId) return;
        el("description").textContent = `Could not load observation — ${err.message}`;
      }
      position();
    }

    function step(delta) {
      const next = index + delta;
      if (!place || next < 0 || next >= place.observation_ids.length) return;
      index = next;
      show();
    }

    function open(nextPlace) {
      const samePlace = place?.place_id === nextPlace.place_id;
      place = nextPlace;
      if (!samePlace) index = 0;
      selectedId = place.place_id;
      root.hidden = false;
      draw(lastGraph);
      show();
      loadObjects();
    }

    function refresh(nextPlace) {
      place = nextPlace;
      index = Math.min(index, place.observation_ids.length - 1);
      show();
    }

    function close() {
      if (root.hidden) return;
      root.hidden = true;
      place = null;
      onClose();
    }

    window.addEventListener("resize", () => {
      if (!root.hidden) position();
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Escape" && !root.hidden) close();
    });

    return { open, refresh, close };
  }
}
