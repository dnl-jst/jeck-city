// Usage: node scripts/fly-teleport-check.mjs [baseUrl]
// Dev check of the free-fly camera in headless Chromium (?offline=1&debug=1; a dev server must be running): F starts
// the flight, the camera is put 400 m away, T must put the player on the ground below it and end the flight.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const args = process.env.NN_ANGLE ? [`--use-angle=${process.env.NN_ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist'] : browserArgs;
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
try {
  const url = new URL(base);
  url.searchParams.set('offline', '1');
  url.searchParams.set('debug', '1');
  await page.goto(url.href);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 300_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  const state = () => page.evaluate(() => window.__nnState());
  const before = await state();
  const target = { x: before.x + 300, z: before.z + 260 };
  await page.evaluate(([x, y, z]) => window.__nnFlyTo(x, y, z, 0, -30), [target.x, before.y + 80, target.z]);
  await page.waitForTimeout(500);
  if (!(await state()).flying) throw new Error('not flying after __nnFlyTo');
  await page.keyboard.press('KeyT');
  await page.waitForFunction(() => !window.__nnState().flying, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const after = await state();
  const off = Math.hypot(after.x - target.x, after.z - target.z);
  console.log(`teleport: player ${off.toFixed(1)} m from the camera's spot, y ${after.y.toFixed(1)}, mode ${after.mode}, flying ${after.flying}`);
  if (off > 5) throw new Error('the player did not arrive below the camera');

  console.log('fly-teleport check passed');
} finally {
  await browser.close();
}
