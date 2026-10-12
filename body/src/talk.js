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
const PLACE_OBJECTS_RE = /\b(what|which)\s+(objects?|things?|items?|furniture)\b.*\b(in|at|inside)\s+(the\s+)?(.+?)[?.!\s]*$/i;
const PLACES_WITH_RE = /\b(which|what)\s+(places?|rooms?|areas?)\b.*\b(contain|have|has|with)\s+(.+?)[?.!\s]*$/i;
const WHERE_RE = /\b(where|show me where)\b.*\b(see|seen|saw|is|was|find)\b.*?\b(the|a|an)?\s*([a-z][a-z0-9 -]+?)[?.!\s]*$/i;
const SEEN_RE = /\b(have you|did you|do you)\s+(ever\s+)?(see|seen|remember|know|notice)\s+(a|an|the|any)?\s*(.+?)[?.!\s]*$/i;
// Navigation: a leading movement verb, then filler words are stripped until
// the object phrase ("go stand next to the big table" → "big table").
const NAV_VERBS = new Set(["take", "bring", "lead", "go", "walk", "navigate", "head", "return", "move",
  "find", "locate", "look", "search", "stand", "get", "run", "proceed"]);
const POLITE = /^(please\s+|can you\s+|could you\s+|would you\s+|now\s+)+/i;
const NAV_FILLER = new Set([...NAV_VERBS, "me", "us", "over", "back", "and", "then", "please", "to", "towards",
  "toward", "next", "near", "nearby", "by", "beside", "in", "front", "of", "at", "for", "up", "out", "the", "a",
  "an", "some", "that", "this", "your", "place", "spot", "location", "room", "area", "where", "you", "saw", "found",
  "noticed", "seen", "remember", "remembered", "spotted", "there", "again", "closer"]);

/** Object phrase of a navigation command, or null when it is not one. */
export function navigationTarget(text) {
  const words = String(text).replace(POLITE, "").toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").trim().split(/\s+/);
  if (!words.length || !NAV_VERBS.has(words[0])) return null;
  let i = 0;
  while (i < words.length && NAV_FILLER.has(words[i])) i += 1;
  const target = words.slice(i).join(" ").trim();
  return target || null;
}
const HERE_RE = /\b(what|describe).*\b(see|seeing|look|view|here|around)\b/i;
// Free exploration: "explore this area", "explore a large area", "look around and tell me what you discover",
// "find something you haven't seen before".
const EXPLORE_RE = /^(please\s+|can you\s+|could you\s+|go\s+)?(explore|scout|survey|wander|map out|look around)\b/i;
const EXPLORE_LARGE_RE = /\b(large|larger|big|bigger|whole|entire|wide|wider|everything|far|thorough)/i;
const EXPLORE_NOVEL_RE = /\b(something|anything|places?|areas?)\s+(new|unseen|you haven'?t seen|you have not seen|i haven'?t seen)/i;

const STOP_WORDS = new Set(["the", "a", "an", "of", "in", "on", "at", "to", "and", "with", "room", "place", "area", "space"]);

/** Words of a query that carry meaning, singularised crudely ("tables" → "table"). */
function terms(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ies)$/, "y").replace(/(s)$/, ""));
}

export const AGENT_NAME = "NavEvolve Agent";

