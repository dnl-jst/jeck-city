// Usage: node scripts/drive-check.mjs [baseUrl] [shotsDir]
// Runs offline (?offline=1: local simulation, no server); further query parameters in baseUrl are kept.
// Scripted drive in headless Chromium (host GPU; NN_SOFTWARE_GL=1: SwiftShader): spawn (no ?cam), pick the parked car nearest to the spawn (must be within
// the 2.7 m the pipeline guarantees), press E and check that this car is the one entered, wait for the engine (throttle
// is dead until it runs), hold W (then W+D), and check that the car moved > 20 m, is not inside a building, stops, and
// that getting out puts the player on foot again. In the day run, hold R to open the radio wheel, point right (dev hook
// __nnWheelNudge, no pointer lock headless) and release: Radio Köln. Saves task11-car.png (day), task11-night-car.png
// (night) and radio-wheel.png (open wheel) into shotsDir when given.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const shots = process.argv[3];
const REACH = 2.7;
// waits are budgets in fixed physics steps (60 per simulated second): a loaded machine renders fewer frames and
// so simulates slower than real time, which made wall-clock timeouts flaky. The wall clock only guards a hang.
const HANG_MS = 15 * 60_000;
/** The step counter standing still this long (wall clock) means the simulation stalled: fail fast instead of at HANG_MS. */
const STALL_MS = 10_000;
const STEPS = { enter: 300, engine: 300, wheel: 300, away12: 900, away30: 1200, stop: 900, exit: 300 };

