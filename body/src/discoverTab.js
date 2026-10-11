/**
 * discoverTab.js — the Discover tab: live web results (Nimble) for an object
 * Seekr is looking at, as described by Liquid. Display only.
 */
export function createDiscoverTab() {
  let containerEl = null;
  let state = { status: "idle", request: null, perception: null, results: [], error: null };

  function render() {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "ctl-section";
    heading.textContent = "DISCOVER";
    containerEl.appendChild(heading);

    const powered = document.createElement("div");
    powered.className = "perception-model";
    powered.textContent = "Powered by Nimble · described by Liquid AI";
    containerEl.appendChild(powered);

    if (state.status === "idle") {
      const empty = document.createElement("div");
      empty.className = "obj-empty";
      empty.textContent = 'Ask in Chat: "Find stools like this online."';
      containerEl.appendChild(empty);
      return;
    }

    if (state.perception) {
      const label = document.createElement("div");
      label.className = "perception-header";
      label.textContent = "Looking for:";
      containerEl.appendChild(label);
      const desc = document.createElement("div");
      desc.className = "perception-text";
      desc.textContent = state.perception.description || state.perception.object || state.request;
      containerEl.appendChild(desc);
    }

    if (state.status === "searching") {
      const busy = document.createElement("div");
      busy.className = "perception-latency";
      busy.textContent = "Searching the live web with Nimble…";
      containerEl.appendChild(busy);
      return;
    }

    if (state.error) {
      const err = document.createElement("div");
      err.className = "perception-text error";
      err.textContent = state.error;
      containerEl.appendChild(err);
      return;
    }

    if (state.results.length === 0) {
      const none = document.createElement("div");
      none.className = "obj-empty";
      none.textContent = "No results.";
      containerEl.appendChild(none);
      return;
    }

    for (const r of state.results) {
      const card = document.createElement("div");
      card.className = "perception-entry discover-card";

      const title = document.createElement("div");
      title.className = "discover-title";
      title.textContent = r.title;
      card.appendChild(title);

      if (r.description) {
        const snippet = document.createElement("div");
        snippet.className = "memory-excerpt";
        snippet.textContent = r.description;
        card.appendChild(snippet);
      }

      const row = document.createElement("div");
      row.className = "discover-row";
      const source = document.createElement("span");
      source.className = "memory-time";
      source.textContent = r.source ?? "";
      const link = document.createElement("a");
      link.className = "discover-open";
      link.href = r.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open result ↗";
      row.append(source, link);
      card.appendChild(row);

      containerEl.appendChild(card);
    }
  }

  return {
    mount(el) {
      containerEl = el;
      render();
    },
    searching(request, perception = null) {
      state = { status: "searching", request, perception, results: [], error: null };
      render();
    },
    show({ request, perception, results }) {
      state = { status: "done", request, perception, results: results ?? [], error: null };
      render();
    },
    fail(request, perception, message) {
      state = { status: "done", request, perception, results: [], error: message };
      render();
    },

    /** The first useful current result, for the postcard link, or null. */
    latestResult() {
      const r = state.results?.[0];
      return r ? { title: r.title, url: r.url, source: r.source } : null;
    },
  };
}
