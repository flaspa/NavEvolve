/**
 * talk.js — "Talk to Seekr" (hackathon, Milestone 6).
 *
 * A typed instruction is routed by a few explicit rules; every answer is
 * grounded in what is actually stored in MongoDB (observations with their
 * Gemini descriptions, and the cognitive map's places). Navigation reuses the
 * teammate's agentControl (A* over the NavMesh grid) and targets a REAL
 * observation pose — never a place centroid, which is display-only.
 *
 * Gemini (through the Brain) is used only where language is needed:
 *   "what do you see here"  → capture, enrich, read back the description
 *   arrival verification     → POST /talk/verify on the arrival observation
 *   anything else            → POST /talk, grounded in matching memories
 */

const STOP_RE = /^\s*(stop|cancel|halt)\b/i;
const PLACES_RE = /\b(what|which)\b.*\b(places?|rooms?)\b.*\b(remember|know|seen|visited)|\bremember\b.*\bplaces?\b/i;
const SEEN_RE = /\b(have you|did you|do you)\s+(ever\s+)?(see|seen|remember|know|notice)\s+(a|an|the|any)?\s*(.+?)[?.!\s]*$/i;
const GOTO_RE = /\b(take me|go|navigate|walk|bring me|head|return|lead me)\s+(back\s+)?(to|towards)\s+(the\s+)?(place\s+where\s+you\s+(saw|found|noticed)\s+)?(the\s+|a\s+|an\s+)?(.+?)[?.!\s]*$/i;
const HERE_RE = /\b(what|describe).*\b(see|seeing|look|view|here|around)\b/i;

const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "and", "with", "room", "place", "area", "space"]);

/** Words of a query that carry meaning, singularised crudely ("tables" → "table"). */
function terms(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ies)$/, "y").replace(/(s)$/, ""));
}

