// Usage: npm run accept
// Builds, serves dist with `vite preview` on :4173, and measures time-to-__nnReady (unthrottled and Fast 4G),
// bytes transferred until ready, and draw calls / triangles at the spawn by day and night. Prints a table.
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4173;
const base = `http://localhost:${PORT}/`;
execSync('npm run build', { stdio: 'inherit' });
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: 'apps/client', stdio: 'ignore' });
const rows = [];
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(base).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const run = async (name, query, throttle) => {
    const page = await (await browser.newContext()).newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (throttle) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 170, downloadThroughput: 9e6 / 8, uploadThroughput: 9e6 / 8 });
    let bytes = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
    const t0 = Date.now();
    await page.goto(`${base}${query}`);
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
  console.log('Goal: ready < 10 s on Fast 4G. fps from headless SwiftShader is not meaningful; measure on a real machine with ?debug=1.');
} finally {
  preview.kill();
}
