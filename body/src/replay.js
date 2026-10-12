/**
 * replay.js — "Replay Demo" (hackathon presentation).
 *
 * A deterministic, clearly-labelled guided replay of a REAL saved route:
 * the avatar walks (A* on the NavMesh, same controller as live navigation)
 * from one remembered viewpoint to the remembered bathroom viewpoint while
 * cached ElevenLabs narration plays. Everything shown comes from
 * /replay/bathroom.json built once by brain/scripts/build_replay.py — no
 * Gemini, MongoDB or ElevenLabs requests happen during playback.
 */

export const REPLAY_SPEAKER = "NavEvolve Agent";

export function createReplay({ ui, agent, getScene, loadScene, isBusy = () => false, onStateChange = () => {} }) {
  let script = null;
  let active = false;
  let gen = 0;
  let audio = null;

  const say = (text) => ui.addMessage(REPLAY_SPEAKER, text);
  const system = (text) => ui.addMessage("System", text);

  async function loadScript() {
    if (script) return script;
    const res = await fetch("/replay/bathroom.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`replay script missing (HTTP ${res.status}) — run brain/scripts/build_replay.py`);
    script = await res.json();
    return script;
  }

  /** Plays a cached clip; resolves when it ends (or immediately if audio is blocked). */
  function play(name, myGen) {
    return new Promise((resolve) => {
      if (myGen !== gen) return resolve();
      stopAudio();
      const a = new Audio(`/replay/${name}.mp3`);
      audio = a;
      a.onended = () => resolve();
      a.onerror = () => resolve();
      a.play().catch(() => resolve()); // autoplay blocked: narration still appears as text
    });
  }
  function stopAudio() {
    if (audio) { try { audio.pause(); } catch (_) { /* ignore */ } audio = null; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cancelled = (myGen) => myGen !== gen || !active;

  async function start() {
    if (active) return;
    if (isBusy()) { system("Replay Demo: the agent is busy — say \"stop\" first."); return; }
    const s = await loadScript();
    const myGen = ++gen;
    active = true;
    onStateChange(true);
    try {
      system(s.label);
      if (getScene()?.id !== s.scene_id) {
        system(`Replay Demo: loading scene ${s.scene_id}…`);
        await loadScene(s.scene_id);
        await sleep(1500);
        if (cancelled(myGen)) return;
      }
      ui.addMessage("You", s.user_message);
      say(s.lines.intro);
      // Reset to the real start viewpoint (NavMesh-snapped), then walk the real route.
      await agent.reset({ x: s.start.x, z: s.start.z, headingDeg: s.start.headingDeg });
      await play("intro", myGen);
      if (cancelled(myGen)) return;
      say(s.lines.walk);
      const walkAudio = play("walk", myGen);
      const walk = agent.goto({ x: s.target.x, z: s.target.z, stopWithin: 0.35 });
      // Mid-route line once the remaining distance drops below ~55% of the start distance.
      const d0 = Math.hypot(s.start.x - s.target.x, s.start.z - s.target.z);
      let midSaid = false;
      const watcher = (async () => {
        while (!cancelled(myGen) && !midSaid) {
          await sleep(300);
          const p = (await agent.pose()).pose;
          if (Math.hypot(p.x - s.target.x, p.z - s.target.z) < 0.55 * d0) {
            midSaid = true;
            say(s.lines.mid);
            await walkAudio;
            await play("mid", myGen);
          }
        }
      })();
      const r = await walk;
      await watcher.catch(() => {});
      if (cancelled(myGen)) return;
      if (r.status !== "arrived") {
        system(`Replay Demo: the route was ${r.status} after ${r.pathLength} m — this run did not reach the viewpoint.`);
        return;
      }
      await agent.turn({ deg: ((s.target.headingDeg - r.pose.headingDeg + 540) % 360) - 180 });
      say(`${s.lines.arrive} (walked ${r.pathLength} m)`);
      await play("arrive", myGen);
      if (cancelled(myGen)) return;
      const v = s.verification;
      const verdict = v ? `Recorded Gemini verification (${v.verified_at}, on the saved frame): ${v.visible ? "VISIBLE" : "NOT visible"} — ${v.reason}`
                        : `Recorded Gemini perception: room type "${s.target.room_type}".`;
      ui.addMessageWithFrame(REPLAY_SPEAKER,
        `Saved evidence from observation ${s.target.observation_id} (recorded ${s.target.recorded_at}): ${s.target.summary}\n${verdict}`,
        { imageDataUrl: "/replay/evidence.jpg", altText: "saved bathroom observation", obsId: s.target.observation_id });
      await play("evidence", myGen);
      if (cancelled(myGen)) return;
      say(s.lines.done);
      await play("done", myGen);
    } catch (err) {
      if (!cancelled(myGen)) system(`Replay Demo error — ${err.message}`);
    } finally {
      if (myGen === gen) {
        active = false;
        onStateChange(false);
      }
    }
  }

  function stop({ silent = false } = {}) {
    if (!active) return false;
    gen += 1;
    active = false;
    stopAudio();
    agent.halt(); // stops the walk now; restores manual input
    window.__seekr?.agentPanel?.path?.([]);
    if (!silent) {
      say(script?.lines?.stop ?? "Replay stopped. Manual control is restored.");
      const a = new Audio("/replay/stop.mp3");
      a.play().catch(() => {});
    }
    onStateChange(false);
    return true;
  }

  return { start, stop, get active() { return active; } };
}
