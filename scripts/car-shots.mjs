// Usage: npm run car-shots -- <baseUrl> <outDir> [--frame-only] [--type=<index into CAR_TYPES, default 0>]
// In-game stills of one parked car type and a frame-time measurement, in headless Chromium on the host GPU
// (NN_SOFTWARE_GL=1: SwiftShader). Runs offline with ?debug=1 (free-fly camera through the dev hook __nnFlyTo).
// Picks the brightly painted parked car of that type with the most parked cars within 40 m and writes into outDir:
//   near-day, side-day, rear-day, row-day, lod-near, lod-far (the same car just inside and well outside the distance at which the
//   simple model takes over), near-night, row-night, rain (.png each)
// then, at the row-day camera, measures 5 s of frames with vsync off and prints `FRAME_MS avg=… p95=… calls=… triangles=…`.
// --frame-only: only the measurement.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const args = process.argv.slice(2);
const [base, outDir] = args.filter((a) => !a.startsWith('--'));
const frameOnly = args.includes('--frame-only');
const type = Number(args.find((a) => a.startsWith('--type='))?.slice(7) ?? 0);
if (!base || (!outDir && !frameOnly)) {
  console.error('usage: npm run car-shots -- <baseUrl> <outDir> [--frame-only] [--type=<n>]');
  process.exit(2);
}

const { parked } = await fetch(new URL('/world/manifest.json', base)).then((r) => r.json());
const near = (c) => parked.filter((o) => Math.hypot(o.x - c.x, o.z - c.z) < 40).length;
/** Bright paint shows the body's shape; black cars hide it. */
const bright = (c) => Math.max(c.color >> 16, (c.color >> 8) & 255, c.color & 255) > 150;
const car = parked.filter((c) => c.type === type && bright(c)).map((c) => ({ ...c, n: near(c) })).sort((a, b) => b.n - a.n)[0];
if (!car) throw new Error(`no parked car of type ${type}`);
console.log(`car at (${car.x.toFixed(1)}, ${car.z.toFixed(1)}), ${car.n} parked cars within 40 m`);
const fwd = { x: Math.sin(car.heading), z: Math.cos(car.heading) }, left = { x: Math.cos(car.heading), z: -Math.sin(car.heading) };
/** A camera `f` m ahead of and `l` m to the left of the car, `up` m above the ground there, looking at the car. */
const view = (f, l, up, pitch) => {
  const x = car.x + fwd.x * f + left.x * l, z = car.z + fwd.z * f + left.z * l;
  return { x, z, up, yaw: Math.atan2(car.x - x, car.z - z) * 180 / Math.PI, pitch };
};
const VIEWS = {
  near: view(3.4, 2.8, 1.45, -10), side: view(0.2, 3.4, 1.35, -7), row: view(-10, 2.6, 1.7, -6),
  rear: view(-3.6, 2.4, 1.4, -9),
  // along the street, like row: just inside and well outside the distance at which the simple model takes over
  'lod-near': view(-38, 2.6, 1.7, -2), 'lod-far': view(-72, 2.6, 1.7, -1),
};

const browser = await chromium.launch({ args: [...browserArgs, '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  const open = async (time, weather) => {
    const url = new URL(base);
    for (const [k, v] of Object.entries({ offline: '1', debug: '1', intro: '0', cam: `${(car.x - fwd.x * 14).toFixed(2)},2,${(car.z - fwd.z * 14).toFixed(2)}`, time, date: '2026-06-15', weather })) {
      if (v) url.searchParams.set(k, v);
    }
    await page.goto(url.href);
    await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
    if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  };
  const look = async (name) => {
    const v = VIEWS[name];
    await page.evaluate(({ x, z, up, yaw, pitch }) => {
      const y = (window.__nnSurfaceY(x, z) ?? 0) + up;
      window.__nnFlyTo(x, y, z, yaw, pitch);
    }, v);
    await page.waitForTimeout(2500); // chunks, the cars' level of detail, shadows
  };
  const shot = async (name, file = name) => {
    await look(name);
    await page.screenshot({ path: join(outDir, `${file}.png`) });
    console.log(`saved ${file}.png`);
  };
  await open('14:00', 'clear');
  if (!frameOnly) {
    await mkdir(outDir, { recursive: true });
    for (const n of ['near', 'side', 'rear', 'row']) await shot(n, `${n}-day`);
    await shot('lod-near');
    await shot('lod-far');
  }
  await look('row');
  const ms = await page.evaluate(() => new Promise((done) => {
    const t = [];
    let last = performance.now();
    const end = last + 5000;
    const tick = (now) => {
      t.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else done(t);
    };
    requestAnimationFrame(tick);
  }));
  ms.sort((a, b) => a - b);
  const info = await page.evaluate(() => window.__nnInfo());
  console.log(`FRAME_MS avg=${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2)} p95=${ms[Math.floor(ms.length * 0.95)].toFixed(2)} calls=${info.calls} triangles=${info.triangles}`);
  if (!frameOnly) {
    await open('23:00', 'clear');
    await shot('near', 'near-night');
    await shot('row', 'row-night');
    await open('14:00', 'rain');
    await shot('near', 'rain');
  }
} finally {
  await browser.close();
}
