// Usage: node scripts/ride-along-check.mjs [baseUrl] [shotsDir]
// Needs the dev stack running with a fresh server (npm run dev), like mp-check. Two headless Chromium contexts join as
// "Check A" and "Check B". Both are teleported to one parked car: B to its passenger door, A to its driver's door.
// B gets in first and must sit as a passenger (mode 'sit') while nobody drives; A gets in, becomes the driver and
// drives >= 25 m; B must have come along (>= 20 m, still 'sit') and see A driving. After stopping B gets out and
// walks again while A stays the driver. Saves b-riding.png (B's view while riding along) into shotsDir when given.
import { mkdir } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = args[0] ?? 'http://localhost:5173/';
const shots = args[1];
const WAIT = { timeout: 60_000, polling: 'raf' };

async function join(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error] ${e.message}`));
  const url = new URL(base);
  url.searchParams.set('time', '14:00');
  url.searchParams.set('date', '2026-06-15');
  await page.goto(url.href);
  const start = page.locator('.nn-intro-start');
  if (await start.count()) await start.click();
  await page.locator('.nn-intro-go').click();
  await page.locator('.nn-lobby-input').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error(`${name}: world failed to load`);
  await page.waitForFunction(() => window.__nnState().online, null, WAIT);
  return { page, name, state: () => page.evaluate(() => window.__nnState()) };
}
const teleport = (p, x, z) => p.page.evaluate(([x, z]) => window.__nnConn().sendTeleport(x, z), [x, z]);
const until = async (p, fn, arg, what) => {
  try { await p.page.waitForFunction(fn, arg, WAIT); } catch { throw new Error(`${p.name}: ${what} (${JSON.stringify(await p.state())})`); }
};

const browser = await chromium.launch({ args: browserArgs });
try {
  const a = await join(browser, 'Check A'), b = await join(browser, 'Check B');
  await until(a, () => window.__nnState().players === 2, null, 'does not see 2 players');
  if (!(await a.page.evaluate(() => typeof window.__nnConn === 'function'))) throw new Error('needs a dev-mode server (teleport)');
  const { parked, bikes, spawn } = await a.page.evaluate(() => fetch('/world/manifest.json').then((r) => r.json()));
  const clearAhead = (c) => parked.every((o) => {
    if (o === c) return true;
    const dx = o.x - c.x, dz = o.z - c.z;
    const along = dx * Math.sin(c.heading) + dz * Math.cos(c.heading), side = dx * Math.cos(c.heading) - dz * Math.sin(c.heading);
    return !(along > -3 && along < 45 && Math.abs(side) < 3);
  });
  const car = parked.filter((c) => bikes.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 8) && clearAhead(c))
    .map((c) => ({ ...c, d: Math.hypot(c.x - spawn.x, c.z - spawn.z) })).sort((p, q) => p.d - q.d)[0];
  if (!car) throw new Error('no parked car with a clear road ahead');
  const left = { x: Math.cos(car.heading), z: -Math.sin(car.heading) };
  const near = (s, [x, z, d]) => Math.hypot(s.x - x, s.z - z) < d;
  // B at the passenger door, A at the driver's door
  await teleport(b, car.x - left.x * 1.6, car.z - left.z * 1.6);
  await teleport(a, car.x + left.x * 1.6, car.z + left.z * 1.6);
  for (const p of [a, b]) await until(p, ([x, z]) => { const s = window.__nnState(); return Math.hypot(s.x - x, s.z - z) < 2.5; }, [car.x, car.z], 'was not teleported to the car');
  await b.page.waitForTimeout(800);

  await b.page.keyboard.press('KeyE');
  await until(b, () => window.__nnState().mode === 'sit', null, 'did not sit down as a passenger');
  console.log('B sits in the car as a passenger; nobody drives');
  await a.page.waitForTimeout(2500); // B's figure gets in
  if ((await a.state()).mode !== 'walk') throw new Error('A should still be on foot');

  await a.page.keyboard.press('KeyE');
  await until(a, () => window.__nnState().mode === 'drive', null, 'did not become the driver');
  await until(a, () => window.__nnState().engine === 'running', null, 'engine did not start');
  const a0 = await a.state(), b0 = await b.state();
  await a.page.keyboard.down('KeyW');
  await until(a, ([x, z]) => { const s = window.__nnState(); return Math.hypot(s.x - x, s.z - z) > 25; }, [a0.x, a0.z], 'did not drive 25 m');
  if (shots) {
    await mkdir(shots, { recursive: true });
    await b.page.screenshot({ path: joinPath(shots, 'b-riding.png') });
    await a.page.screenshot({ path: joinPath(shots, 'a-driving.png') });
  }
  await a.page.keyboard.up('KeyW');
  const b1 = await b.state();
  const rode = Math.hypot(b1.x - b0.x, b1.z - b0.z);
  if (b1.mode !== 'sit' || rode < 20) throw new Error(`B did not ride along: mode ${b1.mode}, moved ${rode.toFixed(1)} m`);
  const seen = (await b.page.evaluate(() => window.__nnRemote())).find((r) => r.name === 'Check A');
  console.log(`A drove 25 m; B rode along ${rode.toFixed(1)} m as a passenger and sees A in mode ${seen?.mode}`);
  if (seen?.mode !== 'drive') throw new Error('B does not see A driving');

  await a.page.keyboard.down('KeyS');
  await until(a, () => Math.abs(window.__nnState().speed) < 0.3, null, 'did not stop');
  await a.page.keyboard.up('KeyS');
  await b.page.waitForTimeout(500);
  await b.page.keyboard.press('KeyE');
  await until(b, () => window.__nnState().mode === 'walk', null, 'did not get out');
  if ((await a.state()).mode !== 'drive') throw new Error('A should still be the driver');
  console.log('B got out and walks; A is still the driver');
  console.log('ride-along-check: OK');
} finally {
  await browser.close();
}
