// Usage: node scripts/drive-check.mjs [baseUrl] [shotsDir]
// Scripted drive in headless Chromium: spawn beside a parked car, press E, hold W (then W+D), and check that the
// car moved > 20 m, is not inside a building, and that getting out puts the player on foot again. Saves
// task11-car.png (day) and task11-night-car.png (night) into shotsDir when given.
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173/';
const shots = process.argv[3];
// parked car #2 (-1.34, -37.63, heading 1.76): stand 2.5 m to its left, facing along it
const CAM = '-1.8,0,-40.1,101,-8';

async function drive(page, time, shot) {
  await page.goto(`${base}?cam=${CAM}&time=${time}&date=2026-06-15`);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 120_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  const state = () => page.evaluate(() => window.__nnState());
  // software rendering runs at a few fps, so the simulation is slower than real time: wait on state, not on clocks
  const until = (fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 60_000 }).catch(() => { throw new Error(what); });
  await page.keyboard.press('KeyE');
  await until(() => window.__nnState().mode === 'drive', null, 'E did not enter the car');
  const s0 = await state();
  const away = (m) => until(([x, z, m]) => { const s = window.__nnState(); return Math.hypot(s.x - x, s.z - z) > m; }, [s0.x, s0.z, m], `car did not get ${m} m far`);
  await page.keyboard.down('KeyW');
  await away(12).catch(async (e) => { console.error(JSON.stringify(await state())); throw e; });
  if (shot) {
    await page.screenshot({ path: shot });
    const info = await page.evaluate(() => window.__nnInfo());
    console.log(`saved ${shot} (draw calls ${info.calls})`);
  }
  await away(30).catch((e) => console.error(e.message));
  await page.keyboard.up('KeyW');
  const s = await state();
  const moved = Math.hypot(s.x - s0.x, s.z - s0.z);
  const surface = await page.evaluate(([x, z]) => window.__nnSurfaceY(x, z), [s.x, s.z]);
  console.log(`${time}: drove ${moved.toFixed(1)} m to (${s.x.toFixed(1)}, ${s.z.toFixed(1)}), ${(s.speed * 3.6).toFixed(0)} km/h, surface below y=${surface?.toFixed(2)}`);
  if (moved <= 20) throw new Error('car moved less than 20 m');
  if (surface === null || surface > 1) throw new Error('car is inside a building (roof above it)');
  // stop, get out
  await page.keyboard.down('Space');
  await until(() => window.__nnState().speed < 0.5, null, 'car did not stop');
  await page.keyboard.up('Space');
  const stopped = await state();
  await page.keyboard.press('KeyE');
  await until(() => window.__nnState().mode === 'walk', null, 'E did not get out of the car');
  const out = await state();
  const gap = Math.hypot(out.x - stopped.x, out.z - stopped.z);
  console.log(`${time}: got out at (${out.x.toFixed(1)}, ${out.y.toFixed(2)}, ${out.z.toFixed(1)}), ${gap.toFixed(2)} m from the stopped car`);
  // left (or right) of the car: 1.5 m from its centre line; behind would be 3.0 m
  if (Math.abs(gap - 1.5) > 0.25) throw new Error(`exit spot ${gap.toFixed(2)} m from the car, expected about 1.5 m`);
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await drive(page, '14:00', shots && `${shots}/task11-car.png`);
  await drive(page, '22:30', shots && `${shots}/task11-night-car.png`);
  console.log('drive check OK');
} finally {
  await browser.close();
}
