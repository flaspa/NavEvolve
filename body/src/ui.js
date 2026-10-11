/**
 * ui.js — Desktop web UI.
 *
 * Layout:
 *   - Top-left HUD: status, live position, view-mode buttons, controls help
 *   - Right sidebar: minimap (top) + tabbed panel (Controls / Chat)
 *
 * The Controls tab is populated by main.js via buildControls(schema) so all
 * bindings (CONFIG ↔ scene) stay in one place. The Chat tab is the future
 * hook for agent.js.
 */
import {
  formatFloorplanPosition,
  formatCameraPosition,
} from "./hudPosition.js";
import { parseNumericEdit } from "./valueEdit.js";

/**
 * Plain-text transcript of chat lines, oldest first, one blank line between
 * messages: "Coach: Find the stool". Message text is preserved exactly. A
 * research utility for pasting a run into a document; it reads display data
 * only and is never sent anywhere.
 *
 * @param {{from: string, text: string}[]} lines
 * @returns {string}
 */
export function formatChatTranscript(lines) {
  return lines.map((line) => `${line.from}: ${line.text}`).join("\n\n");
}

/**
 * Confirmation shown before the visible transcript is discarded. It names the
 * scope out loud, because "clear" in an agent UI is easily mistaken for a
 * reset.
 */
export const CLEAR_CHAT_CONFIRM =
  "Clear the visible conversation?\nThis will not affect navigation or Brain state.";

/**
 * Removes the chat lines currently displayed in the log element and returns
 * how many were removed.
 *
 * Display only. The log holds nothing but .chat-line elements and no other
 * module reads it, so the goal, navigation, brain, model selection, action
 * history and session state are all untouched by this.
 *
 * @param {{querySelectorAll: (s: string) => Iterable<{remove: () => void}>}} logEl
 * @returns {number} lines removed
 */
export function clearChatLog(logEl) {
  const lines = [...logEl.querySelectorAll(".chat-line")];
  for (const line of lines) line.remove();
  return lines.length;
}

