// WebSocket link to the brain (CONTRACTS.md §1). Brain sends cmds; we dispatch to window.__seekr.agent.
import { APP_CONFIG } from "./config/appConfig.js";

let ws = null;
let pending = [];  // events sent while (re)connecting

export function sendEvent(evt) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(evt));
  else { pending.push(evt); connect(); }  // e.g. Go pressed in a tab the brain had replaced
}

async function handle(msg) {
  const seekr = window.__seekr;
  try {
    let result = {};
    if (msg.cmd === "thought" || msg.cmd === "memory") {
      const panel = seekr?.agentPanel;
      if (panel) panel[msg.cmd](msg);
      else console.log(`[agent] ${msg.cmd}`, msg);
    } else {
      const fn = seekr?.agent?.[msg.cmd];
      if (!fn) throw new Error("agent controller missing");
      result = (await fn.call(seekr.agent, msg)) ?? {};
    }
    return { id: msg.id, ok: true, result };
  } catch (err) {
    return { id: msg.id, ok: false, error: String(err?.message ?? err) };
  }
}

const REPLACED = 4000;  // brain closed us because another tab connected
let url = null;

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;  // already connecting / open
  const sock = (ws = new WebSocket(url));
  sock.onopen = () => {
    sock.send(JSON.stringify({ event: "hello", sceneId: window.__seekr?.scene?.id ?? APP_CONFIG.defaultSceneId }));
    for (const evt of pending.splice(0)) sock.send(JSON.stringify(evt));
  };
  sock.onmessage = async (e) => {
    const reply = await handle(JSON.parse(e.data));
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));  // reply on the socket that asked
  };
  // Replaced by another tab: stay quiet until this tab is looked at again (no reconnect ping-pong).
  // Hidden tabs wait for visibilitychange, so after a brain restart a background tab can't grab the body.
  sock.onclose = (e) => { if (e.code !== REPLACED) setTimeout(() => document.hidden || connect(), 2000); };
}

export function startAgentLink() {
  url = APP_CONFIG.brainUrl.replace(/^http/, "ws") + "/agent/ws";
  connect();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) connect(); });
  window.__seekr.sendAgentEvent = sendEvent;
}
