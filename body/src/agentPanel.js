/** agentPanel.js — goal box, thought stream, Cognitive Map list, minimap markers. */
export function createAgentPanel({ ui, minimap }) {
  const box = document.createElement("div");
  box.className = "agent-box";
  box.innerHTML = `<div class="agent-row">
      <input type="text" placeholder="Find… e.g. bookshelf">
      <button type="button" data-go>Go</button><button type="button" data-stop>Stop</button></div>
    <div class="agent-thought">Agent idle</div>`;
  const input = box.querySelector("input");
  const status = box.querySelector(".agent-thought");
  ui.minimapMount.after(box);

  const send = (msg) => {
    const fn = window.__seekr?.sendAgentEvent;
    if (!fn) return (status.textContent = "agent link not connected");
    window.__seekr.agent?.halt(); // the brain's old task is cancelled, but a walk it started would keep going
    fn(msg);
  };
  const go = () => input.value.trim() && send({ event: "goal", text: input.value.trim() });
  box.querySelector("[data-go]").onclick = go;
  box.querySelector("[data-stop]").onclick = () => send({ event: "stop" });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // keep WASD/hotkeys out of the box
    if (e.key === "Enter") go();
  });

  const frames = new Map(); // frameId -> jpegDataUrl (small LRU)
  return {
    frame(f) {
      frames.set(f.frameId, f.jpegDataUrl);
      if (frames.size > 30) frames.delete(frames.keys().next().value);
    },
    thought({ phase, text, frameId }) {
      const line = `[${phase}] ${text}`;
      const img = frames.get(frameId);
      if (img) ui.addMessageWithFrame("Agent", line, { imageDataUrl: img, altText: frameId });
      else ui.addMessage("Agent", line);
      status.textContent = line;
    },
    memory({ objects }) {
      const body = ui.cognitiveMapPanel;
      body.classList.toggle("has-objs", objects.length > 0);
      body.replaceChildren(
        ...objects.map((o) => {
          const row = document.createElement("div");
          row.className = "agent-obj";
          const [x, , z] = o.position;
          row.innerHTML = `<span></span><span>${Math.round((o.confidence ?? 0) * 100)}% (${x.toFixed(1)}, ${z.toFixed(1)})</span>`;
          row.firstChild.textContent = o.name;
          return row;
        }),
      );
      if (!objects.length) body.textContent = "Awaiting observations";
      minimap.setMarkers(objects.map((o) => ({ x: o.position[0], z: o.position[2], label: o.name })));
    },
    path(points) {
      minimap.setPath(points);
    },
  };
}