export function createTalk({ ui, agent, brainUrl, getScene, captureObservation, getLastFrame = () => null,
  locateBbox = () => null, say = ui.addMessage }) {
  let busy = false;
  let currentGoal = null;
  let exploring = false;
  let taskGen = 0; // bumped on start/stop: any await that outlives its task throws Cancelled
  class Cancelled extends Error {}
  const guard = (gen) => { if (gen !== taskGen || !exploring) throw new Cancelled("cancelled"); };

  /** Bounded exploration modes (steps, elapsed time, Gemini requests). */
  const MODES = {
    local: { label: "local exploration", maxSteps: 3, maxMs: 180_000, maxGemini: 14, headings: 2, enrich: true, verify: false, minSeparationM: 1.0 },
    large: { label: "large-area exploration", maxSteps: 8, maxMs: 480_000, maxGemini: 32, headings: 2, enrich: true, verify: false, minSeparationM: 2.5 },
    find: { label: "object search", maxSteps: 6, maxMs: 300_000, maxGemini: 30, headings: 2, enrich: false, verify: true, minSeparationM: 0.75 },
  };
  const EXPLORE_MAX_STEPS = MODES.find.maxSteps;
  const EXPLORE_MAX_MS = MODES.find.maxMs;
  const reply = (text) => say(AGENT_NAME, text);
  /** Narrated decision; with a frame, shows its thumbnail (ui.addMessageWithFrame). */
  const narrate = (text, frame = null) => {
    if (frame?.jpegDataUrl && ui.addMessageWithFrame) {
      ui.addMessageWithFrame(AGENT_NAME, text, { imageDataUrl: frame.jpegDataUrl, altText: frame.obsId ?? "observation",
        captureTime: frame.ts, obsId: frame.obsId });
    } else reply(text);
  };
  const side = (p, f) => {
    const dx = f.x - p.x, dz = f.z - p.z;
    const h = (p.headingDeg * Math.PI) / 180;
    const cross = dx * Math.cos(h) - dz * Math.sin(h); // app convention: heading 0 faces +Z
    const ahead = dx * Math.sin(h) + dz * Math.cos(h);
    if (Math.abs(cross) < 0.35 * Math.abs(ahead)) return ahead >= 0 ? "ahead" : "behind";
    return cross > 0 ? "to the left" : "to the right";
  };

  /** A backend error, distinct from "no memory": says which endpoint failed. */
  async function getJson(path, init) {
    let res;
    try {
      res = await fetch(`${brainUrl}${path}`, init);
    } catch (err) {
      throw new Error(`Backend unreachable at ${brainUrl} (${err.message})`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const endpoint = path.split("?")[0];
      if (res.status === 404 && (body?.detail === "Not Found" || body === null)) {
        throw new Error(`Backend endpoint ${endpoint} is not available (HTTP 404) — the running brain/server.py predates it; restart the backend.`);
      }
      throw new Error(`Backend ${endpoint} failed (HTTP ${res.status}): ${body?.detail ?? "no detail"}`);
    }
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

  /** Full-phrase matches first; otherwise memories mentioning the head noun ("big table" → "table"). */
  function searchLoose(items, query) {
    const exact = search(items, query);
    if (exact.length) return { hits: exact, loose: false };
    const q = terms(query);
    const head = q.at(-1);
    if (!head || q.length < 2) return { hits: [], loose: false };
    return { hits: search(items, head), loose: true, head };
  }

  const where = (o) => `(${o.pose.x.toFixed(1)}, ${o.pose.z.toFixed(1)})`;
  const when = (o) => new Date(o.timestamp).toLocaleTimeString();
  const summary = (o) => o.description?.summary ?? o.description_text.split("\n")[0];

  async function listPlaces() {
    const scene = getScene();
    const data = await getJson(`/cognitive-map?scene_id=${encodeURIComponent(scene.id)}`);
    const places = data.graph?.places ?? [];
    if (!places.length) return reply("I have no remembered places in this scene yet.");
    const lines = places.map((p) => `${p.place_id} (${p.observation_ids.length} obs): ${p.description || "no description yet"}`);
    reply(`I remember ${places.length} places in this scene:\n${lines.join("\n")}`);
  }

  let pendingOffer = null;

  /** Semantic object memory (768-d cosine over object embeddings) with place links. */
  async function objectMemories(query, k = 5) {
    const scene = getScene();
    try {
      const r = await getJson(`/objects/search?scene_id=${encodeURIComponent(scene.id)}&q=${encodeURIComponent(query)}&k=${k}`);
      return r.items;
    } catch (err) {
      console.warn("[talk] semantic search unavailable:", err.message);
      return [];
    }
  }
  const placePhrase = (o) => (o.place_id ? ` in ${o.place_label ? `a place I recognize as "${o.place_label}"` : `place ${o.place_id}`}` : " in a place not yet in my map");
  const evidencePhrase = (o) => `${o.sighting_count ?? 1} sighting${(o.sighting_count ?? 1) === 1 ? "" : "s"}, ${o.obs_ids.length} supporting observation${o.obs_ids.length === 1 ? "" : "s"}`;

  async function haveSeen(query) {
    const objs = await objectMemories(query, 3);
    if (objs.length) {
      const o = objs[0];
      const pos = o.position ? ` Approximate position (${o.position[0].toFixed(1)}, ${o.position[2].toFixed(1)})${o.location_method === "splat-bbox-raycast" ? ", grounded on the splat surface" : ", approximate"}.` : "";
      reply(`I remember a ${o.display_name ?? o.name}${o.description ? ` (${o.description})` : ""}${placePhrase(o)}, with ${evidencePhrase(o)} (similarity ${o.score.toFixed(2)}).${pos}` +
        (objs.length > 1 ? ` I also remember ${objs.length - 1} other possible match${objs.length === 2 ? "" : "es"}: ${objs.slice(1).map((x) => x.display_name ?? x.name).join(", ")}. I can navigate to the first and verify.` : " I can navigate there and verify."));
      return;
    }
    const { hits, loose, head } = searchLoose(await memories(), query);
    if (!hits.length) { pendingOffer = query; return reply(`I don't have a memory of a ${query} yet. Would you like me to explore? (say "yes")`); }
    const best = hits[0].o;
    const label = loose ? `"${head}" (closest match for "${query}")` : `"${query}"`;
    reply(`Yes — I saw ${label} at ${when(best)} near ${where(best)}: ${summary(best)}` +
      (hits.length > 1 ? ` (${hits.length} matching memories.)` : ""));
  }

  async function navigateTo(query, { silentMiss = false } = {}) {
    if (agent.busy?.()) { reply("I'm already moving — say \"stop\" first."); return "busy"; }
    const { hits, loose, head } = searchLoose(await memories(), query);
    if (!hits.length) {
      if (!silentMiss) reply(`Not found: I have no memory of "${query}" in this scene, so I can't take you there.`);
      return "no_memory";
    }
    if (loose) reply(`I have no exact memory of "${query}", but I do remember a "${head}".`);

    // A real viewpoint from which the object was described; skip ones off the NavMesh.
    const target = hits.find((h) => agent.debug.onNavmesh(h.o.pose.x, h.o.pose.z));
    if (!target) { reply(`I remember "${query}" but none of those viewpoints is on the walkable surface.`); return "no_memory"; }
    const o = target.o;
    currentGoal = query;
    reply(`I saw "${loose ? head : query}" at ${when(o)} near ${where(o)}. Walking there now…`);

    let result;
    try {
      result = await agent.goto({ x: o.pose.x, z: o.pose.z, stopWithin: 0.35 });
    } catch (err) {
      currentGoal = null;
      reply(`I couldn't start walking — ${err.message}`);
      return "failed";
    }
    if (currentGoal !== query) return "stopped"; // stopped or replaced meanwhile
    if (result.status !== "arrived") {
      currentGoal = null;
      reply(result.status === "unreachable"
        ? `Unreachable: no NavMesh path from here to ${where(o)}.`
        : `Blocked: I stopped after ${result.pathLength} m at (${result.pose.x.toFixed(1)}, ${result.pose.z.toFixed(1)}).`);
      return result.status;
    }
    reply(`Arrived near ${where(o)} after ${result.pathLength} m. Facing the remembered view…`);
    await agent.turn({ deg: ((o.pose.headingDeg - result.pose.headingDeg + 540) % 360) - 180 });

    const obs = await captureObservation("agent-arrival");
    currentGoal = null;
    if (!obs?.id) { reply("Arrived, but I couldn't store a new view to verify against."); return "arrived"; }
    return (await verifyHere(obs.id, query)) ? "verified" : "arrived";
  }

  /** Gemini check of a stored observation for `query`; replies either way. */
  async function verifyHere(obsId, query) {
    reply(`Checking for the ${query}…`);
    try {
      const v = await getJson("/talk/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observation_id: obsId, goal: query }),
      });
      reply(v.visible ? `Object verified: I can see "${query}" here. ${v.reason}` : `Not verified: I don't see "${query}" from here. ${v.reason}`);
      return Boolean(v.visible);
    } catch (err) {
      reply(`Verification unavailable: ${err.message}`);
      return false;
    }
  }

  /** Detect objects in a stored frame, ground each bbox on the splat, persist to `objects`. */
  async function detectAndRemember(obsId, frame) {
    const r = await getJson(`/observations/${encodeURIComponent(obsId)}/detect`, { method: "POST" });
    const sightings = r.objects.map((o) => {
      const loc = frame?.cameraSnapshot ? locateBbox(frame.cameraSnapshot, o.bbox, frame.rangeM ?? null) : null;
      return { ...o, position: loc?.position ?? null, range_m: loc?.distanceM ?? null,
               method: loc?.method ?? "none", confidence: loc?.confidence ?? 0 };
    });
    if (sightings.length) {
      await getJson("/objects/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_id: r.scene_id, observation_id: obsId, sightings }),
      });
    }
    return sightings;
  }

  const matchesQuery = (name, query) => {
    const q = terms(query);
    const n = String(name).toLowerCase();
    return q.length > 0 && q.every((t) => n.includes(t)) || (q.length > 1 && n.includes(q.at(-1)));
  };

  /** "What objects do you remember in the dining room?" */
  async function placeObjects(placeQuery) {
    const scene = getScene();
    const places = (await getJson(`/places/find?scene_id=${encodeURIComponent(scene.id)}&q=${encodeURIComponent(placeQuery)}`)).items;
    if (!places.length) return reply(`None of my remembered places is described as "${placeQuery}".`);
    for (const p of places.slice(0, 2)) {
      const objs = (await getJson(`/places/${encodeURIComponent(p.place_id)}/objects?scene_id=${encodeURIComponent(scene.id)}`)).items;
      reply(objs.length
        ? `In ${p.place_id} ("${p.label}", ${p.observations} observations) I remember ${objs.length} objects: ${objs.slice(0, 10).map((o) => `${o.display_name ?? o.name} (${o.sighting_count ?? 1}×)`).join(", ")}${objs.length > 10 ? ", …" : ""}.`
        : `${p.place_id} ("${p.label}") matches, but I have no object memories there yet.`);
    }
  }

  /** "Which places contain wooden furniture?" */
  async function placesWith(query) {
    const objs = await objectMemories(query, 12);
    if (!objs.length) return reply(`I have no object memories matching "${query}".`);
    const byPlace = new Map();
    for (const o of objs) {
      const key = o.place_id ?? "unplaced";
      if (!byPlace.has(key)) byPlace.set(key, { label: o.place_label, items: [] });
      byPlace.get(key).items.push(o.display_name ?? o.name);
    }
    reply([...byPlace.entries()].map(([pid, v]) => `${pid === "unplaced" ? "Not yet placed" : `${pid}${v.label ? ` ("${v.label}")` : ""}`}: ${v.items.join(", ")}`).join("\n"));
  }

  /** Known object memory → walk to its supporting viewpoint, face it, verify. */
  async function visitKnownObject(query) {
    const scene = getScene();
    const sem = await objectMemories(query, 3);
    const data = sem.length ? { items: sem } : await getJson(`/objects?scene_id=${encodeURIComponent(scene.id)}&q=${encodeURIComponent(query)}`);
    const known = data.items.find((o) => o.last_obs_id || (o.obs_ids ?? []).length);
    if (!known) return "no_memory";
    const obsId = known.last_obs_id ?? known.obs_ids.at(-1);
    const obs = await getJson(`/observations/${encodeURIComponent(obsId)}`);
    if (!agent.debug.onNavmesh(obs.pose.x, obs.pose.z)) return "no_memory";
    reply(`I remember a ${known.display_name ?? known.name}${placePhrase(known)} (${evidencePhrase(known)}` +
      `${known.position ? `, approx. (${known.position[0].toFixed(1)}, ${known.position[2].toFixed(1)}), ${known.location_method}` : ""}). Walking to where I saw it…`);
    currentGoal = query;
    const result = await agent.goto({ x: obs.pose.x, z: obs.pose.z, stopWithin: 0.35 });
    if (currentGoal !== query) return "stopped";
    if (result.status !== "arrived") { reply(`Couldn't reach it (${result.status}).`); return result.status; }
    if (known.position) await agent.face({ x: known.position[0], z: known.position[2] });
    else await agent.turn({ deg: ((obs.pose.headingDeg - result.pose.headingDeg + 540) % 360) - 180 });
    const captured = await captureObservation("agent-arrival");
    currentGoal = null;
    return captured?.id && (await verifyHere(captured.id, query)) ? "verified" : "arrived";
  }

  /**
   * Autonomous exploration — the shape of Jun's agent.py loop, driven from the browser:
   *   observe (capture + enrich + graph update) → frontiers → Gemini chooses, explains → walk → repeat.
   * `goal` null = free exploration (local/large); a goal adds detection + visual verification (find).
   * Every narrated line reflects a real decision or stored datum; counts are actual.
   */
  async function runExploration(mode, goal = null) {
    if (exploring || agent.busy?.()) { reply("I'm already on a task — say \"stop\" first."); return false; }
    const cfg = MODES[mode];
    const gen = ++taskGen;
    exploring = true;
    const t0 = performance.now();
    const stats = { steps: 0, viewpoints: 0, observations: 0, enriched: 0, gemini: 0, newPlaces: 0, recognized: 0, blocked: 0, metres: 0 };
    const tried = [];
    const visitedPts = [];
    let coverage0 = null;
    const gemini = () => (stats.gemini < cfg.maxGemini ? (stats.gemini += 1, true) : false);
    const scene = getScene();

    const budgetLeft = () => stats.steps < cfg.maxSteps && performance.now() - t0 < cfg.maxMs;

    async function observe(label) {
      const { frames } = await agent.capture({ headings: cfg.headings });
      guard(gen);
      const saved = frames.filter((f) => f.obsId);
      stats.observations += saved.length;
      const fwd = saved[0] ?? null;
      if (label) narrate(label, fwd);
      // Find mode: detect + remember objects, verify the goal in each real frame.
      if (goal) {
        for (const f of saved) {
          reply(`Checking for the ${goal}…`);
          let sightings = [];
          if (gemini()) {
            try { sightings = await detectAndRemember(f.obsId, { cameraSnapshot: f.cameraSnapshot, rangeM: f.rangeM }); }
            catch (err) { reply(`Object detection unavailable: ${err.message}`); }
          }
          guard(gen);
          const names = sightings.map((x) => x.name).filter(Boolean);
          if (names.length) narrate(`I can see: ${names.slice(0, 8).join(", ")}. Remembered ${names.length} objects.`, f);
          const hit = sightings.find((x) => matchesQuery(x.name, goal));
          if (hit) {
            narrate(`I think I see the ${goal}. Verifying in this view…`, f);
            if (gemini() && (await verifyHere(f.obsId, goal))) return { found: true, frame: f };
            guard(gen);
          }
        }
        return { found: false, frame: fwd };
      }
      // Free exploration: enrich the forward frame through the existing perception pipeline,
      // then fold it into the cognitive graph with the ACTIVE policy (no policy change).
      if (cfg.enrich && fwd && gemini()) {
        try {
          const e = await getJson(`/observations/${encodeURIComponent(fwd.obsId)}/enrich`, { method: "POST" });
          guard(gen);
          stats.enriched += 1;
          const summary = e.description?.summary ?? e.description_text?.split("\n")[0];
          if (summary) narrate(`I can see ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, fwd);
          const g = await getJson("/cognitive-map/rebuild", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene_id: scene.id, observation_id: fwd.obsId }),
          });
          guard(gen);
          if (gemini()) { // object memory, not awaited: never blocks movement; status lives on the observation
            detectAndRemember(fwd.obsId, { cameraSnapshot: fwd.cameraSnapshot, rangeM: fwd.rangeM })
              .then((sg) => sg.length && narrate(`Remembered ${sg.length} objects here: ${sg.slice(0, 6).map((x) => x.name).join(", ")}.`, fwd))
              .catch((err) => console.warn("[explore] object memory:", err.message));
          }
          const pl = g.placement;
          if (pl?.recognized) { stats.recognized += 1; reply(`This observation resembles a place I remember (${pl.place_id}, ${pl.members} observations, similarity ${pl.best_score?.toFixed(2)}).`); }
          else if (pl) { stats.newPlaces += 1; reply(`I don't recognize this viewpoint${pl.best_score != null ? ` (best match ${pl.best_score.toFixed(2)})` : ""}. Recording a new place (${pl.place_id}). The map now has ${g.places} places.`); }
        } catch (err) {
          if (err instanceof Cancelled) throw err;
          reply(`Perception unavailable for this view: ${err.message}`);
        }
      }
      return { found: false, frame: fwd };
    }

    async function chooseFrontier(frontiers, pose, recentObsIds, coverage) {
      const near = (f) => visitedPts.some((v) => Math.hypot(v.x - f.x, v.z - f.z) < cfg.minSeparationM);
      const options = frontiers
        .filter((f) => !tried.some((t) => Math.hypot(t.x - f.x, t.z - f.z) < 0.75))
        .map((f) => ({ ...f, d: Math.hypot(f.x - pose.x, f.z - pose.z), far: !near(f) }))
        .sort((a, b) => (b.far - a.far) || (b.size / (1 + b.d) - a.size / (1 + a.d)))
        .slice(0, 6);
      if (!options.length) return null;
      const describe = (f) => `frontier ${f.d.toFixed(1)} m ${side(pose, f)}, size ${f.size}${f.far ? "" : " (near a place I already visited)"}`;
      let choice = 0, thought = null;
      if (options.length > 1 && recentObsIds.length && gemini()) {
        try {
          const ctx = `Mode: ${cfg.label}. Visited ${stats.viewpoints} viewpoints, recorded ${stats.observations} observations, coverage ${(coverage * 100).toFixed(0)}%.` +
            (goal ? "" : " Prefer large unexplored regions and distinct new areas over places already seen.");
          const c = await getJson("/talk/choose", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal: goal ?? "unexplored areas of this space", context: ctx, options: options.map(describe), observation_ids: recentObsIds }),
          });
          guard(gen);
          choice = c.choice ?? 0; thought = c.thought || null;
        } catch (err) {
          if (err instanceof Cancelled) throw err;
          console.warn("[explore] choose fallback:", err.message);
        }
      }
      const pick = options[Math.min(Math.max(choice, 0), options.length - 1)];
      reply(thought ? `${thought} (${describe(pick)})` : `Heading for the ${describe(pick)} — the largest reachable unexplored region.`);
      return pick;
    }

    try {
      narrate(goal ? `Searching for the ${goal}. Looking around first.` : `Starting ${cfg.label}. Looking around first.`);
      const recent = [];
      let first = await observe(null);
      if (first.frame?.obsId) recent.push(first.frame.obsId);
      if (first.found) return true;
      while (budgetLeft()) {
        guard(gen);
        const { frontiers, coverage } = await agent.frontiers();
        guard(gen);
        if (coverage0 === null) coverage0 = coverage;
        const pose = (await agent.pose()).pose;
        reply(frontiers.length ? `I see ${frontiers.length} possible unexplored region${frontiers.length === 1 ? "" : "s"} (coverage ${(coverage * 100).toFixed(0)}%).`
          : `No reachable unexplored regions left (coverage ${(coverage * 100).toFixed(0)}%).`);
        if (!frontiers.length) break;
        const pick = await chooseFrontier(frontiers, pose, recent.slice(-4), coverage);
        if (!pick) { reply("Every remaining frontier is one I already tried."); break; }
        tried.push(pick);
        stats.steps += 1;
        reply(`I'm moving toward the next viewpoint (step ${stats.steps}/${cfg.maxSteps}).`);
        const r = await agent.goto({ x: pick.x, z: pick.z, stopWithin: 0.4 });
        guard(gen);
        stats.metres += r.pathLength ?? 0;
        if (r.status !== "arrived") { stats.blocked += 1; reply(`That way was ${r.status} after ${(r.pathLength ?? 0).toFixed(1)} m; I'll try another direction.`); continue; }
        stats.viewpoints += 1;
        visitedPts.push({ x: r.pose.x, z: r.pose.z });
        const o = await observe("I've reached a new area. Looking around.");
        if (o.frame?.obsId) recent.push(o.frame.obsId);
        if (o.found) return true;
      }
      return false;
    } catch (err) {
      if (err instanceof Cancelled) return false;
      reply(`Exploration error — ${err.message}`);
      return false;
    } finally {
      const cancelled = gen !== taskGen || !exploring;
      if (gen === taskGen) exploring = false;
      const { frontiers = [], coverage = null } = cancelled ? {} : await agent.frontiers().catch(() => ({}));
      const cov = coverage0 !== null && coverage !== null ? ` Coverage ${(coverage0 * 100).toFixed(0)}% → ${(coverage * 100).toFixed(0)}%.` : "";
      const mem = cfg.enrich ? ` ${stats.enriched} enriched into memory: ${stats.newPlaces} new place${stats.newPlaces === 1 ? "" : "s"}, ${stats.recognized} recognized.` : "";
      reply(`${cancelled ? "Exploration stopped." : "Exploration complete."} I visited ${stats.viewpoints} viewpoint${stats.viewpoints === 1 ? "" : "s"} over ${stats.metres.toFixed(1)} m and recorded ${stats.observations} observation${stats.observations === 1 ? "" : "s"}.${mem}${cov}${stats.blocked ? ` ${stats.blocked} route${stats.blocked === 1 ? " was" : "s were"} blocked.` : ""}${!cancelled && frontiers.length ? ` ${frontiers.length} unexplored region${frontiers.length === 1 ? "" : "s"} remain.` : ""} Gemini requests: ${stats.gemini}.`);
    }
  }

  /** "Explore this area" / "Explore a large area". */
  async function exploreArea(mode = "local") {
    await runExploration(mode, null);
  }

  /** Object search exploration (existing find behaviour, now narrated and budgeted). */
  async function explore(query) {
    const found = await runExploration("find", query);
    if (!found && exploring === false && taskGen) {
      // runExploration already printed the summary; make the outcome explicit.
      reply(`Not found: I did not see a ${query}.`);
    }
    return found;
  }

  /** "Find X": remembered objects → remembered descriptions → autonomous exploration. */
  async function findObject(query) {
    reply("Searching remembered objects…");
    let outcome = await visitKnownObject(query);
    if (outcome === "verified" || outcome === "stopped") return;
    if (outcome === "no_memory") {
      outcome = await navigateTo(query, { silentMiss: true });
      if (outcome === "verified" || outcome === "stopped" || outcome === "busy") return;
      if (outcome === "no_memory") reply(`I have no memory of a ${query} yet. Exploring to look for it.`);
    }
    await explore(query);
  }

  async function describeHere() {
    const obs = await captureObservation("talk");
    if (!obs?.id) return reply("I couldn't capture a view right now.");
    reply("Looking… (asking Gemini to describe this view)");
    const r = await getJson(`/observations/${encodeURIComponent(obs.id)}/enrich`, { method: "POST" });
    reply(r.description?.summary ?? r.description_text ?? "I couldn't describe this view.");
  }

  /** Gemini structured intent for phrasing the rules did not recognise. */
  async function geminiIntent(text) {
    const r = await getJson("/talk/intent", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const target = (r.target ?? "").trim();
    switch (r.intent) {
      case "stop": return stop();
      case "list_places": return listPlaces();
      case "describe_here": return describeHere();
      case "navigate": return target ? findObject(target) : reply("Where would you like me to go? Name something I may have seen.");
      case "have_seen": return target ? haveSeen(target) : freeform(text);
      default: return freeform(text);
    }
  }

  async function freeform(text) {
    const items = await memories();
    const hits = search(items, text).slice(0, 8).map((h) => h.o);
    const pool = (hits.length ? hits : items.slice(0, 8)).map((o) => ({ id: o.id, description_text: o.description_text }));
    const r = await getJson("/talk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text, memories: pool }),
    });
    reply(r.answer);
  }

  function stop() {
    const wasMoving = agent.busy?.() || exploring;
    currentGoal = null;
    exploring = false; // cancels the exploration loop at its next check
    taskGen += 1;      // any in-flight step of the old task throws Cancelled when it resumes
    agent.halt();      // stops the walk now and restores manual input
    window.__seekr?.agentPanel?.path?.([]);
    reply(wasMoving ? "Stopped. Manual control restored; observations already saved are kept." : "Nothing to stop.");
  }

  /** Rule-based routing; returns the matched intent for inspection. */
  function parse(text) {
    const clean = text.replace(/^\s*(seekr|navevolve agent|navevolve|agent)[,:!]?\s*/i, "").trim();
    let m;
    if (STOP_RE.test(clean)) return { intent: "stop", clean };
    if (/^(yes|yes please|sure|ok|okay|go ahead|do it|explore)[.!]?$/i.test(clean)) return { intent: "yes", clean };
    if (PLACES_RE.test(clean)) return { intent: "list_places", clean };
    if (EXPLORE_RE.test(clean) || EXPLORE_NOVEL_RE.test(clean)) {
      return { intent: "explore", mode: EXPLORE_LARGE_RE.test(clean) ? "large" : "local", clean };
    }
    const target = navigationTarget(clean);
    if (target) {
      const find = /^(please\s+|can you\s+|could you\s+)*(find|locate|look|search)\b/i.test(clean);
      return { intent: find ? "find" : "navigate", target, clean };
    }
    if (HERE_RE.test(clean)) return { intent: "describe_here", clean };
    if ((m = PLACE_OBJECTS_RE.exec(clean))) return { intent: "place_objects", target: m[5], clean };
    if ((m = PLACES_WITH_RE.exec(clean))) return { intent: "places_with", target: m[4], clean };
    if ((m = SEEN_RE.exec(clean))) return { intent: "have_seen", target: m[5], clean };
    if ((m = WHERE_RE.exec(clean))) return { intent: "have_seen", target: m[4], clean };
    return { intent: "unknown", clean };
  }

  async function handle(text) {
    const { intent, target, mode, clean } = parse(text);
    say("You", text);
    if (intent === "stop") return stop();
    if (busy) return reply("One moment — I'm still working on the previous request (or say \"stop\").");
    busy = true;
    try {
      if (intent === "list_places") await listPlaces();
      else if (intent === "explore") await exploreArea(mode);
      else if (intent === "find") await findObject(target);
      else if (intent === "navigate") await navigateTo(target);
      else if (intent === "have_seen") await haveSeen(target);
      else if (intent === "place_objects") await placeObjects(target);
      else if (intent === "places_with") await placesWith(target);
      else if (intent === "yes" && pendingOffer) { const t = pendingOffer; pendingOffer = null; await findObject(t); }
      else if (intent === "describe_here") await describeHere();
      else {
        try {
          await geminiIntent(clean);
        } catch (err) {
          // Intent endpoint missing or Gemini down: still answer from memory.
          console.warn("[talk] intent fallback:", err.message);
          await freeform(clean);
        }
      }
    } catch (err) {
      reply(err.message.startsWith("Backend") ? err.message : `Sorry — ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return { handle, parse, stop, search, terms, navigationTarget, exploreArea, get exploring() { return exploring; } };
}
