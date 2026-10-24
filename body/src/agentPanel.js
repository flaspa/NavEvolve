/** agentPanel.js — agent thoughts into the Talk tab, minimap markers. Goals come from talk.js. */
export function createAgentPanel({ ui, minimap }) {
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
