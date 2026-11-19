// Usage: node scripts/board-shots.mjs <baseUrl> <outDir> [--type=<index into CAR_TYPES, default 0>] [--time=HH:MM]
// Stills (from a free camera at the car's front left; ?debug=1) of getting into a car from its passenger side: the
// figure takes the seat behind the door it stands at. As a passenger it just sits and gets out again; when the
// script is started with --driver it stands at the driver's door, drives a bit with the figure at the wheel, and gets out. Offline, headless Chromium on the host GPU (NN_SOFTWARE_GL=1: SwiftShader).
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const args = process.argv.slice(2);
const [base, outDir] = args.filter((a) => !a.startsWith('--'));
const type = Number(args.find((a) => a.startsWith('--type='))?.slice(7) ?? 0);
const time = args.find((a) => a.startsWith('--time='))?.slice(7) ?? '14:00';
if (!base || !outDir) {
  console.error('usage: node scripts/board-shots.mjs <baseUrl> <outDir> [--type=<n>] [--time=HH:MM]');
  process.exit(2);
}
const { parked, bikes } = await fetch(new URL('/world/manifest.json', base)).then((r) => r.json());
const bright = (c) => Math.max(c.color >> 16, (c.color >> 8) & 255, c.color & 255) > 150;
// room on both sides and ahead: no other parked car within 6 m, no bike within 8 m
const free = (c) => parked.every((o) => o === c || Math.hypot(o.x - c.x, o.z - c.z) > 6) && bikes.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 8);
const car = parked.find((c) => c.type === type && bright(c) && free(c)) ?? parked.find((c) => c.type === type && free(c));
if (!car) throw new Error(`no free-standing parked car of type ${type}`);
const left = { x: Math.cos(car.heading), z: -Math.sin(car.heading) };
const side = args.includes('--driver') ? 1 : -1; // which side the figure starts on: the driver's, or the passenger's
const start = { x: car.x + side * left.x * 2.2, z: car.z + side * left.z * 2.2 };

const browser = await chromium.launch({ args: browserArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  const url = new URL(base);
  for (const [k, v] of Object.entries({ offline: '1', debug: '1', intro: '0', cam: `${start.x.toFixed(2)},2,${start.z.toFixed(2)},${(car.heading * 180 / Math.PI).toFixed(0)},-12`, time, date: '2026-06-15', weather: 'clear' })) url.searchParams.set(k, v);
  await page.goto(url.href);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  await mkdir(outDir, { recursive: true });
  await page.waitForTimeout(1500);
  const shot = async (name) => { await page.screenshot({ path: join(outDir, `${name}.png`) }); console.log(`saved ${name}.png`); };
  await shot('0-before');
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(60);
  // a free camera ahead of the car on the driver's side, looking back at the door
  const fwd = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
  const view = async (f, l, up, pitch) => {
    const x = car.x + fwd.x * f + left.x * l, z = car.z + fwd.z * f + left.z * l;
    await page.evaluate(({ x, z, up, yaw, pitch }) => window.__nnFlyTo(x, (window.__nnSurfaceY(x, z) ?? 0) + up, z, yaw, pitch), { x, z, up, yaw: Math.atan2(car.x - x, car.z - z) * 180 / Math.PI, pitch });
  };
  await view(2.6, 3.0, 1.5, -10);
  for (const [name, wait] of [['1-walk', 500], ['2-walk', 900], ...Array.from({ length: 16 }, (_, i) => [`4-in-${String(i).padStart(2, '0')}`, 90]), ['6-seated', 1500]]) {
    await page.waitForTimeout(wait);
    await shot(name);
  }
  console.log(JSON.stringify(await page.evaluate(() => { const s = window.__nnState(); return { mode: s.mode, engine: s.engine }; })));
  const riding = (await page.evaluate(() => window.__nnState().mode)) === 'sit'; // got a passenger seat: nothing to drive
  if (!riding) {
    await page.waitForFunction(() => window.__nnState().engine === 'running', null, { timeout: 20_000 });
    await view(3.2, 0.9, 1.25, -6); // through the windscreen
    await page.waitForTimeout(300);
    await shot('6b-front');
    await page.keyboard.press('KeyF'); // back to the follow camera, to drive
    await page.waitForTimeout(200);
    await page.keyboard.down('KeyW');
    await page.keyboard.down('KeyA');
    await page.waitForTimeout(1300);
    await shot('7-steering');
    await page.keyboard.up('KeyA');
    await page.keyboard.up('KeyW');
    await page.keyboard.down('KeyS');
    await page.waitForFunction(() => Math.abs(window.__nnState().speed) < 0.3, null, { timeout: 20_000 });
    await page.keyboard.up('KeyS');
  } else {
    await view(3.2, -0.9, 1.25, -6); // through the windscreen, from the passenger's side
    await page.waitForTimeout(300);
    await shot('6b-front');
    await page.keyboard.press('KeyF'); // back to the follow camera: keys act again
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(60);
  {
    const s = await page.evaluate(() => window.__nnState());
    await page.evaluate(({ x, z }) => window.__nnFlyTo(x + 3, (window.__nnSurfaceY(x + 3, z + 3) ?? 0) + 1.6, z + 3, 225, -10), s);
  }
  for (const [name, wait] of [['8a-out', 400], ['8b-out', 250], ['8c-out', 250], ['9-out', 300], ['10-out', 700]]) {
    await page.waitForTimeout(wait);
    await shot(name);
  }
  console.log(JSON.stringify(await page.evaluate(() => { const s = window.__nnState(); return { mode: s.mode }; })));
} finally {
  await browser.close();
}
