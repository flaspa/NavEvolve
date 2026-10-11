/**
 * perceptionTab.js — the Perception tab: a chronological, session-only history
 * of what Liquid AI observed from Seekr's egocentric view.
 *
 * Display only. Every completed /perceive result is appended as a new entry
 * (timestamp · scene, description, latency) — nothing is overwritten, parsed,
 * persisted or sent anywhere. Newest at the bottom; the panel scrolls to it
 * when a result arrives (deferred until the tab is visible if it is hidden).
 *
 * A perception is what Liquid observed. A memory (Memories tab) will later be
 * a selected perception/experience that Seekr retains — kept separate.
 */
import { PERCEPTION_MODEL_LABEL } from "./seekrVision.js";

export function createPerceptionTab({ maxEntries = 200 } = {}) {
  let containerEl = null;
  const entries = []; // oldest first
  let error = null;
  let pendingScroll = false;
  let nextId = 1;

  function fmtLatency(ms) {
    if (!Number.isFinite(ms)) return null;
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
  }

  function scrollToNewest() {
    if (!containerEl) return;
    // A hidden panel has no scroll extent yet; retry when it is shown.
    if (containerEl.classList.contains("hidden")) {
      pendingScroll = true;
      return;
    }
    pendingScroll = false;
    requestAnimationFrame(() => {
      containerEl.scrollTop = containerEl.scrollHeight;
    });
  }

  function render() {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "ctl-section";
    heading.textContent = "PERCEPTION";
    containerEl.appendChild(heading);

    const model = document.createElement("div");
    model.className = "perception-model";
    model.textContent = PERCEPTION_MODEL_LABEL;
    containerEl.appendChild(model);

    if (entries.length === 0 && !error) {
      const empty = document.createElement("div");
      empty.className = "obj-empty";
      empty.textContent =
        "No perception yet. Click Analyze Vision in SEEKR VISION, or ask in Chat.";
      containerEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "perception-entry";

      const header = document.createElement("div");
      header.className = "perception-header";
      header.textContent = [
        new Date(entry.timestamp).toLocaleTimeString(),
        entry.sceneName,
      ]
        .filter(Boolean)
        .join(" · ");
      card.appendChild(header);

      const text = document.createElement("div");
      text.className = "perception-text";
      text.textContent = entry.description;
      card.appendChild(text);

      const latency = fmtLatency(entry.latencyMs);
      if (latency) {
        const meta = document.createElement("div");
        meta.className = "perception-latency";
        meta.textContent = `Latency: ${latency}`;
        card.appendChild(meta);
      }

      containerEl.appendChild(card);
    }

    if (error) {
      const el = document.createElement("div");
      el.className = "perception-text error";
      el.textContent = error;
      containerEl.appendChild(el);
    }
  }

  return {
    mount(el) {
      containerEl = el;
      // The tab toggles the `hidden` class; a scroll requested while hidden
      // is carried out the moment the panel becomes visible.
      new MutationObserver(() => {
        if (pendingScroll && !containerEl.classList.contains("hidden")) scrollToNewest();
      }).observe(el, { attributes: true, attributeFilter: ["class"] });
      render();
    },

    /** Append the newest completed result and scroll to it. */
    show({ description, latencyMs = null, model = null, sceneName = null }) {
      error = null;
      entries.push({
        id: nextId++,
        timestamp: Date.now(),
        description,
        latencyMs,
        model,
        sceneName,
      });
      while (entries.length > maxEntries) entries.shift();
      render();
      scrollToNewest();
    },

    /** A failure is shown once at the bottom; history above is kept. */
    showError(message) {
      error = message;
      render();
      scrollToNewest();
    },

    getAll: () => [...entries],
    get size() {
      return entries.length;
    },
  };
}