export function createTalk({ ui, agent, brainUrl, getScene, captureObservation, say = ui.addMessage }) {
  let busy = false;
  let currentGoal = null;

  async function getJson(path, init) {
    const res = await fetch(`${brainUrl}${path}`, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
    return body;
  }

  /** Enriched observations of the active scene, newest first (metadata only). */
  async function memories() {
    const scene = getScene();
    const data = await getJson(`/observations?limit=100${scene ? `&scene_id=${encodeURIComponent(scene.id)}` : ""}`);
    return data.items.filter((o) => o.perception?.status === "done" && o.description_text);
  }

  /** Observations whose description mentions the query terms, best first. */
  function search(items, query) {
    const q = terms(query);
    if (!q.length) return [];
    return items
      .map((o) => {
        const text = o.description_text.toLowerCase();
        const hits = q.filter((t) => text.includes(t));
        const inLandmarks = (o.description?.landmarks ?? []).join(" ").toLowerCase();
        const bonus = q.filter((t) => inLandmarks.includes(t)).length;
        return { o, score: hits.length / q.length + 0.25 * bonus };
      })
      .filter((m) => m.score >= 1) // every term must appear
      .sort((a, b) => b.score - a.score);
  }

  const where = (o) => `(${o.pose.x.toFixed(1)}, ${o.pose.z.toFixed(1)})`;
  const when = (o) => new Date(o.timestamp).toLocaleTimeString();
  const summary = (o) => o.description?.summary ?? o.description_text.split("\n")[0];

  async function listPlaces() {
    const scene = getScene();
    const data = await getJson(`/cognitive-map?scene_id=${encodeURIComponent(scene.id)}`);
    const places = data.graph?.places ?? [];
    if (!places.length) return say("Seekr", "I have no remembered places in this scene yet.");
    const lines = places.map((p) => `${p.place_id} (${p.observation_ids.length} obs): ${p.description || "no description yet"}`);
    say("Seekr", `I remember ${places.length} places in this scene:\n${lines.join("\n")}`);
  }

  async function haveSeen(query) {
    const hits = search(await memories(), query);
    if (!hits.length) return say("Seekr", `I have no memory of "${query}" in this scene.`);
    const best = hits[0].o;
    say("Seekr", `Yes — I saw "${query}" at ${when(best)} near ${where(best)}: ${summary(best)}` +
      (hits.length > 1 ? ` (${hits.length} matching memories.)` : ""));
  }

  async function navigateTo(query) {
    if (agent.busy?.()) return say("Seekr", "I'm already moving — say \"stop\" first.");
    const hits = search(await memories(), query);
    if (!hits.length) return say("Seekr", `Not found: I have no memory of "${query}" in this scene, so I can't take you there.`);

    // A real viewpoint from which the object was described; skip ones off the NavMesh.
    const target = hits.find((h) => agent.debug.onNavmesh(h.o.pose.x, h.o.pose.z));
    if (!target) return say("Seekr", `I remember "${query}" but none of those viewpoints is on the walkable surface.`);
    const o = target.o;
    currentGoal = query;
    say("Seekr", `I saw "${query}" at ${when(o)} near ${where(o)}. Walking there now…`);

    let result;
    try {
      result = await agent.goto({ x: o.pose.x, z: o.pose.z, stopWithin: 0.35 });
    } catch (err) {
      currentGoal = null;
      return say("Seekr", `I couldn't start walking — ${err.message}`);
    }
    if (currentGoal !== query) return; // stopped or replaced meanwhile
    if (result.status !== "arrived") {
      currentGoal = null;
      return say("Seekr", result.status === "unreachable"
        ? `Unreachable: no NavMesh path from here to ${where(o)}.`
        : `Blocked: I stopped after ${result.pathLength} m at (${result.pose.x.toFixed(1)}, ${result.pose.z.toFixed(1)}).`);
    }
    say("Seekr", `Arrived near ${where(o)} after ${result.pathLength} m. Facing the remembered view…`);
    await agent.turn({ deg: ((o.pose.headingDeg - result.pose.headingDeg + 540) % 360) - 180 });

    const obs = await captureObservation("agent-arrival");
    currentGoal = null;
    if (!obs?.id) return say("Seekr", "Arrived, but I couldn't store a new view to verify against.");
    try {
      const v = await getJson("/talk/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observation_id: obs.id, goal: query }),
      });
      say("Seekr", v.visible ? `Verified: I can see "${query}" here. ${v.reason}` : `Arrived, but not verified: I don't see "${query}" from here. ${v.reason}`);
    } catch (err) {
      say("Seekr", `Arrived (verification unavailable: ${err.message}).`);
    }
  }

  async function describeHere() {
    const obs = await captureObservation("talk");
    if (!obs?.id) return say("Seekr", "I couldn't capture a view right now.");
    say("Seekr", "Looking… (asking Gemini to describe this view)");
    const r = await getJson(`/observations/${encodeURIComponent(obs.id)}/enrich`, { method: "POST" });
    say("Seekr", r.description?.summary ?? r.description_text ?? "I couldn't describe this view.");
  }

  async function freeform(text) {
    const items = await memories();
    const hits = search(items, text).slice(0, 8).map((h) => h.o);
    const pool = (hits.length ? hits : items.slice(0, 8)).map((o) => ({ id: o.id, description_text: o.description_text }));
    const r = await getJson("/talk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, memories: pool }),
    });
    say("Seekr", r.answer);
  }

  function stop() {
    const wasMoving = agent.busy?.();
    currentGoal = null;
    agent.halt();
    say("Seekr", wasMoving ? "Stopped." : "Nothing to stop.");
  }

  async function handle(text) {
    const clean = text.replace(/^\s*seekr[,:!]?\s*/i, "").trim();
    say("You", text);
    if (STOP_RE.test(clean)) return stop();
    if (busy) return say("Seekr", "One moment — I'm still working on the previous request (or say \"stop\").");
    busy = true;
    try {
      let m;
      if (PLACES_RE.test(clean)) await listPlaces();
      else if ((m = GOTO_RE.exec(clean))) await navigateTo(m[8]);
      else if ((m = SEEN_RE.exec(clean))) await haveSeen(m[5]);
      else if (HERE_RE.test(clean)) await describeHere();
      else await freeform(clean);
    } catch (err) {
      say("Seekr", `Sorry — ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return { handle, stop, search, terms };
}
