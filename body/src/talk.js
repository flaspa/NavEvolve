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
  const EXPLORE_MAX_STEPS = 6;
  const EXPLORE_MAX_MS = 240_000;
  const reply = (text) => say(AGENT_NAME, text);

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

  async function haveSeen(query) {
    const { hits, loose, head } = searchLoose(await memories(), query);
    if (!hits.length) return reply(`I have no memory of "${query}" in this scene.`);
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

  /** Known object memory → walk to its supporting viewpoint, face it, verify. */
  async function visitKnownObject(query) {
    const scene = getScene();
    const data = await getJson(`/objects?scene_id=${encodeURIComponent(scene.id)}&q=${encodeURIComponent(query)}`);
    const known = data.items.find((o) => o.last_obs_id || (o.obs_ids ?? []).length);
    if (!known) return "no_memory";
    const obsId = known.last_obs_id ?? known.obs_ids.at(-1);
    const obs = await getJson(`/observations/${encodeURIComponent(obsId)}`);
    if (!agent.debug.onNavmesh(obs.pose.x, obs.pose.z)) return "no_memory";
    reply(`I remember a ${known.display_name ?? known.name} (${known.sightings} sighting${known.sightings === 1 ? "" : "s"}` +
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

  /** Autonomous exploration of unseen frontiers until the object is verified or the budget ends.
   *  Each step: look around (capture, detect, remember, verify) → pick a frontier → walk. The
   *  first look-around also seeds the visited map that frontiers() is computed from. */
  async function explore(query) {
    exploring = true;
    const t0 = performance.now();
    const tried = [];
    let steps = 0;
    try {
      while (exploring && steps < EXPLORE_MAX_STEPS && performance.now() - t0 < EXPLORE_MAX_MS) {
        const { frames } = await agent.capture({ headings: 2 });
        if (!exploring) return false;
        for (const f of frames) {
          if (!f.obsId) continue;
          reply(`Checking for the ${query}…`);
          let sightings = [];
          try {
            sightings = await detectAndRemember(f.obsId, { cameraSnapshot: f.cameraSnapshot, rangeM: f.rangeM });
          } catch (err) {
            reply(`Object detection unavailable: ${err.message}`);
          }
          if (!exploring) return false;
          const names = sightings.map((s) => s.name).filter(Boolean);
          if (names.length) reply(`I see: ${names.slice(0, 8).join(", ")}. Remembered ${names.length} objects.`);
          const hit = sightings.find((s) => matchesQuery(s.name, query));
          if (hit && (await verifyHere(f.obsId, query))) return true;
        }
        const { frontiers, coverage } = await agent.frontiers();
        const p = (await agent.pose()).pose;
        const pick = frontiers
          .filter((f) => !tried.some((t) => Math.hypot(t.x - f.x, t.z - f.z) < 0.75))
          .map((f) => ({ ...f, d: Math.hypot(f.x - p.x, f.z - p.z) }))
          .sort((a, b) => b.size / (1 + b.d) - a.size / (1 + a.d))[0];
        if (!pick) { reply(`No unexplored reachable areas left (coverage ${(coverage * 100).toFixed(0)}%).`); break; }
        steps += 1;
        tried.push(pick);
        reply(`Exploring an unseen area… (step ${steps}/${EXPLORE_MAX_STEPS}, frontier ${pick.d.toFixed(1)} m away, coverage ${(coverage * 100).toFixed(0)}%)`);
        const r = await agent.goto({ x: pick.x, z: pick.z, stopWithin: 0.4 });
        if (!exploring) return false;
        if (r.status !== "arrived") reply(`That way was ${r.status}; trying another frontier.`);
      }
    } finally {
      exploring = false;
    }
    reply(`Not found: I explored ${steps} unseen area${steps === 1 ? "" : "s"} without seeing a ${query}.`);
    return false;
  }

  /** "Find X": remembered objects → remembered descriptions → autonomous exploration. */
  async function findObject(query) {
    reply("Searching remembered objects…");
    let outcome = await visitKnownObject(query);
    if (outcome === "verified" || outcome === "stopped") return;
    if (outcome === "no_memory") {
      outcome = await navigateTo(query, { silentMiss: true });
      if (outcome === "verified" || outcome === "stopped" || outcome === "busy") return;
      if (outcome === "no_memory") reply(`I have no memory of a ${query} yet.`);
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
    agent.halt();
    reply(wasMoving ? "Stopped." : "Nothing to stop.");
  }

  /** Rule-based routing; returns the matched intent for inspection. */
  function parse(text) {
    const clean = text.replace(/^\s*(seekr|navevolve agent|navevolve|agent)[,:!]?\s*/i, "").trim();
    let m;
    if (STOP_RE.test(clean)) return { intent: "stop", clean };
    if (PLACES_RE.test(clean)) return { intent: "list_places", clean };
    const target = navigationTarget(clean);
    if (target) {
      const find = /^(please\s+|can you\s+|could you\s+)*(find|locate|look|search)\b/i.test(clean);
      return { intent: find ? "find" : "navigate", target, clean };
    }
    if (HERE_RE.test(clean)) return { intent: "describe_here", clean };
    if ((m = SEEN_RE.exec(clean))) return { intent: "have_seen", target: m[5], clean };
    return { intent: "unknown", clean };
  }

  async function handle(text) {
    const { intent, target, clean } = parse(text);
    say("You", text);
    if (intent === "stop") return stop();
    if (busy) return reply("One moment — I'm still working on the previous request (or say \"stop\").");
    busy = true;
    try {
      if (intent === "list_places") await listPlaces();
      else if (intent === "find") await findObject(target);
      else if (intent === "navigate") await navigateTo(target);
      else if (intent === "have_seen") await haveSeen(target);
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

  return { handle, parse, stop, search, terms, navigationTarget };
}
