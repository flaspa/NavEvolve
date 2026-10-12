/**
 * harnessView.js — read-only "Harness Evolution" tab (hackathon demo).
 *
 * Shows what the recursive harness actually did: policy versions and their
 * weights, each optimisation run's selection vs held-out metrics before/after,
 * and the saved cognitive graphs per policy. Picking a saved graph re-renders
 * the EXISTING Cognitive Map panel with it (same cognitiveMap.update) and shows
 * a diff against the previously saved graph. Nothing here writes anything.
 */

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : "—");

export function createHarnessView({ mount, brainUrl, getScene, cognitiveMap, onLiveMap }) {
  mount.innerHTML = `<div class="hv-status">Loading harness history…</div>
    <div data-role="hv-body"></div>`;
  const body = mount.querySelector('[data-role="hv-body"]');
  let history = null;

  async function getJson(path) {
    const r = await fetch(`${brainUrl}${path}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function metricCell(m, key) {
    const v = m?.[key];
    return key === "score" ? fmt(v) : fmt(v);
  }

  function render(h) {
    const scene = getScene()?.id;
    const policies = h.policies;
    const runs = h.runs;
    const graphs = h.graphs.filter((g) => !scene || g.scene_id === scene);
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="hv-note">Read-only view of <code>harness_policies</code>, <code>harness_runs</code> and <code>cognitive_graphs</code>.
        Scores are revisit-pair metrics on pose-derived reference pairs: <b>selection</b> split chooses the policy,
        <b>held-out</b> split only measures it. Selection gains are <i>not</i> evidence of generalisation or better navigation.</div>
      <h4>Policies</h4>
      <table class="hv-table"><thead><tr><th>v</th><th>visual</th><th>semantic</th><th>range</th><th>thr</th><th>adopted</th><th>objective</th></tr></thead><tbody>
        ${policies.map((p) => `<tr><td>v${p.version}</td><td>${p.w_visual}</td><td>${p.w_semantic}</td><td>${p.w_range}</td><td>${p.threshold}</td>
          <td>${new Date(p.adopted_at).toLocaleTimeString()}${p.parent ? ` (from v${p.parent})` : ""}</td><td>${p.objective ?? (p.parent ? "balanced_accuracy" : "—")}</td></tr>`).join("")}
      </tbody></table>
      <h4>Optimisation runs</h4>
      ${runs.map((r) => {
        const obj = r.objective ?? "balanced_accuracy";
        const key = obj === "f1" ? "f1" : "score";
        const sb = r.before.selection, hb = r.before.held_out, sa = r.after?.selection, ha = r.after?.held_out;
        const dSel = sa ? sa[key] - sb[key] : null, dHeld = ha ? ha[key] - hb[key] : null;
        const verdict = !r.adopted ? "no candidate adopted"
          : dHeld > 0 ? "held-out improved" : "selection improved only — no demonstrated held-out improvement";
        return `<div class="hv-run">
          <div class="hv-run-head">v${r.policy_before.version} → v${r.policy_after.version} · ${new Date(r.ran_at).toLocaleTimeString()} · objective <b>${obj === "f1" ? "revisit F1" : "balanced accuracy"}</b> · ${r.candidates_evaluated ?? "?"} candidates · ${r.observations} obs</div>
          <table class="hv-table"><thead><tr><th></th><th>before</th><th>after</th><th>Δ</th><th>missed→</th><th>false merges→</th></tr></thead><tbody>
            <tr><td>selection</td><td>${fmt(sb[key])}</td><td>${fmt(sa?.[key])}</td><td class="${dSel > 0 ? "up" : dSel < 0 ? "down" : ""}">${dSel == null ? "—" : (dSel >= 0 ? "+" : "") + fmt(dSel)}</td><td>${sb.missed_revisits}→${sa?.missed_revisits ?? "—"}</td><td>${sb.false_merges}→${sa?.false_merges ?? "—"}</td></tr>
            <tr><td><b>held-out</b></td><td>${fmt(hb[key])}</td><td>${fmt(ha?.[key])}</td><td class="${dHeld > 0 ? "up" : dHeld < 0 ? "down" : ""}">${dHeld == null ? "—" : (dHeld >= 0 ? "+" : "") + fmt(dHeld)}</td><td>${hb.missed_revisits}→${ha?.missed_revisits ?? "—"}</td><td>${hb.false_merges}→${ha?.false_merges ?? "—"}</td></tr>
          </tbody></table>
          <div class="hv-verdict ${dHeld > 0 ? "up" : "down"}">${verdict}${r.result ? ` · recorded: “${r.result}”` : ""} · graph: ${r.places} places, ${r.edges} edges</div>
        </div>`;
      }).join("") || "<div>No optimisation runs recorded.</div>"}
      <h4>Saved cognitive graphs</h4>
      <div class="hv-row"><select data-role="hv-graph">${graphs.map((g, i) => `<option value="${g.id}">${new Date(g.built_at).toLocaleTimeString()} · policy v${g.policy.version} · ${g.places} places · ${g.edges} edges · ${g.observations} obs</option>`).join("")}</select>
        <button type="button" data-role="hv-show">Show on map</button><button type="button" data-role="hv-live">Back to live</button></div>
      <div class="hv-diff" data-role="hv-diff"></div>
      <div class="hv-note">Atlas Charts: in your Atlas project open <b>Charts → Add Dashboard → Add Chart</b>, data source <code>navevolve</code>.
        Line chart <code>harness_policies</code>: x = <code>version</code>, y = <code>held_out_score</code> and <code>selection_score</code>.
        Table <code>harness_runs</code>: <code>policy_before.version</code>, <code>policy_after.version</code>, <code>before.held_out.f1</code>, <code>after.held_out.f1</code>, <code>result</code> (filter <code>_id ≠ "status"</code>).
        Bar <code>cognitive_graphs</code>: x = <code>built_at</code>, y = size of <code>places</code> (use <code>$size</code> in a calculated field), color = <code>policy.version</code>.</div>`;
    body.replaceChildren(el);
    mount.querySelector(".hv-status").textContent = `${policies.length} policies · ${runs.length} runs · ${graphs.length} saved graphs${scene ? ` in ${scene}` : ""}`;
    const select = el.querySelector('[data-role="hv-graph"]');
    el.querySelector('[data-role="hv-show"]').addEventListener("click", () => showGraph(select.value, graphs));
    el.querySelector('[data-role="hv-live"]').addEventListener("click", () => { el.querySelector('[data-role="hv-diff"]').textContent = ""; onLiveMap(); });
  }

  /** Observations whose set of co-members changed between two graphs. */
  function assignmentDiff(prev, cur) {
    const members = (g) => { const m = new Map(); for (const p of g.places) { const key = [...p.observation_ids].sort().join(","); for (const o of p.observation_ids) m.set(o, key); } return m; };
    const a = members(prev), b = members(cur);
    let changed = 0, shared = 0;
    for (const [o, k] of b) if (a.has(o)) { shared++; if (a.get(o) !== k) changed++; }
    return { shared, changed, added: [...b.keys()].filter((o) => !a.has(o)).length };
  }

  async function showGraph(graphId, graphs) {
    const idx = graphs.findIndex((g) => g.id === graphId);
    const cur = await getJson(`/cognitive-map?graph_id=${encodeURIComponent(graphId)}`);
    // Footer numbers must belong to THIS graph's policy: use the run that produced it (or that adopted its policy).
    const v = cur.graph.policy.version;
    const run = history.runs.find((r) => r.graph_id === graphId) ?? history.runs.find((r) => r.policy_after.version === v);
    const key = run?.objective === "f1" ? "f1" : "score";
    const harness = run ? {
      status: `viewing saved graph (policy v${v})`, view_label: "Saved graph · policy",
      metric_label: `held-out ${run.objective === "f1" ? "revisit F1" : "balanced accuracy"}`,
      baseline_version: run.policy_before.version, score_before: run.before.held_out[key], score_after: run.after?.held_out?.[key],
    } : { status: `viewing saved graph (policy v${v})`, view_label: "Saved graph · policy", metric_label: "no run recorded", baseline_version: null };
    cognitiveMap.update({ graph: cur.graph, harness });
    const diffEl = body.querySelector('[data-role="hv-diff"]');
    const prev = graphs[idx - 1];
    if (!prev) { diffEl.textContent = `Showing the earliest saved graph: ${cur.graph.places.length} places, ${cur.graph.edges.length} edges.`; return; }
    const prevG = await getJson(`/cognitive-map?graph_id=${encodeURIComponent(prev.id)}`);
    const d = assignmentDiff(prevG.graph, cur.graph);
    diffEl.textContent = `vs previous saved graph (policy v${prevG.graph.policy.version}): places ${prevG.graph.places.length} → ${cur.graph.places.length}, edges ${prevG.graph.edges.length} → ${cur.graph.edges.length}; ` +
      `${d.changed} of ${d.shared} shared observations changed place grouping, ${d.added} new observations.`;
  }

  async function load() {
    try {
      history = await getJson("/harness/history");
      render(history);
    } catch (err) {
      mount.querySelector(".hv-status").textContent = `Harness history unavailable — ${err.message}`;
    }
  }

  return { load };
}
