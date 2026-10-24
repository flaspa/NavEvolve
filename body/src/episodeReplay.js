/**
 * episodeReplay.js — "Recorded Replay" of a real navigation episode (presentation).
 *
 * Plays back an episode recorded by talk.js (start pose, sampled trajectory,
 * ordered agent events with poses, captured observation ids, verification,
 * final status) from static files under /replay/episodes/. The avatar walks
 * the recorded trajectory with the live A-star / NavMesh controller (no teleporting
 * between stops); each recorded line is shown — and spoken from its cached
 * ElevenLabs clip — when the avatar reaches the pose where it was said.
 * No Gemini, MongoDB or ElevenLabs calls happen during playback.
 */

export const SPEAKER = "NavEvolve Agent";

export function createEpisodeReplay({ ui, agent, getScene, loadScene, isBusy = () => false, onState = () => {}, setSpeed = () => {} }) {
  let episode = null;
  let active = false, paused = false, muted = false, speed = 1;
  let gen = 0, audio = null, resumeFrom = 0, emitted = 0;

  const say = (text) => ui.addMessage(SPEAKER, text);
  const system = (text) => ui.addMessage("System", text);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dead = (g) => g !== gen || !active;

  async function latest() {
    if (episode) return episode;
    const idx = await fetch("/replay/episodes/index.json", { cache: "no-cache" });
    if (!idx.ok) return null;
    const { latest: id } = await idx.json();
    const res = await fetch(`/replay/episodes/${id}.json`, { cache: "no-cache" });
    episode = res.ok ? await res.json() : null;
    return episode;
  }

  /** Deterministic summary from the recorded events — never from a model. */
  function summarize(ep) {
    const ev = ep.events;
    const when = new Date(ep.started_at).toLocaleTimeString();
    const walked = ep.trajectory.reduce((s, p, i) => (i ? s + Math.hypot(p.x - ep.trajectory[i - 1].x, p.z - ep.trajectory[i - 1].z) : 0), 0);
    const captures = ev.filter((e) => e.obs_id).length;
    const mems = ev.filter((e) => e.kind === "memory" && e.text).map((e) => e.text);
    const mem = mems.length ? { text: mems.slice(0, 2).join(" ") } : null;
    const verify = ev.filter((e) => e.kind === "verify").at(-1);
    const parts = [`At ${when} you asked me to find the ${ep.goal} in ${ep.scene_id}.`];
    parts.push(mem ? mem.text : "I started by checking my memory.");
    parts.push(`I walked ${walked.toFixed(1)} m along the recorded route, stopping at ${ev.filter((e) => e.kind === "arrive").length} viewpoint${ev.filter((e) => e.kind === "arrive").length === 1 ? "" : "s"} and capturing ${captures} observation${captures === 1 ? "" : "s"}.`);
    if (verify) parts.push(verify.visible ? `Gemini verified the ${ep.goal} in a real captured frame: ${verify.reason}` : `I could not verify the ${ep.goal} there: ${verify.reason}`);
    parts.push(`Outcome: ${ep.status}. Say "give me a replay" to see it.`);
    return parts.join(" ");
  }

  function play(url, g) {
    return new Promise((resolve) => {
      if (dead(g) || muted || !url) return resolve();
      stopAudio();
      const a = new Audio(url); audio = a; a.playbackRate = speed;
      a.onended = resolve; a.onerror = resolve;
      a.play().catch(resolve);
    });
  }
  function stopAudio() { if (audio) { try { audio.pause(); } catch (_) { /* */ } audio = null; } }

  /** Emits every recorded event up to trajectory index `upTo` (in order). */
  async function emitUntil(ep, upTo, g) {
    while (emitted < ep.events.length && ep.events[emitted].traj_index <= upTo) {
      const e = ep.events[emitted++];
      if (dead(g)) return;
      const img = e.obs_id && ep.assets.images[e.obs_id];
      if (!e.text) continue;
      if (e.from === "You") ui.addMessage("You", e.text);
      else if (img) ui.addMessageWithFrame(SPEAKER, e.text, { imageDataUrl: img, altText: e.obs_id, obsId: e.obs_id });
      else if (e.text) say(e.text);
      if (e.speak) await play(ep.assets.audio[String(ep.events.indexOf(e))], g);
    }
  }

  async function start({ fromIndex = 0 } = {}) {
    const ep = await latest();
    if (!ep) { system("No recorded episode yet — run a search (e.g. \"Find the bathroom\") first, then ask for a replay."); return; }
    if (active) return;
    if (isBusy()) { system("Recorded Replay: the agent is busy — say \"stop\" first."); return; }
    const g = ++gen;
    active = true; paused = false; onState({ active, paused, muted, speed });
    try {
      if (fromIndex === 0) {
        system(`Recorded Replay — episode ${ep.episode_id} (${new Date(ep.started_at).toLocaleTimeString()}, status: ${ep.status}). Not a live run.`);
        if (getScene()?.id !== ep.scene_id) { await loadScene(ep.scene_id); await sleep(1500); if (dead(g)) return; }
        await agent.reset({ x: ep.start.x, z: ep.start.z, headingDeg: ep.start.headingDeg });
        emitted = 0;
      }
      setSpeed(speed);
      const wp = ep.waypoints; // decimated trajectory [{x,z,traj_index}]
      await emitUntil(ep, fromIndex === 0 ? 0 : wp[fromIndex - 1]?.traj_index ?? 0, g);
      for (let i = fromIndex; i < wp.length; i++) {
        if (dead(g)) return;
        if (paused) { resumeFrom = i; return; }
        const r = await agent.goto({ x: wp[i].x, z: wp[i].z, stopWithin: 0.3 });
        if (dead(g)) return;
        if (r.status !== "arrived") { system(`Recorded Replay: the recorded route could not be reproduced at waypoint ${i + 1}/${wp.length} (${r.status}); stopping here rather than substituting a route.`); return; }
        if (wp[i].headingDeg != null) await agent.turn({ deg: ((wp[i].headingDeg - r.pose.headingDeg + 540) % 360) - 180 });
        await emitUntil(ep, wp[i].traj_index, g);
      }
      await emitUntil(ep, Infinity, g);
      if (!dead(g)) system(`Recorded Replay finished — recorded outcome: ${ep.status}. Manual control restored.`);
    } catch (err) {
      if (!dead(g)) system(`Recorded Replay error — ${err.message}`);
    } finally {
      if (g === gen && !paused) { active = false; setSpeed(1); onState({ active, paused, muted, speed }); }
    }
  }

  function stop(silent = false) {
    if (!active) return false;
    gen += 1; active = false; paused = false;
    stopAudio(); agent.halt(); setSpeed(1);
    window.__seekr?.agentPanel?.path?.([]);
    if (!silent) system("Recorded Replay stopped. Manual control restored.");
    onState({ active, paused, muted, speed });
    return true;
  }
  function pause() {
    if (!active || paused) return;
    paused = true; stopAudio(); agent.halt();
    onState({ active, paused, muted, speed });
  }
  function resume() {
    if (!active || !paused) return;
    paused = false;
    start({ fromIndex: resumeFrom });
  }
  function toggleMute() { muted = !muted; if (muted) stopAudio(); onState({ active, paused, muted, speed }); }
  function setPlaybackSpeed(s) { speed = s; if (audio) audio.playbackRate = s; if (active) setSpeed(s); onState({ active, paused, muted, speed }); }

  return { start, stop, pause, resume, toggleMute, setPlaybackSpeed, latest, summarize, invalidate() { episode = null; },
    get active() { return active; }, get paused() { return paused; } };
}
