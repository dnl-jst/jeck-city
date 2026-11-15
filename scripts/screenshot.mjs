// Usage: npm run screenshot -- <url> <out.png>
// Renders the page in headless Chromium (host GPU; NN_SOFTWARE_GL=1: software WebGL), waits for window.__nnReady (fails on 'error'), saves a PNG.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: npm run screenshot -- <url> <out.png>');
  process.exit(2);
}
const browser = await chromium.launch({ args: browserArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 120_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load (window.__nnReady = "error")');
  // let a few frames render after the last chunk arrived
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => window.__nnInfo?.());
  console.log(`saved ${out}${info ? ` (draw calls ${info.calls}, triangles ${info.triangles})` : ''}`);
} finally {
  await browser.close();
}
