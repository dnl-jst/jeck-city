// Usage: node scripts/ride-check.mjs [baseUrl] [shotsDir]
// Scripted bike ride in headless Chromium (host GPU; NN_SOFTWARE_GL=1: SwiftShader): spawn, turn towards the Long John
// that always stands next to the spawn (bikes[0], type 3), press E and check that a Long John is ridden, pedal 6 s
// (> 25 m, not inside a building), steer right (heading changes), slow down and get off (on foot again, beside the
// bike). Day and night run; saves ride-day.png / ride-night.png into shotsDir when given.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const shots = process.argv[3];
const HANG_MS = 15 * 60_000;
const STALL_MS = 10_000;
const STEPS = { mount: 300, away: 900, turn: 300, stop: 900, off: 300 };

async function ride(page, time, shot) {
  await page.goto(`${base}?time=${time}&date=2026-06-15`);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 120_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  const state = () => page.evaluate(() => window.__nnState());
  /** Wait until pred(state, arg) holds, within `budget` physics steps (see drive-check.mjs). */
  const until = async (pred, arg, budget, what) => {
    const limit = (await state()).steps + budget;
    await page.waitForFunction(([src, arg, limit, stallMs]) => {
      const s = window.__nnState();
      const now = performance.now();
      const w = window.__rcSteps;
      if (!w || w.limit !== limit || w.steps !== s.steps) window.__rcSteps = { limit, steps: s.steps, since: now, stalled: false };
      else if (now - w.since > stallMs) return (w.stalled = true);
      return s.steps > limit || (0, eval)(`(${src})`)(s, arg);
    }, [pred.toString(), arg, limit, STALL_MS], { timeout: HANG_MS, polling: 'raf' });
    if (await page.evaluate(() => window.__rcSteps?.stalled)) throw new Error(`physics steps did not advance (${what})`);
    const s = await state();
    if (!(await page.evaluate(([src, arg]) => (0, eval)(`(${src})`)(window.__nnState(), arg), [pred.toString(), arg]))) {
      console.error(JSON.stringify(s));
      throw new Error(`${what} (within ${budget} physics steps)`);
    }
    return s;
  };

  const { spawn, bikes } = await page.evaluate(() => fetch('/world/manifest.json').then((r) => r.json()));
  const lj = bikes[0];
  const d = Math.hypot(lj.x - spawn.x, lj.z - spawn.z);
  console.log(`${time}: spawn Long John (${lj.x}, ${lj.z}), type ${lj.type}, ${d.toFixed(2)} m from the spawn`);
  if (lj.type !== 3 || d > 3) throw new Error('no Long John within 3 m of the spawn');
  // turn towards the bike: a short step in its direction (the figure faces where it walks; camera yaw = spawn heading)
  const ahead = (lj.x - spawn.x) * Math.sin(spawn.heading) + (lj.z - spawn.z) * Math.cos(spawn.heading);
  const key = ahead >= 0 ? 'KeyW' : 'KeyS';
  await page.keyboard.down(key);
  const s0 = await state();
  await until((s, n) => s.steps > n + 8, s0.steps, 60, 'no steps while turning');
  await page.keyboard.up(key);
  await page.keyboard.press('KeyE');
  const on = await until((s) => s.mode === 'ride', null, STEPS.mount, 'E did not get on the bike');
  if (on.bikeType !== 'longjohn') throw new Error(`got on a ${on.bikeType}, expected the Long John`);

  await page.keyboard.down('KeyW');
  await until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) > 25, [on.x, on.z], STEPS.away, 'bike did not get 25 m far');
  if (shot) {
    await page.screenshot({ path: shot });
    console.log(`saved ${shot}`);
  }
  const before = await page.evaluate(() => window.__nnState());
  await page.keyboard.down('KeyD');
  const turned = await until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) > 6, [before.x, before.z], STEPS.turn, 'bike did not keep moving while steering');
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyW');
  const surface = await page.evaluate(([x, z]) => window.__nnSurfaceY(x, z), [turned.x, turned.z]);
  console.log(`${time}: rode to (${turned.x.toFixed(1)}, ${turned.z.toFixed(1)}), ${(turned.speed * 3.6).toFixed(0)} km/h, surface below y=${surface?.toFixed(2)}`);
  if (surface === null || surface > turned.y + 1) throw new Error('bike is inside a building (roof above it)');
  await page.keyboard.down('KeyS');
  const stopped = await until((s) => s.speed < 1, null, STEPS.stop, 'bike did not slow down');
  await page.keyboard.up('KeyS');
  await page.keyboard.press('KeyE');
  const off = await until((s) => s.mode === 'walk', null, STEPS.off, 'E did not get off the bike');
  const gap = Math.hypot(off.x - stopped.x, off.z - stopped.z);
  console.log(`${time}: got off ${gap.toFixed(2)} m from the bike`);
  if (gap < 0.5 || gap > 2.5) throw new Error(`dismount spot ${gap.toFixed(2)} m from the bike`);
}

const browser = await chromium.launch({ args: browserArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await ride(page, '14:00', shots && `${shots}/ride-day.png`);
  await ride(page, '22:30', shots && `${shots}/ride-night.png`);
  console.log('ride check OK');
} finally {
  await browser.close();
}
