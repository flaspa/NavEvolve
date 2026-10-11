/**
 * egoClip.js — the smallest valid VIDEO memory from Seekr's egocentric frame.
 *
 * Memories.ai's Video Datalake ingests video (mp4/mov/webm…), not still
 * images. For "Remember this view" the SAME ego JPEG shown in SEEKR VISION is
 * drawn onto an offscreen canvas and recorded for ~1.5 s with browser-native
 * canvas.captureStream + MediaRecorder into a WebM blob. No third-person
 * viewport, no UI panels, no dependencies.
 *
 * @param {string} dataUrl        the ego frame (JPEG data URL)
 * @param {object} [options]
 * @param {number} [options.durationMs=1500]
 * @param {number} [options.fps=10]
 * @returns {Promise<Blob>} a video/webm blob
 */
export function encodeEgoClip(dataUrl, { durationMs = 1500, fps = 10 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
      reject(new Error("This browser cannot record a canvas (MediaRecorder/captureStream missing)."));
      return;
    }

    const img = new Image();
    img.onerror = () => reject(new Error("Could not decode the ego frame for the clip."));
    img.onload = () => {
      // Even dimensions keep every encoder happy.
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth - (img.naturalWidth % 2);
      canvas.height = img.naturalHeight - (img.naturalHeight % 2);
      const ctx = canvas.getContext("2d");
      const draw = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      draw();

      const stream = canvas.captureStream(fps);
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      if (!mimeType) {
        reject(new Error("No supported WebM recorder in this browser."));
        return;
      }

      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = (e) => reject(e.error ?? new Error("MediaRecorder failed."));
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        clearInterval(redraw);
        const blob = new Blob(chunks, { type: "video/webm" });
        if (blob.size === 0) reject(new Error("Recorded clip is empty."));
        else resolve(blob);
      };

      // Keep the canvas "changing" so captureStream emits frames.
      const redraw = setInterval(draw, Math.round(1000 / fps));
      recorder.start(200);
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, durationMs);
    };
    img.src = dataUrl;
  });
}
