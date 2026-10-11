/**
 * memories.js — the Memories tab: a compact visual gallery of the egocentric
 * frames Seekr has explicitly retained, each stored through Memories.ai.
 *
 * A memory is a SELECTED visual experience (M / "Remember this view"); the
 * Perception tab holds everything Liquid observed. This module only displays
 * and holds the session list; storage goes through the Brain (main.js).
 *
 *   add(memory)       → card (status "pending" until Memories.ai confirms)
 *   setStatus(id, …)  → "stored" | "error" once the Brain replies
 *   addRemote(list)   → memories reloaded from Memories.ai after a restart
 *   click a card      → lightbox with the larger image + scene/time/description
 */
export function createMemories({ maxEntries = 60, onCreatePostcard = null } = {}) {
  /** Newest first. */
  const entries = [];
  let containerEl = null;
  let nextId = 1;

  /** Cards selected for a postcard (max 3), by record id. */
  const selected = new Set();
  const MAX_SELECTED = 3;
  let postcardBusy = false;
  let postcardStatus = null;

  // ── Lightbox (one overlay for the whole app; created lazily) ────────────
  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.className = "memory-lightbox hidden";
    overlayEl.innerHTML = `
      <div class="memory-lightbox-card" role="dialog" aria-label="Remembered view">
        <button type="button" class="memory-lightbox-close" data-role="close" title="Close">×</button>
        <img data-role="image" alt="Remembered egocentric view" />
        <div class="memory-lightbox-meta">
          <div class="memory-lightbox-title" data-role="title"></div>
          <div class="memory-lightbox-line" data-role="line"></div>
          <div class="memory-lightbox-desc" data-role="desc"></div>
        </div>
      </div>`;
    document.body.appendChild(overlayEl);
    overlayEl.addEventListener("click", (event) => {
      // Click outside the card, or the close button, dismisses.
      if (event.target === overlayEl || event.target.dataset.role === "close") closeLightbox();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !overlayEl.classList.contains("hidden")) closeLightbox();
    });
    return overlayEl;
  }

  function openLightbox(memory) {
    const el = ensureOverlay();
    el.querySelector('[data-role="image"]').src = memory.dataUrl ?? memory.imageUrl ?? "";
    el.querySelector('[data-role="title"]').textContent = memory.sceneName ?? memory.sceneId ?? "Memory";
    const parts = [new Date(memory.timestamp).toLocaleString()];
    if (memory.pose) {
      parts.push(
        `x ${memory.pose.x.toFixed(2)} · z ${memory.pose.z.toFixed(2)} · heading ${Math.round(memory.pose.headingDeg)}°`,
      );
    }
    parts.push(statusLabel(memory));
    el.querySelector('[data-role="line"]').textContent = parts.join("  ·  ");
    const desc = el.querySelector('[data-role="desc"]');
    desc.textContent = memory.description ?? "";
    desc.style.display = memory.description ? "" : "none";
    el.classList.remove("hidden");
  }

  function closeLightbox() {
    overlayEl?.classList.add("hidden");
  }

  function statusLabel(memory) {
    switch (memory.memoriesStatus) {
      case "stored":
        return `Memories.ai · stored${memory.memoriesId ? ` · ${memory.memoriesId}` : ""}`;
      case "processing":
        return `Memories.ai · processing${memory.memoriesId ? ` · ${memory.memoriesId}` : ""}`;
      case "error":
        return `Memories.ai · not stored — ${memory.memoriesError ?? "upload failed"}`;
      case "remote":
        return `Memories.ai · ${memory.memoriesId ?? ""}`;
      default:
        return "Memories.ai · encoding & uploading…";
    }
  }

  const BADGE_TEXT = {
    pending: "uploading…",
    processing: "Memories.ai · processing",
    stored: "Memories.ai · stored",
    remote: "Memories.ai",
    error: "not stored",
  };

  // ── Gallery ─────────────────────────────────────────────────────────────
  function render() {
    if (!containerEl) return;
    containerEl.innerHTML = "";

    const heading = document.createElement("div");
    heading.className = "ctl-section";
    heading.textContent = `MEMORIES · ${entries.length}`;
    containerEl.appendChild(heading);

    const attribution = document.createElement("div");
    attribution.className = "perception-model";
    attribution.textContent = "Stored with Memories.ai";
    containerEl.appendChild(attribution);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "obj-empty";
      empty.textContent = "No memories yet. Press M or use Controls ▸ SEEKR VISION ▸ Remember this view.";
      containerEl.appendChild(empty);
      return;
    }

    // ── Postcard controls (Black Forest Labs) ────────────────────────────
    if (onCreatePostcard) {
      const row = document.createElement("div");
      row.className = "postcard-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "obj-clear-btn";
      const n = selected.size;
      btn.textContent = postcardBusy
        ? "Creating postcard with Black Forest Labs…"
        : `Create Postcard${n ? ` (${n} selected)` : ""}`;
      btn.disabled = postcardBusy || n === 0;
      btn.title = n === 0 ? "Tick up to 3 memories first" : "Generate a memory postcard with FLUX.2 [pro]";
      btn.addEventListener("click", () => {
        const picked = entries.filter((m) => selected.has(m.id) && m.dataUrl);
        if (picked.length) onCreatePostcard(picked);
      });
      row.appendChild(btn);
      const hint = document.createElement("div");
      hint.className = "memory-time";
      hint.textContent = postcardStatus ?? `Tick up to ${MAX_SELECTED} memories · Black Forest Labs FLUX.2 [pro]`;
      row.appendChild(hint);
      containerEl.appendChild(row);
    }

    const grid = document.createElement("div");
    grid.className = "memory-grid";

    for (const memory of entries) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `memory-card memory-card--${memory.memoriesStatus}${selected.has(memory.id) ? " memory-card--selected" : ""}`;
      card.title = "Open this memory";
      card.addEventListener("click", () => openLightbox(memory));

      if (onCreatePostcard && memory.dataUrl) {
        // Selection tick for the postcard; stops the click from opening the lightbox.
        const tick = document.createElement("label");
        tick.className = "memory-select";
        tick.title = "Select for postcard";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.has(memory.id);
        box.disabled = !box.checked && selected.size >= MAX_SELECTED;
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => {
          if (box.checked) selected.add(memory.id);
          else selected.delete(memory.id);
          render();
        });
        tick.addEventListener("click", (e) => e.stopPropagation());
        tick.appendChild(box);
        card.appendChild(tick);
      }

      const img = document.createElement("img");
      img.className = "memory-thumb";
      img.src = memory.dataUrl ?? memory.imageUrl ?? "";
      img.alt = `Ego view in ${memory.sceneName ?? memory.sceneId ?? "scene"}`;
      img.loading = "lazy";
      card.appendChild(img);

      const scene = document.createElement("div");
      scene.className = "memory-scene";
      scene.textContent = memory.sceneName ?? memory.sceneId ?? "—";
      card.appendChild(scene);

      const time = document.createElement("div");
      time.className = "memory-time";
      time.textContent = new Date(memory.timestamp).toLocaleTimeString();
      card.appendChild(time);

      if (memory.description) {
        const excerpt = document.createElement("div");
        excerpt.className = "memory-excerpt";
        excerpt.textContent = memory.description;
        card.appendChild(excerpt);
      }

      const badge = document.createElement("div");
      badge.className = `memory-badge memory-badge--${memory.memoriesStatus}`;
      badge.textContent = BADGE_TEXT[memory.memoriesStatus] ?? memory.memoriesStatus;
      card.appendChild(badge);

      grid.appendChild(card);
    }

    containerEl.appendChild(grid);
  }

  return {
    mount(el) {
      containerEl = el;
      render();
    },

    /**
     * Adds a locally captured memory (newest first). Returns the record; the
     * caller updates its Memories.ai status with setStatus().
     */
    add(memory) {
      if (!memory?.dataUrl) return null;
      const record = {
        id: nextId++,
        timestamp: Date.now(),
        memoriesStatus: "pending",
        memoriesId: null,
        memoriesError: null,
        ...memory,
      };
      entries.unshift(record);
      while (entries.length > maxEntries) entries.pop();
      render();
      return record;
    },

    setStatus(id, { status, memoriesId = null, operationId = null, error = null }) {
      const record = entries.find((m) => m.id === id);
      if (!record) return;
      record.memoriesStatus = status;
      if (memoriesId) record.memoriesId = memoriesId;
      if (operationId) record.operationId = operationId;
      record.memoriesError = error;
      render();
    },

    /** Merge memories reloaded from Memories.ai (skips ones already shown). */
    addRemote(list) {
      const known = new Set(entries.map((m) => m.memoriesId).filter(Boolean));
      let added = 0;
      for (const item of list) {
        if (!item.memory_id || known.has(item.memory_id) || !item.image_url) continue;
        entries.push({
          id: nextId++,
          timestamp: item.captured_at ? Date.parse(item.captured_at) : Date.now(),
          dataUrl: null,
          imageUrl: item.image_url,
          sceneId: item.scene_id ?? null,
          sceneName: item.scene_name ?? item.title ?? null,
          description: item.description ?? null,
          pose: item.pose ?? null,
          memoriesStatus: "remote",
          memoriesId: item.memory_id,
          memoriesError: null,
        });
        added += 1;
      }
      entries.sort((a, b) => b.timestamp - a.timestamp);
      while (entries.length > maxEntries) entries.pop();
      render();
      return added;
    },

    /** Postcard generation state shown above the gallery. */
    setPostcardBusy(busy, status = null) {
      postcardBusy = Boolean(busy);
      postcardStatus = status;
      render();
    },

    clearSelection() {
      selected.clear();
      render();
    },

    clear() {
      entries.length = 0;
      selected.clear();
      render();
    },

    getAll: () => [...entries],
    get size() {
      return entries.length;
    },
  };
}
