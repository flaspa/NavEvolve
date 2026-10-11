/**
 * postcardModal.js — "SEEKR MEMORY POSTCARD": the Black Forest Labs FLUX.2
 * [pro] image generated from selected local memories, an optional Nimble
 * Discover link, and a demo-only Send button. Display only.
 */
export function createPostcardModal() {
  let overlayEl = null;

  function ensure() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.className = "memory-lightbox hidden";
    overlayEl.innerHTML = `
      <div class="memory-lightbox-card postcard-card" role="dialog" aria-label="Seekr memory postcard">
        <button type="button" class="memory-lightbox-close" data-role="close" title="Close">×</button>
        <div class="postcard-heading">SEEKR MEMORY POSTCARD <span class="perception-model">Black Forest Labs · FLUX.2 [pro]</span></div>
        <img data-role="image" alt="Generated memory postcard" />
        <div class="memory-lightbox-meta">
          <div class="memory-lightbox-desc" data-role="caption"></div>
          <div class="postcard-discover hidden" data-role="discover">
            <div class="perception-header">Object discovered:</div>
            <div class="discover-title" data-role="discover-title"></div>
            <a class="discover-open" data-role="discover-link" target="_blank" rel="noopener noreferrer">View with Nimble ↗</a>
          </div>
          <div class="postcard-actions">
            <button type="button" class="postcard-send" disabled title="Sharing coming soon">Send Postcard</button>
            <span class="memory-time">Sharing coming soon</span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlayEl);
    overlayEl.addEventListener("click", (e) => {
      if (e.target === overlayEl || e.target.dataset.role === "close") close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlayEl.classList.contains("hidden")) close();
    });
    return overlayEl;
  }

  function close() {
    overlayEl?.classList.add("hidden");
  }

  return {
    /**
     * @param {{imageUrl: string, caption?: string|null,
     *          discover?: {title: string, url: string}|null}} postcard
     */
    show({ imageUrl, caption = null, discover = null }) {
      const el = ensure();
      el.querySelector('[data-role="image"]').src = imageUrl;
      const cap = el.querySelector('[data-role="caption"]');
      cap.textContent = caption ?? "";
      cap.style.display = caption ? "" : "none";
      const disc = el.querySelector('[data-role="discover"]');
      if (discover?.url) {
        el.querySelector('[data-role="discover-title"]').textContent = discover.title ?? discover.url;
        el.querySelector('[data-role="discover-link"]').href = discover.url;
        disc.classList.remove("hidden");
      } else {
        disc.classList.add("hidden");
      }
      el.classList.remove("hidden");
    },
    close,
  };
}
