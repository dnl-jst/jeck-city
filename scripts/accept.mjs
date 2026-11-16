// Usage: npm run accept
// Builds, serves dist with `vite preview` on :4173, and measures time-to-__nnReady (unthrottled and Fast 4G),
// bytes transferred until ready (offline: ?offline=1&debug=1 is added to every URL, the production build has no
// server here and allows offline only with ?debug=1; the debug overlay is DOM only, draw calls/triangles are unaffected), and draw calls / triangles at the spawn by day and night. Prints a table.
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const PORT = 4173;
const base = `http://localhost:${PORT}/`;
execSync('npm run build', { stdio: 'inherit' });
// spawn vite's own bin (not npx) so kill() frees the port
const preview = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { cwd: 'apps/client', stdio: 'ignore' });
const rows = [];
let failed = false;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(base).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch({ args: browserArgs });
  const run = async (name, query, throttle) => {
    const page = await (await browser.newContext()).newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (throttle) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 170, downloadThroughput: 9e6 / 8, uploadThroughput: 9e6 / 8 });
    let bytes = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
    const t0 = Date.now();
    await page.goto(`${base}${query}&offline=1&debug=1`);
    await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
    const ms = Date.now() - t0;
    const ready = await page.evaluate(() => window.__nnReady);
    await page.waitForTimeout(1500); // a few frames so renderer.info is populated
    const info = await page.evaluate(() => window.__nnInfo());
    rows.push({ case: name, ready, 'time s': (ms / 1000).toFixed(1), 'MB': (bytes / 1e6).toFixed(2), calls: info.calls, triangles: info.triangles });
    await page.context().close();
  };
  await run('day, unthrottled', '?time=12:00', false);
  await run('day, Fast 4G', '?time=12:00', true);
  await run('night, unthrottled', '?time=23:00', false);
  await browser.close();
  console.table(rows);
  for (const r of rows) if (r.ready !== true) { console.error(`FAIL: ${r.case} did not become ready (${r.ready})`); failed = true; }
  console.log('Load times are reported only (no target for now). fps from headless SwiftShader is not meaningful; measure on a real machine with ?debug=1.');
} finally {
  preview.kill();
}
if (failed) process.exit(1);
