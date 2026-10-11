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

export function createTalk({ ui, agent, brainUrl, getScene, captureObservation, say = ui.addMessage }) {
  let busy = false;
  let currentGoal = null;
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

  async function navigateTo(query) {
    if (agent.busy?.()) return reply("I'm already moving — say \"stop\" first.");
    const { hits, loose, head } = searchLoose(await memories(), query);
    if (!hits.length) return reply(`Not found: I have no memory of "${query}" in this scene, so I can't take you there.`);
    if (loose) reply(`I have no exact memory of "${query}", but I do remember a "${head}".`);

    // A real viewpoint from which the object was described; skip ones off the NavMesh.
    const target = hits.find((h) => agent.debug.onNavmesh(h.o.pose.x, h.o.pose.z));
    if (!target) return reply(`I remember "${query}" but none of those viewpoints is on the walkable surface.`);
    const o = target.o;
    currentGoal = query;
    reply(`I saw "${loose ? head : query}" at ${when(o)} near ${where(o)}. Walking there now…`);

    let result;
    try {
      result = await agent.goto({ x: o.pose.x, z: o.pose.z, stopWithin: 0.35 });
    } catch (err) {
      currentGoal = null;
      return reply(`I couldn't start walking — ${err.message}`);
    }
    if (currentGoal !== query) return; // stopped or replaced meanwhile
    if (result.status !== "arrived") {
      currentGoal = null;
      return reply(result.status === "unreachable"
        ? `Unreachable: no NavMesh path from here to ${where(o)}.`
        : `Blocked: I stopped after ${result.pathLength} m at (${result.pose.x.toFixed(1)}, ${result.pose.z.toFixed(1)}).`);
    }
    reply(`Arrived near ${where(o)} after ${result.pathLength} m. Facing the remembered view…`);
    await agent.turn({ deg: ((o.pose.headingDeg - result.pose.headingDeg + 540) % 360) - 180 });

    const obs = await captureObservation("agent-arrival");
    currentGoal = null;
    if (!obs?.id) return reply("Arrived, but I couldn't store a new view to verify against.");
    try {
      const v = await getJson("/talk/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observation_id: obs.id, goal: query }),
      });
      reply(v.visible ? `Verified: I can see "${query}" here. ${v.reason}` : `Arrived, but not verified: I don't see "${query}" from here. ${v.reason}`);
    } catch (err) {
      reply(`Arrived (verification unavailable: ${err.message}).`);
    }
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
      case "navigate": return target ? navigateTo(target) : reply("Where would you like me to go? Name something I may have seen.");
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
    const wasMoving = agent.busy?.();
    currentGoal = null;
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
    if (target) return { intent: "navigate", target, clean };
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