export function createUI({ title = "Spark WebXR Research" } = {}) {
  // ---------- top-left HUD ----------
  const root = document.createElement("div");
  root.id = "hud";
  root.innerHTML = `
    <div class="hud-panel">
      <div class="hud-title">${title}</div>
      <div class="hud-scene" data-role="scene-name"></div>
      <div class="hud-brain" data-role="brain-status">Explorer brain: starting…</div>
      <div class="hud-status" data-role="status">Initializing…</div>
      <div class="hud-pos" data-role="pos"></div>
      <div class="hud-pos hud-cam" data-role="camera-pos"></div>
      <div class="hud-view">
        <button type="button" data-mode="first">1st Person</button>
        <button type="button" data-mode="third">3rd Person</button>
      </div>
      <div class="hud-help" data-role="help">
        Click scene + move mouse, or use arrow keys to look around<br>
        <b>Esc</b> release mouse · <b>WASD</b> move · <b>V</b> change view<br>
        <b>N</b> NavMesh · <b>M</b> remember view · <b>P</b> report position
      </div>
    </div>
    <button type="button" class="edge-toggle edge-toggle-left"
            data-role="hud-toggle" aria-expanded="true"
            title="Hide the HUD">‹</button>`;
  document.body.appendChild(root);

  const statusEl = root.querySelector('[data-role="status"]');
  // Brain connection state has its own line so Explorer/view status
  // (setStatus) can never overwrite it, and vice versa.
  const brainStatusEl = root.querySelector('[data-role="brain-status"]');
  // Human-friendly name of the active Gaussian scene (the exact filename
  // stays in the Controls ▸ WORLD ASSETS readout).
  const sceneNameEl = root.querySelector('[data-role="scene-name"]');
  // Two separate read-outs: Seekr's floorplan position and the active
  // camera's world position (they differ in third person).
  const posEl = root.querySelector('[data-role="pos"]');
  const cameraPosEl = root.querySelector('[data-role="camera-pos"]');
  const helpEl = root.querySelector('[data-role="help"]');
  const viewButtons = [...root.querySelectorAll(".hud-view button")];

  let viewChangeHandler = null;
  for (const btn of viewButtons) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      viewChangeHandler?.(btn.dataset.mode);
    });
  }

  function setViewMode(mode) {
    for (const btn of viewButtons) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
  }

  // ---------- right sidebar ----------
  const sidebar = document.createElement("div");
  sidebar.id = "sidebar";
  sidebar.innerHTML = `
    <div data-role="vision-mount"></div>
    <div data-role="minimap-mount"></div>
    <div class="panel">
      <div class="panel-tabs">
        <button type="button" data-tab="controls" class="active">Controls</button>
        <button type="button" data-tab="chat">Chat</button>
        <button type="button" data-tab="discover">Discover</button>
        <button type="button" data-tab="memories">Memories</button>
      </div>
      <div class="panel-body" data-tab-panel="controls"></div>
      <div class="panel-body hidden" data-tab-panel="chat">
        <div class="chat-tools">
          <button type="button" class="chat-copy" data-role="copy-chat"
                  title="Copy the chat transcript as plain text">Copy chat</button>
          <button type="button" class="chat-copy" data-role="clear-chat"
                  title="Clear the chat transcript shown here. Navigation, the active goal and brain state are not affected.">Clear chat</button>
          <span class="chat-copy-note" data-role="copy-chat-note" aria-live="polite"></span>
        </div>
        <div class="chat-log" data-role="log"></div>
        <form class="chat-row" data-role="form">
          <input type="text" data-role="input"
                 placeholder="Message or command… (Enter)" autocomplete="off" />
          <button type="submit">Send</button>
        </form>
      </div>
      <div class="panel-body hidden" data-tab-panel="discover"></div>
      <div class="panel-body hidden" data-tab-panel="memories"></div>
    </div>
    <button type="button" class="edge-toggle edge-toggle-right"
            data-role="sidebar-toggle" aria-expanded="true"
            title="Hide the panel">›</button>`;
  document.body.appendChild(sidebar);

  // ── Collapsible panels ───────────────────────────────────────────────
  // Presentation only. Both roots are `position: fixed`, so sliding them
  // cannot resize the canvas or disturb the camera aspect — and the DOM is
  // never destroyed, so the selected tab, chat log, controls and benchmark
  // state all survive a collapse untouched.
  //
  // The two are independent: each owns its own flag and its own class.

  /** Arrow glyphs per side, by state. Open points AWAY from the scene. */
  const EDGE_ARROWS = Object.freeze({
    left: { open: "‹", collapsed: "›" },
    right: { open: "›", collapsed: "‹" },
  });

  /**
   * Wires one edge toggle to one panel root.
   *
   * Collapsing adds a class; CSS does the sliding. Nothing here measures,
   * animates by hand, or touches the panel's contents.
   */
  function createEdgeToggle(rootEl, side, label) {
    const button = rootEl.querySelector(".edge-toggle");
    let collapsed = false;

    function apply() {
      rootEl.classList.toggle("collapsed", collapsed);
      button.textContent = EDGE_ARROWS[side][collapsed ? "collapsed" : "open"];
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = `${collapsed ? "Show" : "Hide"} the ${label}`;
    }

    button.addEventListener("click", () => {
      collapsed = !collapsed;
      apply();
    });

    apply();

    return {
      get collapsed() {
        return collapsed;
      },
      set(next) {
        collapsed = Boolean(next);
        apply();
      },
      toggle() {
        collapsed = !collapsed;
        apply();
      },
    };
  }

  const hudToggle = createEdgeToggle(root, "left", "HUD");
  const sidebarToggle = createEdgeToggle(sidebar, "right", "panel");

  const minimapMount = sidebar.querySelector('[data-role="minimap-mount"]');
  const tabButtons = [...sidebar.querySelectorAll(".panel-tabs button")];
  const tabPanels = [...sidebar.querySelectorAll("[data-tab-panel]")];
  const memoriesPanel = sidebar.querySelector('[data-tab-panel="memories"]');
  const discoverPanel = sidebar.querySelector('[data-tab-panel="discover"]');
  // Perception history stays alive (navigation and memories read it) but is
  // no longer a visible tab: it renders into a detached container.
  const perceptionPanel = document.createElement("div");
  const visionMount = sidebar.querySelector('[data-role="vision-mount"]');

  /**
   * Chat speakers that get their own styling.
   *
   * EVALUATOR is benchmark feedback — a verdict ABOUT a run, not something
   * the agent said. It is deliberately a different colour from Explorer so a
   * reader never mistakes a score for the agent's own voice, and it is never
   * transmitted: the brain receives only what the coach types (see
   * `sendCoachMessage` in main.js), so nothing appended here becomes agent
   * conversation or context.
   */
  const EVALUATOR_SPEAKER = "Evaluator";

  const CHAT_ROLE_CLASS = Object.freeze({
    [EVALUATOR_SPEAKER]: "chat-evaluator",
  });

  /** The extra class for a speaker, or null. Unknown speakers stay default. */
  const chatRoleClass = (from) => CHAT_ROLE_CLASS[from] ?? null;

  function showTab(name) {
    for (const b of tabButtons)
      b.classList.toggle("active", b.dataset.tab === name);
    for (const p of tabPanels)
      p.classList.toggle("hidden", p.dataset.tabPanel !== name);
  }
  for (const b of tabButtons) {
    b.addEventListener("click", () => showTab(b.dataset.tab));
  }

  // ---------- controls builder ----------
  const controlsPanel = sidebar.querySelector('[data-tab-panel="controls"]');
  const controlRefs = new Map(); // id → { input, valueEl } | { input }

  /**
   * schema: array of
   *  { type: "section", label }
   *  { type: "slider", id, label, min, max, step, value, onChange, format?,
   *    editable? }  editable: double-click the value to type an exact number
   *  { type: "checkbox", id, label, value, onChange }
   *  { type: "button", label, onClick, disabled? }
   *  { type: "select", id, label, options: [{value,label}], value, onChange? }
   *  { type: "readout", id, label, value }   read-only text, updated via setControl
   *  { type: "note", text }                   static full-width caption
   */
  /**
   * Double-click the value to type an exact number.
   *
   * Enter / blur commit, Escape cancels. A rejected value restores the
   * previous one untouched — nothing is clamped and nothing is half-applied.
   * Focusing the input also parks the global hotkeys, because isTyping() in
   * main.js and player.js already ignore keys while an <input> has focus.
   */
  function attachNumericEdit({ row, valueEl, ref, item, applyValue }) {
    valueEl.title = "Double-click to type an exact value";
    valueEl.classList.add("ctl-value-editable");

    let editing = false;

    valueEl.addEventListener("dblclick", () => {
      if (editing) return;
      editing = true;

      const previous = ref.value;
      const field = document.createElement("input");
      field.type = "text";
      field.className = "ctl-value-input";
      field.setAttribute("aria-label", `${item.label} value`);
      // Seeded from the exact applied number, never the rounded display, so
      // repeated edits cannot erode precision.
      field.value = String(previous);

      valueEl.textContent = "";
      valueEl.classList.add("editing");
      valueEl.appendChild(field);
      field.focus();
      field.select();

      function endEdit(value) {
        editing = false;
        valueEl.classList.remove("editing");
        field.remove();
        applyValue(value);
      }

      function commit() {
        if (!editing) return;
        const result = parseNumericEdit(field.value, {
          min: parseFloat(item.min),
          max: parseFloat(item.max),
        });
        // Rejected input restores the previous value verbatim.
        endEdit(result.ok ? result.value : previous);
      }

      field.addEventListener("keydown", (e) => {
        // Keep Enter/Escape from reaching chat or the world hotkeys.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          endEdit(previous);
        }
      });

      field.addEventListener("blur", commit);
    });
  }

  function buildControls(schema) {
    controlsPanel.innerHTML = "";
    controlRefs.clear();
    for (const item of schema) {
      if (item.type === "section") {
        const h = document.createElement("div");
        h.className = "ctl-section";
        h.textContent = item.label;
        controlsPanel.appendChild(h);
      } else if (item.type === "slider") {
        // A <label> would steal the double-click and re-focus the range input,
        // so editable rows use a plain div.
        const row = document.createElement(item.editable ? "div" : "label");
        row.className = "ctl-row";
        const fmt = item.format ?? ((v) => (+v).toFixed(2));
        row.innerHTML = `
          <span class="ctl-label">${item.label}</span>
          <input type="range" min="${item.min}" max="${item.max}"
                 step="${item.step}" value="${item.value}">
          <span class="ctl-value">${fmt(item.value)}</span>`;
        const input = row.querySelector("input");
        const valueEl = row.querySelector(".ctl-value");

        // `ref.value` is the authoritative applied number. The range input
        // snaps to `step`, so it cannot be trusted to round-trip a typed
        // value like 0.065 — the display and the next edit both read this.
        const ref = { input, valueEl, fmt, value: +item.value };
        controlRefs.set(item.id, ref);

        /** The single path both the slider and typed entry apply through. */
        function applyValue(value) {
          ref.value = value;
          input.value = value; // may snap the thumb; ref.value stays exact
          valueEl.textContent = fmt(value);
          item.onChange?.(value);
        }

        input.addEventListener("input", () => applyValue(parseFloat(input.value)));

        if (item.editable) {
          attachNumericEdit({ row, valueEl, ref, item, applyValue });
        }

        controlsPanel.appendChild(row);
      } else if (item.type === "checkbox") {
        const row = document.createElement("label");
        row.className = "ctl-row ctl-check";
        row.innerHTML = `
          <input type="checkbox" ${item.value ? "checked" : ""}>
          <span class="ctl-label">${item.label}</span>`;
        const input = row.querySelector("input");
        input.addEventListener("change", () => item.onChange?.(input.checked));
        controlsPanel.appendChild(row);
        controlRefs.set(item.id, { input });
      } else if (item.type === "readout") {
        const row = document.createElement("div");
        row.className = "ctl-row ctl-readout";
        row.innerHTML = `
          <span class="ctl-label">${item.label}</span>
          <span class="ctl-value"></span>`;
        const valueEl = row.querySelector(".ctl-value");
        valueEl.textContent = item.value ?? "";
        valueEl.title = item.value ?? "";
        controlsPanel.appendChild(row);
        controlRefs.set(item.id, { valueEl });
      } else if (item.type === "note") {
        const note = document.createElement("div");
        note.className = "ctl-note";
        note.textContent = item.text;
        controlsPanel.appendChild(note);
      } else if (item.type === "select") {
        // Label above a full-width select, so long option text is readable
        // in the narrow panel.
        const row = document.createElement("div");
        row.className = "ctl-select-row";

        const caption = document.createElement("div");
        caption.className = "ctl-select-label";
        caption.textContent = item.label;

        const select = document.createElement("select");
        select.className = "ctl-select";

        for (const option of item.options ?? []) {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          select.appendChild(el);
        }
        if (item.value !== undefined && item.value !== null) {
          select.value = item.value;
        }

        // onChange is optional: a select with none is inert UI state.
        if (item.onChange) {
          select.addEventListener("change", () => item.onChange(select.value));
        }

        row.append(caption, select);
        controlsPanel.appendChild(row);
        if (item.id) controlRefs.set(item.id, { input: select });
      } else if (item.type === "button") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ctl-button";
        btn.textContent = item.label;
        if (item.disabled) btn.disabled = true;
        btn.addEventListener("click", () => item.onClick?.());
        controlsPanel.appendChild(btn);
        if (item.id) controlRefs.set(item.id, { input: btn });
      } else if (item.type === "mount") {
        // An empty container a dedicated module renders into, so a panel with
        // its own layout can sit inside the schema without every one of its
        // widgets becoming a schema item type. The module owns what goes in;
        // this owns only where it goes. Retrieved via getControlMount(id) —
        // buildControls() rebuilds the panel on every scene activation, so a
        // caller must re-mount after each build.
        const host = document.createElement("div");
        host.className = "ctl-mount";
        controlsPanel.appendChild(host);
        if (item.id) controlRefs.set(item.id, { mountEl: host });
      }
    }
  }

  /** The container created by a `mount` schema item, or null. */
  function getControlMount(id) {
    return controlRefs.get(id)?.mountEl ?? null;
  }

  /** Sync a control's displayed value from outside (e.g. hotkeys). */
  function setControl(id, value) {
    const ref = controlRefs.get(id);
    if (!ref) return;
    // A mount host has no value of its own — the module that owns its
    // contents updates them directly.
    if (ref.mountEl) return;
    if (!ref.input) {
      // Read-only readout row — no input element to sync.
      ref.valueEl.textContent = value ?? "";
      ref.valueEl.title = value ?? "";
      return;
    }
    if (ref.input.type === "checkbox") {
      ref.input.checked = !!value;
    } else {
      ref.input.value = value;
      if ("value" in ref) ref.value = +value;
      if (ref.valueEl) ref.valueEl.textContent = ref.fmt(value);
    }
  }

  // ---------- chat ----------
  const logEl = sidebar.querySelector('[data-role="log"]');
  const formEl = sidebar.querySelector('[data-role="form"]');
  const inputEl = sidebar.querySelector('[data-role="input"]');

  let submitHandler = null;
  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    inputEl.blur(); // give WASD control back after sending
    submitHandler?.(text);
  });

  // ---------- copy chat (read-only research utility) ----------
  // Reads the speaker and message text of the chat lines currently shown and
  // copies them as plain text. Thumbnails, the input box, buttons and any
  // other UI text are not read; nothing is appended to the chat and nothing
  // reaches the brain.
  const copyChatBtn = sidebar.querySelector('[data-role="copy-chat"]');
  const copyChatNote = sidebar.querySelector('[data-role="copy-chat-note"]');
  let copyChatNoteTimer = null;

  /** The displayed transcript, oldest first: speaker label + message text per line. */
  function chatTranscriptLines() {
    return [...logEl.querySelectorAll(".chat-line")].map((line) => ({
      from: (line.querySelector(":scope > b")?.textContent ?? "").trim(),
      text: line.querySelector(":scope > span")?.textContent ?? "",
    }));
  }

  function noteChatCopy(label) {
    copyChatNote.textContent = label;
    clearTimeout(copyChatNoteTimer);
    copyChatNoteTimer = setTimeout(() => {
      copyChatNote.textContent = "";
    }, 2000);
  }

  function copyChatTranscript() {
    const transcript = formatChatTranscript(chatTranscriptLines());
    if (!navigator.clipboard?.writeText) {
      noteChatCopy("Copy failed");
      return;
    }
    navigator.clipboard.writeText(transcript).then(
      () => noteChatCopy("Chat copied"),
      () => noteChatCopy("Copy failed"),
    );
  }
  copyChatBtn.addEventListener("click", copyChatTranscript);

  // ---------- clear chat (display only) ----------
  // Discards the chat lines currently shown, after a confirmation, and does
  // nothing else: see clearChatLog above for why this cannot reach the goal,
  // navigation, brain, model selection, action history or session state. The
  // acknowledgement reuses the chat-tools note line, so it is non-modal and
  // clears itself.
  const clearChatBtn = sidebar.querySelector('[data-role="clear-chat"]');

  function clearChatTranscript() {
    if (chatTranscriptLines().length === 0) {
      noteChatCopy("Nothing to clear");
      return;
    }
    if (!window.confirm(CLEAR_CHAT_CONFIRM)) return;
    clearChatLog(logEl);
    noteChatCopy("Conversation cleared");
  }
  clearChatBtn.addEventListener("click", clearChatTranscript);

  function addMessage(from, text) {
    const line = document.createElement("div");
    line.className = "chat-line";

    const role = chatRoleClass(from);
    if (role) line.classList.add(role);

    const speaker = document.createElement("b");
    speaker.textContent = `${from} `;

    const message = document.createElement("span");
    message.textContent = text;

    line.append(speaker, message);
    logEl.appendChild(line);

    while (logEl.children.length > 50) {
      logEl.firstChild.remove();
    }

    logEl.scrollTop = logEl.scrollHeight;
    // Deliberately does NOT switch tabs. An arriving message must not pull the
    // user off the Controls or Benchmark tab they are working in — during a
    // run that happened on every observation. The Chat tab is reached by
    // clicking it, or by focusInput(), which is an explicit user action.
  }

  /**
   * Adds a chat message with a small clickable thumbnail of the captured
   * perception frame.
   *
   * The imageDataUrl is set as img.src directly — it is never passed to any
   * console method.
   *
   * @param {string} from       Speaker label (e.g. "System").
   * @param {string} text       Message text.
   * @param {object} [frameData]
   * @param {string} [frameData.imageDataUrl]  JPEG data URL. Set directly on img.
   * @param {string} [frameData.altText]       Accessible alt text for the image.
   * @param {number} [frameData.captureTime]   Timestamp for the lightbox caption.
   * @param {string} [frameData.obsId]         Observation ID for the lightbox caption.
   */
  function addMessageWithFrame(from, text, { imageDataUrl, altText, captureTime, obsId } = {}) {
    const line = document.createElement("div");
    line.className = "chat-line";

    const role = chatRoleClass(from);
    if (role) line.classList.add(role);

    const speaker = document.createElement("b");
    speaker.textContent = `${from} `;

    const message = document.createElement("span");
    message.textContent = text;

    line.append(speaker, message);

    // ---- thumbnail ----
    if (imageDataUrl) {
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "chat-thumb-wrap";

      const thumb = document.createElement("img");
      thumb.className = "chat-thumb";
      // Direct src assignment — the data URL is never passed to console methods.
      thumb.src = imageDataUrl;
      thumb.alt = altText ?? "Explorer ego/perception view";
      thumb.title = "Click to enlarge";

      thumb.addEventListener("click", () => {
        // Remove any stale modal before opening a new one.
        document.querySelector(".perception-modal-overlay")?.remove();

        const overlay = document.createElement("div");
        overlay.className = "perception-modal-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Perception frame viewer");

        const modal = document.createElement("div");
        modal.className = "perception-modal";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "perception-modal-close";
        closeBtn.textContent = "\u00d7";
        closeBtn.setAttribute("aria-label", "Close perception frame viewer");

        const img = document.createElement("img");
        img.className = "perception-modal-img";
        // Direct src assignment — not logged.
        img.src = imageDataUrl;
        img.alt = altText ?? "Explorer ego/perception view";

        const metaEl = document.createElement("div");
        metaEl.className = "perception-modal-meta";
        const timeStr = captureTime
          ? new Date(captureTime).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          : "";
        metaEl.textContent = [
          "Explorer ego/perception view",
          obsId ?? null,
          timeStr || null,
        ]
          .filter(Boolean)
          .join(" \u00b7 ");

        modal.append(closeBtn, img, metaEl);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function closeModal() {
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
        }

        function escHandler(e) {
          if (e.key === "Escape") closeModal();
        }

        closeBtn.addEventListener("click", closeModal);
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) closeModal();
        });
        document.addEventListener("keydown", escHandler);
      });

      thumbWrap.appendChild(thumb);
      line.appendChild(thumbWrap);
    }

    logEl.appendChild(line);

    while (logEl.children.length > 50) {
      logEl.firstChild.remove();
    }

    logEl.scrollTop = logEl.scrollHeight;
    // Same rule as addMessage: arriving content never steals the active tab.
  }

  function showCaptureGallery(frames = []) {
    document.querySelector(".capture-gallery-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "capture-gallery-overlay";

    const gallery = document.createElement("div");
    gallery.className = "capture-gallery";

    const header = document.createElement("div");
    header.className = "capture-gallery-header";

    const titleEl = document.createElement("div");
    titleEl.className = "capture-gallery-title";
    titleEl.textContent = `Explorer Vision · ${frames.length} frame${
      frames.length === 1 ? "" : "s"
    }`;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "capture-gallery-close";
    closeButton.textContent = "Close";

    header.append(titleEl, closeButton);

    const grid = document.createElement("div");
    grid.className = "capture-gallery-grid";

    if (!frames.length) {
      const empty = document.createElement("div");
      empty.className = "capture-gallery-empty";
      empty.textContent =
        "No captured frames yet. Capture one frame or enable automatic eye capture.";

      grid.appendChild(empty);
    } else {
      for (const frame of [...frames].reverse()) {
        const card = document.createElement("article");
        card.className = "capture-card";

        const image = document.createElement("img");
        image.className = "capture-card-image";
        image.src = frame.image;
        image.alt = `Explorer capture ${frame.id}`;

        const meta = document.createElement("div");
        meta.className = "capture-card-meta";

        const timestamp = new Date(frame.timestamp).toLocaleTimeString();

        meta.textContent =
          `Frame ${frame.id} · ${frame.view ?? "camera"} · ${timestamp}`;

        card.append(image, meta);
        grid.appendChild(card);
      }
    }

    gallery.append(header, grid);
    overlay.appendChild(gallery);
    document.body.appendChild(overlay);

    function closeGallery() {
      overlay.remove();
    }

    closeButton.addEventListener("click", closeGallery);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closeGallery();
      }
    });

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.code === "Escape") {
          closeGallery();
        }
      },
      { once: true },
    );
  }
  
  return {
    /** Explorer / view / navigation state — e.g. "Explorer ready · Third-person". */
    setStatus(text) {
      statusEl.textContent = text;
    },

    /** Brain connection state only — kept separate from setStatus. */
    setBrainStatus(text) {
      brainStatusEl.textContent = text;
    },

    /** Active scene's display name, e.g. "Scene: interior_0516_840045". */
    setSceneName(name) {
      sceneNameEl.textContent = name ? `Scene: ${name}` : "";
    },

    /**
     * Seekr's own position on the floorplan (horizontal x/z only).
     * Independent of camera mode — see hudPosition.js.
     */
    setFloorplanPosition(x, z) {
      posEl.textContent = formatFloorplanPosition(x, z);
    },

    /** Active camera world position, labelled by camera mode. */
    setCameraPosition(mode, x, y, z) {
      cameraPosEl.textContent = formatCameraPosition(mode, x, y, z);
    },

    setHelpVisible(visible) {
      helpEl.style.display = visible ? "" : "none";
    },

    setViewMode,

    onViewChange(fn) {
      viewChangeHandler = fn;
    },

    minimapMount,

    visionMount,
    perceptionPanel,
    discoverPanel,
    memoriesPanel,

    buildControls,
    getControlMount,

    setControl,

    /** Enables/disables one control (buttons and selects). */
    setControlDisabled(id, disabled) {
      const ref = controlRefs.get(id);
      if (ref?.input) ref.input.disabled = Boolean(disabled);
    },

    /**
     * True while the user is interacting with a control — dragging its slider
     * or typing in its numeric editor. Per-frame syncs check this so live
     * updates never fight the hand that is moving it.
     */
    isControlActive(id) {
      const ref = controlRefs.get(id);
      if (!ref) return false;
      const active = document.activeElement;
      if (!active) return false;
      return active === ref.input || ref.valueEl?.contains(active) === true;
    },

    onSubmit(fn) {
      submitHandler = fn;
    },

    /** Collapse state for the two panels. Presentation only. */
    hudCollapsed: {
      get value() {
        return hudToggle.collapsed;
      },
      set: (next) => hudToggle.set(next),
      toggle: () => hudToggle.toggle(),
    },

    sidebarCollapsed: {
      get value() {
        return sidebarToggle.collapsed;
      },
      set: (next) => sidebarToggle.set(next),
      toggle: () => sidebarToggle.toggle(),
    },

    addMessage,
    addMessageWithFrame,

    /** The speaker label evaluator feedback is posted under. */
    EVALUATOR_SPEAKER,

    /**
     * Appends one benchmark-evaluator message.
     *
     * A thin wrapper over addMessage, so evaluator feedback has one entry
     * point and one consistent label. It FORMATS NOTHING and COMPUTES
     * NOTHING: whatever the caller has actually measured is what appears. If
     * no evaluator result exists, this is simply not called — there is no
     * placeholder message and no invented verdict.
     *
     * @param {string} text  the already-composed evaluator summary
     */
    addEvaluatorMessage(text) {
      addMessage(EVALUATOR_SPEAKER, text);
    },

    showCaptureGallery,

    focusInput() {
      showTab("chat");
      inputEl.focus();
    },

    dispose() {
      root.remove();
      sidebar.remove();
      document
        .querySelector(".capture-gallery-overlay")
        ?.remove();
    },
  };
}