async function drive(page, time, shot, wheelShot) {
  const url = new URL(base);
  url.searchParams.set('offline', '1');
  url.searchParams.set('time', time);
  url.searchParams.set('date', '2026-06-15');
  await page.goto(url.href);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 120_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  const state = () => page.evaluate(() => window.__nnState());
  /**
   * Wait until pred(state, arg) holds, failing with `what` once `budget` more physics steps have passed without it,
   * and with a stall error once the step counter has not advanced for STALL_MS.
   */
  const until = async (pred, arg, budget, what) => {
    const limit = (await state()).steps + budget;
    await page.waitForFunction(([src, arg, limit, stallMs]) => {
      const s = window.__nnState();
      const now = performance.now();
      const w = window.__dcSteps;
      if (!w || w.limit !== limit || w.steps !== s.steps) window.__dcSteps = { limit, steps: s.steps, since: now, stalled: false };
      else if (now - w.since > stallMs) return (w.stalled = true);
      return s.steps > limit || (0, eval)(`(${src})`)(s, arg);
    }, [pred.toString(), arg, limit, STALL_MS], { timeout: HANG_MS, polling: 'raf' });
    if (await page.evaluate(() => window.__dcSteps?.stalled)) {
      console.error(JSON.stringify(await state()));
      throw new Error(`physics steps did not advance for ${STALL_MS / 1000} s (${what})`);
    }
    const s = await state();
    if (!(await page.evaluate(([src, arg]) => (0, eval)(`(${src})`)(window.__nnState(), arg), [pred.toString(), arg]))) {
      console.error(JSON.stringify(s));
      throw new Error(`${what} (within ${budget} physics steps)`);
    }
    return s;
  };

  const { spawn, parked } = await page.evaluate(() => fetch('/world/manifest.json').then((r) => r.json()));
  const near = parked.map((c) => ({ ...c, d: Math.hypot(c.x - spawn.x, c.z - spawn.z) })).sort((a, b) => a.d - b.d)[0];
  console.log(`${time}: nearest car (${near.x.toFixed(1)}, ${near.z.toFixed(1)}), ${near.d.toFixed(2)} m from the spawn (${spawn.x}, ${spawn.z})`);
  if (near.d > REACH) throw new Error(`nearest parked car ${near.d.toFixed(2)} m from the spawn (> ${REACH})`);
  const atSpawn = await state();
  if (atSpawn.mode !== 'walk' || Math.hypot(atSpawn.x - spawn.x, atSpawn.z - spawn.z) > 0.5) throw new Error(`player not at the spawn: ${JSON.stringify(atSpawn)}`);

  await page.keyboard.press('KeyE');
  const s0 = await until((s) => s.mode === 'drive', null, STEPS.enter, 'E did not enter the car');
  const entered = Math.hypot(s0.x - near.x, s0.z - near.z);
  if (entered > 1) throw new Error(`entered a car ${entered.toFixed(2)} m from the nearest one`);
  // throttle is dead until the engine has started
  const running = await until((s) => s.engine === 'running', null, STEPS.engine, 'engine did not start');
  // R held during the start is cancelled until let go: let one more frame see the engine running with R up first
  // (on a slow renderer the next frame may not have come before R goes down)
  await until((s, n) => s.steps > n, running.steps, STEPS.engine, 'no frame after the engine started');
  if (wheelShot !== undefined) await radioWheel(page, until, wheelShot);
  const away = (m, budget) => until((s, [x, z, m]) => Math.hypot(s.x - x, s.z - z) > m, [s0.x, s0.z, m], budget, `car did not get ${m} m far`);
  await page.keyboard.down('KeyW');
  await away(12, STEPS.away12);
  if (shot) {
    await page.screenshot({ path: shot });
    const info = await page.evaluate(() => window.__nnInfo());
    console.log(`saved ${shot} (draw calls ${info.calls})`);
  }
  await away(30, STEPS.away30).catch((e) => console.error(e.message));
  await page.keyboard.up('KeyW');
  const s = await state();
  const moved = Math.hypot(s.x - s0.x, s.z - s0.z);
  const surface = await page.evaluate(([x, z]) => window.__nnSurfaceY(x, z), [s.x, s.z]);
  console.log(`${time}: drove ${moved.toFixed(1)} m to (${s.x.toFixed(1)}, ${s.z.toFixed(1)}), ${(s.speed * 3.6).toFixed(0)} km/h, surface below y=${surface?.toFixed(2)}`);
  if (moved <= 20) throw new Error('car moved less than 20 m');
  if (surface === null || surface > s.y + 1) throw new Error('car is inside a building (roof above it)');
  // stop, get out
  await page.keyboard.down('Space');
  const stopped = await until((s) => s.speed < 0.5, null, STEPS.stop, 'car did not stop');
  await page.keyboard.up('Space');
  await page.keyboard.press('KeyE');
  const out = await until((s) => s.mode === 'walk', null, STEPS.exit, 'E did not get out of the car');
  const gap = Math.hypot(out.x - stopped.x, out.z - stopped.z);
  console.log(`${time}: got out at (${out.x.toFixed(1)}, ${out.y.toFixed(2)}, ${out.z.toFixed(1)}), ${gap.toFixed(2)} m from the stopped car`);
  // left (or right) of the car: 1.5 m from its centre line; behind would be 3.0 m
  if (Math.abs(gap - 1.5) > 0.25) throw new Error(`exit spot ${gap.toFixed(2)} m from the car, expected about 1.5 m`);
}

/** Day run only: hold R, point right, release. `until` is drive's step-budgeted wait; predicates get the state as `s`. */
async function radioWheel(page, until, shot) {
  if ((await page.evaluate(() => window.__nnState().radio)) !== 'koellefornia') throw new Error('radio did not start on Köllefornia');
  await page.keyboard.down('KeyR');
  await until((s) => s.wheelOpen, null, STEPS.wheel, 'holding R did not open the radio wheel');
  await page.evaluate(() => window.__nnWheelNudge(60, 0));
  await until((s) => s.wheelHighlighted === 'radiokoeln', null, STEPS.wheel, 'nudge did not highlight Radio Köln');
  if (shot) {
    await page.screenshot({ path: shot });
    console.log(`saved ${shot}`);
  }
  await page.keyboard.up('KeyR');
  await until((s) => !s.wheelOpen && s.radio === 'radiokoeln', null, STEPS.wheel, 'wheel pick right did not select Radio Köln');
  console.log('radio wheel: hold R, point right, release -> radiokoeln');
}

const browser = await chromium.launch({ args: browserArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await drive(page, '14:00', shots && `${shots}/task11-car.png`, shots ? `${shots}/radio-wheel.png` : null);
  await drive(page, '22:30', shots && `${shots}/task11-night-car.png`);
  console.log('drive check OK');
} finally {
  await browser.close();
}
