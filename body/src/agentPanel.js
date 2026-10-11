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
  const go = () => input.value.trim() && send({ event: "goal", text: input.value.trim(), sceneId: window.__seekr?.scene?.id });
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
      // The Cognitive Map panel belongs to the place graph (cognitiveMap.js); objects go on the minimap.
      minimap.setMarkers(objects.map((o) => ({ x: o.position[0], z: o.position[2], label: o.name })));
    },
    path(points) {
      minimap.setPath(points);
    },
  };
}
