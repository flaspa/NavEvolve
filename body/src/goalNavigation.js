/**
 * goalNavigation.js — the Body side of closed-loop, goal-directed navigation.
 *
 *   goal → fresh ego frame → Brain /goal/step (Liquid perception +
 *   deterministic action) → Body executes ONE small NavMesh-constrained
 *   action → fresh frame → … until stop.
 *
 * Pure orchestration over injected actuators, adapted from the old
 * autonomousGoal loop: generation-based cancellation (a stale reply can never
 * move Seekr), a bounded step budget, real user WASD cancels, and blocked
 * moves are REPORTED to the Brain as facts, never judged here. The Body
 * chooses no action: every turn/move comes from the Brain's reply.
 *
 * Actuators (all provided by main.js):
 *   capture()                    → { dataUrl, sceneId, sceneName } | null
 *   step(payload)                → Brain reply { perception, action, latency_ms }
 *   turn(degrees)                → Promise<void>   (+ = left)
 *   moveForward(meters)          → Promise<{ blocked, displacementM }>
 *   say(text)                    → chat feedback
 *   onPerception(result, frame)  → Perception tab / Seekr Vision
 */
export const GOAL_MAX_STEPS = 24; // Body-side safety ceiling (the Brain has its own)
export const GOAL_MAX_DURATION_MS = 240_000;

/** Obviously goal-directed navigation messages — the one small routing rule. */
export function isNavigationGoal(text) {
  return /\b(walk|go|move|head|approach|navigate|find|reach|get to|stand next|stand by|next to|toward|towards)\b/i.test(
    String(text ?? ""),
  );
}

/** Exact "stop" / "cancel", optional punctuation — human cancellation authority. */
export function isStopCommand(text) {
  return /^\s*(stop|cancel|halt)\s*[.!]?\s*$/i.test(String(text ?? ""));
}

export function createGoalNavigator({
  capture,
  step,
  turn,
  moveForward,
  say = () => {},
  onPerception = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settleMs = 250,
}) {
  let generation = 0;
  let active = false;
  let current = null; // { goal, generation, startedAt }

  function isCurrent(gen) {
    return active && current?.generation === gen;
  }

  function end(reason, message) {
    if (!active) return;
    active = false;
    current = null;
    if (message) say(message);
    console.log(`[goal] ended: ${reason}`);
  }

  async function run(goal) {
    const gen = ++generation;
    active = true;
    current = { goal, generation: gen, startedAt: performance.now() };
    say(`Looking for: ${goal}`);

    let iteration = 0;
    let blocked = false;
    let blockedStreak = 0;
    let notVisibleStreak = 0;
    let lastAction = null;
    let announcedVisible = false;
    let announcedMoving = false;

    while (isCurrent(gen)) {
      if (iteration >= GOAL_MAX_STEPS) {
        end("max_steps", "Stopped — step budget exhausted.");
        return;
      }
      if (performance.now() - current.startedAt > GOAL_MAX_DURATION_MS) {
        end("timeout", "Stopped — time budget exhausted.");
        return;
      }

      const frame = capture();
      if (!frame) {
        end("no_frame", "Stopped — Seekr could not capture a view.");
        return;
      }

      let reply;
      try {
        reply = await step({
          imageDataUrl: frame.dataUrl,
          goal,
          sceneId: frame.sceneId,
          body: {
            iteration,
            blocked,
            blocked_streak: blockedStreak,
            not_visible_streak: notVisibleStreak,
            last_action: lastAction,
          },
        });
      } catch (err) {
        end("brain_error", `Stopped — Brain error: ${err.message}`);
        return;
      }

      // A reply for a cancelled or replaced goal must never move Seekr.
      if (!isCurrent(gen)) return;

      const { perception, action } = reply;
      onPerception(reply, frame);

      if (perception.target_visible) {
        notVisibleStreak = 0;
        if (!announcedVisible) {
          announcedVisible = true;
          say(`Target visible — ${perception.horizontal}, ${perception.distance}.`);
        }
      } else {
        notVisibleStreak += 1;
        announcedMoving = false;
      }

      iteration += 1;
      lastAction = action.type;

      if (action.type === "stop") {
        end(action.outcome ?? "stop", action.reason ?? "Stopped.");
        return;
      }

      if (action.type === "turn_left" || action.type === "turn_right") {
        const degrees = Math.abs(Number(action.degrees) || 20);
        await turn(action.type === "turn_left" ? degrees : -degrees);
        blocked = false;
        if (!perception.target_visible && iteration === 1) say("Searching…");
      } else if (action.type === "move_forward") {
        if (!announcedMoving) {
          announcedMoving = true;
          say("Moving closer.");
        }
        const outcome = await moveForward(Number(action.meters) || 0.4);
        blocked = Boolean(outcome?.blocked);
        blockedStreak = blocked ? blockedStreak + 1 : 0;
        if (blocked) say("Blocked by the NavMesh — trying another heading.");
      } else {
        console.warn("[goal] Unknown Brain action, stopping:", action);
        end("unknown_action", "Stopped — the Brain sent an unknown action.");
        return;
      }

      // Let the movement settle and the splat re-render before re-perceiving.
      await sleep(settleMs);
    }
  }

  return {
    get active() {
      return active;
    },
    get goal() {
      return current?.goal ?? null;
    },

    /** Starts a goal, replacing any running one. */
    start(goal) {
      if (active) end("replaced");
      run(goal).catch((err) => {
        console.error("[goal] loop failed:", err);
        end("error", `Stopped — ${err.message}`);
      });
    },

    /** Human cancellation (chat "stop", manual WASD, new goal). */
    cancel(reason = "cancelled", message = "Stopped.") {
      end(reason, message);
    },
  };
}
