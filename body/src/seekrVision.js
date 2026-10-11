/**
 * seekrVision.js — the SEEKR VISION panel: the latest egocentric frame
 * captured from Seekr's actual eye camera (frameCapture.captureEgoFrame),
 * plus the perception the Brain returns for it.
 *
 * Perception is provided by Liquid AI's LFM2.5-VL-3B (LiquidAI/LFM2.5-VL-3B)
 * running in the Seekr Brain. This panel only displays: it renders nothing
 * itself, owns no camera and calls no model — main.js does both and hands the
 * results here.
 */
export const PERCEPTION_MODEL_LABEL = "Liquid AI · LFM2.5-VL-3B";

export function createSeekrVision({ mount, onAnalyze = null }) {
  const root = document.createElement("div");
  root.id = "seekr-vision";
  root.innerHTML = `
    <div class="minimap-label">SEEKR VISION</div>
    <div class="vision-model" title="Perception model: LiquidAI/LFM2.5-VL-3B via Hugging Face Transformers">${PERCEPTION_MODEL_LABEL}</div>
    <img data-role="frame" alt="Seekr's latest egocentric view" />
    <div class="vision-empty" data-role="empty">No ego frame captured yet</div>
    <div class="vision-footer">
      <div class="vision-status-row">
        <div class="vision-status" data-role="status">Brain: connecting…</div>
        <div class="vision-latency" data-role="latency"></div>
      </div>
      <button type="button" class="vision-analyze" data-role="analyze"
              title="Capture Seekr's current ego frame and send it to Liquid AI for perception">Analyze Vision</button>
    </div>`;
  mount.appendChild(root);

  const imgEl = root.querySelector('[data-role="frame"]');
  const emptyEl = root.querySelector('[data-role="empty"]');
  const statusEl = root.querySelector('[data-role="status"]');
  const latencyEl = root.querySelector('[data-role="latency"]');
  const analyzeBtn = root.querySelector('[data-role="analyze"]');

  analyzeBtn.addEventListener("click", () => onAnalyze?.());

  let latest = null;

  return {
    /**
     * @param {string} dataUrl  JPEG data URL from captureEgoFrame
     * @param {{sceneName?: string, timestamp?: number}} [meta]
     */
    show(dataUrl, meta = {}) {
      if (!dataUrl) return;
      latest = { dataUrl, ...meta };
      imgEl.src = dataUrl;
      imgEl.style.display = "block";
      emptyEl.style.display = "none";
      // Scene name and time are shown in the Perception and Memories tabs;
      // this compact panel deliberately does not repeat them.
    },

    /** One-line status under the frame: Brain state or "Analyzing…". */
    setStatus(text, { busy = false } = {}) {
      statusEl.textContent = text;
      statusEl.classList.toggle("busy", busy);
    },

    setAnalyzeEnabled(enabled) {
      analyzeBtn.disabled = !enabled;
    },

    /**
     * Perception finished. The text itself is shown in the Perception tab;
     * this panel only returns to Ready (with the latency when known).
     */
    perceptionDone({ latencyMs = null, error = false } = {}) {
      statusEl.classList.remove("busy");
      statusEl.classList.toggle("error", Boolean(error));
      statusEl.textContent = error ? "Ready · last analysis failed" : "Ready";
      if (!error && Number.isFinite(latencyMs)) {
        latencyEl.textContent =
          latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)} s` : `${Math.round(latencyMs)} ms`;
      }
    },

    latest: () => latest,
  };
}
