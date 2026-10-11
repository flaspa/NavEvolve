/**
 * cognitiveMap.js — renders the cognitive map (hackathon, Milestone 4).
 *
 * Read-only view of GET /cognitive-map: place nodes (sized by observation
 * count) and traversal edges. Node positions come from each place's
 * display_xz — a display aid only; the matching policy never sees pose. The
 * physical NavMesh is deliberately NOT drawn here.
 */

export function createCognitiveMap({ mount, footer }) {
  mount.textContent = "";
  const canvas = document.createElement("canvas");
  canvas.className = "cognitive-map-canvas";
  const empty = document.createElement("div");
  empty.className = "cognitive-map-empty";
  empty.textContent = "Awaiting observations";
  mount.append(canvas, empty);

  let lastGraph = null;

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
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = n > 1 ? "rgba(224, 196, 138, 0.95)" : "rgba(158, 203, 255, 0.9)";
      ctx.fill();
      ctx.fillStyle = "#15161a";
      ctx.fillText(String(n), x, y + 0.5);
    }
  }

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

  window.addEventListener("resize", () => draw(lastGraph));

  return {
    update(data) {
      draw(data?.graph ?? null);
      setFooter(data);
    },
  };
}
