// Usage (vite on :5000): node scripts/check_agent_nav.mjs [url]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const url = process.argv[2] ?? 'http://localhost:5000';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__seekr?.player && window.__seekr.scene && window.__seekr.agent, null, { timeout: 120000 });
await page.waitForTimeout(3000); // splat + navmesh settle

try {
  // 5 random goto's; sample position every animation frame while walking.
  for (let n = 0; n < 5; n++) {
    const r = await page.evaluate(async () => {
      const a = window.__seekr.agent;
      const t = a.debug.randomPoint();
      let off = 0, samples = 0;
      const tick = () => {
        const p = (samples++, window.__seekr.player.getAgentPose().position);
        if (!a.debug.onNavmesh(p.x, p.z)) off++;
        id = requestAnimationFrame(tick);
      };
      let id = requestAnimationFrame(tick);
      const res = await a.goto({ x: t.x, z: t.z, stopWithin: 0.3 });
      cancelAnimationFrame(id);
      const p = window.__seekr.player.getAgentPose().position;
      return { t, res, off, samples, dist: Math.hypot(p.x - t.x, p.z - t.z), inputEnabled: window.__seekr.player.inputEnabled };
    });
    console.log(`goto ${n}: ${r.res.status} len=${r.res.pathLength}m samples=${r.samples} off=${r.off} dist=${r.dist.toFixed(2)}`);
    assert.equal(r.off, 0, 'left the NavMesh');
    assert.equal(r.res.status, 'arrived');
    assert.ok(r.dist <= 0.4);
    assert.ok(r.inputEnabled, 'input not restored');
  }

  const un = await page.evaluate(() => window.__seekr.agent.goto({ x: 500, z: 500 }));
  console.log('off-mesh goto:', un.status);
  assert.equal(un.status, 'unreachable');

  const { frames } = await page.evaluate(() => window.__seekr.agent.capture({ headings: 4 }));
  const hs = frames.map((f) => f.pose.headingDeg);
  console.log('capture headings:', hs, 'rangeM:', frames.map((f) => f.rangeM), 'obsIds:', frames.map((f) => f.obsId));
  assert.equal(frames.length, 4);
  for (let i = 1; i < 4; i++) {
    const d = (hs[i] - hs[i - 1] + 360) % 360;
    assert.ok(Math.abs(d - 90) < 5, `frames ${i - 1}->${i} are ${d} deg apart`);
  }
  assert.ok(frames.every((f) => f.jpegDataUrl.startsWith('data:image/') && f.camera.fovDeg > 0));

  const fr = await page.evaluate(() => window.__seekr.agent.frontiers());
  console.log('frontiers:', JSON.stringify(fr).slice(0, 300));
  assert.ok(Array.isArray(fr.frontiers) && fr.frontiers.length <= 8 && fr.coverage > 0 && fr.coverage <= 1);

  const rs = await page.evaluate(() => window.__seekr.agent.reset({ x: 0, z: 0, headingDeg: 0 }));
  console.log('reset ->', rs.pose);
  console.log('PASS');
} finally {
  await browser.close();
}
