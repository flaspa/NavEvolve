/**
 * perceptionClient.js — the Body's HTTP client for the new Seekr Brain.
 *
 * Two operations, plain fetch, no protocol layer:
 *
 *   health()                     GET  /health   → { status, model, device, … }
 *   perceive({ imageDataUrl,     POST /perceive → { model, description,
 *              sceneId, task })                     latency_ms }
 *
 * The image is the exact egocentric JPEG data URL produced by
 * frameCapture.captureEgoFrame — the frame shown in SEEKR VISION.
 */
export function createPerceptionClient({ brainUrl, timeoutMs = 60_000 }) {
  const base = brainUrl.replace(/\/+$/, "");

  async function health() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(`${base}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function perceive({ imageDataUrl, sceneId = null, task = null }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/perceive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_data_url: imageDataUrl, scene_id: sceneId, task }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body?.detail) detail = String(body.detail);
        } catch (_) {
          // Keep the HTTP status as the message.
        }
        throw new Error(detail);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One goal-directed step: ego frame + goal + Body report → Liquid
   * perception + ONE deterministic Brain action.
   */
  async function goalStep({ imageDataUrl, goal, sceneId = null, body = {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/goal/step`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_data_url: imageDataUrl, goal, scene_id: sceneId, body }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.detail) detail = String(payload.detail);
        } catch (_) {
          // Keep the HTTP status as the message.
        }
        throw new Error(detail);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Store one remembered ego view through the Brain into Memories.ai:
   * multipart with the short WebM clip (`video`) and Seekr context (`json`).
   * Returns { memory_id, operation, status }.
   */
  async function storeMemory({ clip, sceneId, sceneName, timestamp, pose, description, goal, clientId }) {
    const form = new FormData();
    form.append("video", clip, "seekr-memory.webm");
    form.append(
      "json",
      JSON.stringify({
        scene_id: sceneId ?? null,
        scene_name: sceneName ?? null,
        timestamp: timestamp ?? null,
        pose: pose ?? null,
        description: description ?? null,
        goal: goal ?? null,
        client_id: clientId ?? null,
      }),
    );
    // No Content-Type header: the browser sets the multipart boundary.
    const response = await fetch(`${base}/memories`, { method: "POST", body: form });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.detail) detail = String(payload.detail);
      } catch (_) {
        // Keep the HTTP status as the message.
      }
      throw new Error(detail);
    }
    return await response.json();
  }

  /** Memories.ai ingest operation status: { done, error, progress }. */
  async function memoryOperation(operationId) {
    const response = await fetch(`${base}/memories/operations/${encodeURIComponent(operationId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }

  /** Memories previously stored in Memories.ai (newest first). */
  async function listMemories(limit = 50) {
    const response = await fetch(`${base}/memories?limit=${limit}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).memories ?? [];
  }

  /** "Find X like this online": Liquid object description → Nimble results. */
  async function discover({ imageDataUrl, request, sceneId = null }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(`${base}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_data_url: imageDataUrl, request, scene_id: sceneId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.detail) detail = String(payload.detail);
        } catch (_) {
          // Keep the HTTP status as the message.
        }
        throw new Error(detail);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 1–3 local memory images → BFL FLUX.2 [pro] postcard { image_url }. */
  async function postcard({ images, descriptions = [], sceneName = null }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200_000);
    try {
      const response = await fetch(`${base}/postcard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, descriptions, scene_name: sceneName }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload?.detail) detail = String(payload.detail);
        } catch (_) {
          // Keep the HTTP status as the message.
        }
        throw new Error(detail);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    health,
    perceive,
    goalStep,
    storeMemory,
    memoryOperation,
    listMemories,
    discover,
    postcard,
    baseUrl: base,
  };
}
