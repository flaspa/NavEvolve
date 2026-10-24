import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: false });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto("http://localhost:5000");
await p.waitForFunction(() => window.__seekr?.agentPanel, null, { timeout: 60000 });
await p.evaluate(() => {
  const a = window.__seekr.agentPanel;
  a.thought({ phase: "recall", text: "I remember a bookshelf near the window" });
  a.thought({ phase: "navigate", text: "Walking to (1.0, 2.0)" });
  a.memory({ objects: [
    { name: "bookshelf", position: [1, 0, 2], confidence: 0.82 },
    { name: "sofa", position: [-2, 0, 1], confidence: 0.6 } ] });
  a.path([[0, 0], [0.5, 1], [1, 2]]);
});
await p.waitForTimeout(1500);
await p.screenshot({ path: new URL("./agent_panel.png", import.meta.url).pathname });
await b.close();
