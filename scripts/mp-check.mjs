// Usage: node scripts/mp-check.mjs [baseUrl] [--lag]
// Needs the dev stack running (npm run dev: game server + Vite; baseUrl defaults to http://localhost:5173/, the
// dev server's address, so pass it when NN_CLIENT_PORT differs). With --lag the server must have been started with
// NN_FAKE_LAG=75,10,1 (about 150 ms round trip, 1 % stalls). Start a fresh server for each run: the check drives a
// parked car and a bike away, and a second run on the same server would look for them at their manifest places.
// Two headless Chromium contexts (host GPU; NN_SOFTWARE_GL=1: SwiftShader) join as "Check A" and "Check B" (name
// dialog: fill, Enter) and both must see 2 players. A enters the car at the spawn and drives >= 30 m; B must see A
// move that far (__nnRemote). A then gets out, is teleported next to the nearest bike (dev hook) and rides it >= 10 m;
// B must see A in mode 'ride'. Against a production server (no dev hooks: no teleport) nobody is teleported: A enters the
// parked car that stands at the spawn and drives it, and B walks the few metres to the bike by the spawn and rides it
// (A must see B in mode 'ride'). All waits are budgets in physics steps (60 per simulated second), see drive-check.mjs.
// With --lag A also walks 20 s and drives 20 s while every frame's own-pose correction (__nnState().correction) and
// B's view of A (largest jump between two frames) are recorded: p95 correction per physics step (frame correction / steps that frame) must stay <= 0.2 m, and the remote
// figure must not teleport (spec 13.4): its move in a frame may exceed what its speed over the two frames before
// explains (speed · frame time) by at most 1 m, and its per-frame step must not change by more than 1 m between frames.
// The raw largest move between two frames is printed for information (a long frame at speed is no teleport). Per-frame
// numbers are printed too: a slow headless renderer puts several steps into one frame. Every recorded phase (also the
// drive without --lag) prints A's frame rate, inputs sent per second (= physics steps), its reconciliations (replayed,
// skipped because the prediction matched, set hard) and B's frame rate.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const args = process.argv.slice(2);
const lag = args.includes('--lag');
const base = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/';
const HANG_MS = 15 * 60_000;
const STALL_MS = 10_000;
const STEPS = { enter: 300, engine: 300, drive: 1800, stop: 900, exit: 300, tele: 300, mount: 300, ride: 900, see: 300, join: 600 };
const LAG_STEPS = 1200; // 20 s
const P95_MAX = 0.2;
const JUMP_MAX = 1;

/** Wait until pred(state, arg) holds, within `budget` more physics steps of that page (stall: fail fast). */
function untilOf(page, label) {
  const state = () => page.evaluate(() => window.__nnState());
  return async (pred, arg, budget, what) => {
    const limit = (await state()).steps + budget;
    await page.waitForFunction(([src, arg, limit, stallMs]) => {
      const s = window.__nnState();
      const now = performance.now();
      const w = window.__mpSteps;
      if (!w || w.limit !== limit || w.steps !== s.steps) window.__mpSteps = { limit, steps: s.steps, since: now, stalled: false };
      else if (now - w.since > stallMs) return (w.stalled = true);
      return s.steps > limit || (0, eval)(`(${src})`)(s, arg);
    }, [pred.toString(), arg, limit, STALL_MS], { timeout: HANG_MS, polling: 'raf' });
    if (await page.evaluate(() => window.__mpSteps?.stalled)) throw new Error(`${label}: physics steps did not advance for ${STALL_MS / 1000} s (${what})`);
    const s = await state();
    if (!(await page.evaluate(([src, arg]) => (0, eval)(`(${src})`)(window.__nnState(), arg), [pred.toString(), arg]))) {
      console.error(label, JSON.stringify(s));
      throw new Error(`${label}: ${what} (within ${budget} physics steps)`);
    }
    return s;
  };
}

/** Opens the game, answers the name dialog and waits until the world is ready and the player is online. */
async function join(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error] ${e.message}`));
  const url = new URL(base);
  url.searchParams.set('time', '14:00');
  url.searchParams.set('date', '2026-06-15');
  await page.goto(url.href);
  await page.locator('.nn-intro-go').click();
  await page.locator('.nn-lobby-input').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error(`${name}: world failed to load`);
  await page.waitForFunction(() => window.__nnState().online, null, { timeout: 60_000 });
  return { page, name, until: untilOf(page, name), state: () => page.evaluate(() => window.__nnState()) };
}

/** Per-frame recorder in the page: own correction, and the biggest frame-to-frame jump of one remote player. */
async function installRecorder(page, remoteName) {
  await page.evaluate((remoteName) => {
    const r = (window.__mpRec = { on: false, corr: [], speed: [], dsteps: [], times: [], lastSteps: null, jumps: [], excess: [], tele: [], prev: null, prev2: null });
    // ts: the frame's rAF time, the one the game's loop gets too (performance.now() here would also count the render
    // that ran before this callback, and a GPU stall there would shift the time to the wrong frame)
    const frame = (ts) => {
      if (r.on) {
        const st = window.__nnState();
        r.times.push(ts);
        r.corr.push(st.correction);
        r.speed.push(st.speed);
        r.dsteps.push(r.lastSteps === null ? 1 : st.steps - r.lastSteps);
        r.lastSteps = st.steps;
        const a = window.__nnRemote().find((p) => p.name === remoteName);
        if (a && r.prev && r.prev.mode === a.mode) r.jumps.push(Math.hypot(a.x - r.prev.x, a.z - r.prev.z));
        // what the speed does not explain: the change of the per-frame step (a straight constant-speed move gives 0)
        if (a && r.prev && r.prev2 && r.prev.mode === a.mode && r.prev2.mode === a.mode) {
          r.excess.push(Math.hypot(a.x - 2 * r.prev.x + r.prev2.x, a.z - 2 * r.prev.z + r.prev2.z));
          // teleport: the move this frame beyond what the speed of the two frames before explains (any frame length)
          const now = ts;
          const speed = Math.hypot(r.prev.x - r.prev2.x, r.prev.z - r.prev2.z) / Math.max(1e-3, r.prev.t - r.prev2.t);
          r.tele.push(Math.hypot(a.x - r.prev.x, a.z - r.prev.z) - speed * (now - r.prev.t));
        }
        r.prev2 = r.prev;
        r.prev = a ? { x: a.x, z: a.z, mode: a.mode, t: ts } : null;
      } else { r.prev = r.prev2 = null; r.lastSteps = null; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, remoteName);
}
const record = (page, on) => page.evaluate((on) => {
  const r = window.__mpRec;
  r.on = on;
  // reconciliations during the phase: counters at the start, the difference at the end
  if (on) r.rec0 = window.__nnState().reconciles;
  else {
    const now = window.__nnState().reconciles, was = r.rec0;
    r.rec = now && was ? { replayed: now.replayed - was.replayed, skipped: now.skipped - was.skipped, hard: now.hard - was.hard } : null;
  }
}, on);
const takeRecord = (page) => page.evaluate(() => {
  const r = window.__mpRec;
  const out = { corr: r.corr, speed: r.speed, dsteps: r.dsteps, times: r.times, jumps: r.jumps, excess: r.excess, tele: r.tele, rec: r.rec };
  r.corr = []; r.speed = []; r.dsteps = []; r.times = []; r.jumps = []; r.excess = []; r.tele = [];
  return out;
});
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)] : 0);
const maxOf = (xs) => xs.reduce((m, v) => Math.max(m, v), 0);
/** Correction stats of one phase: per frame, per physics step (frame correction / steps that frame), frames above 2 m/s. */
const phaseStats = (rec, remote) => {
  const step = rec.corr.map((c, i) => c / Math.max(1, rec.dsteps[i]));
  const seconds = rec.times.length > 1 ? (rec.times[rec.times.length - 1] - rec.times[0]) / 1000 : 0;
  const steps = rec.dsteps.reduce((a, b) => a + b, 0);
  return {
    frames: rec.corr.length, steps, fps: seconds ? (rec.corr.length - 1) / seconds : 0, inputsPerS: seconds ? steps / seconds : 0,
    reconciles: rec.rec, remoteFps: remote.times.length > 1 ? (remote.times.length - 1) / ((remote.times[remote.times.length - 1] - remote.times[0]) / 1000) : 0,
    frameP95: p95(rec.corr), frameMax: maxOf(rec.corr), stepP95: p95(step), stepMax: maxOf(step),
    movingStepP95: p95(step.filter((_, i) => rec.speed[i] > 2)), moving: rec.speed.filter((v) => v > 2).length,
    jump: maxOf(remote.jumps), excess: maxOf(remote.excess), tele: maxOf(remote.tele),
  };
};
const showStats = (k, r) => console.log(`${k}: ${r.frames} frames, ${r.steps} steps; A ${r.fps.toFixed(1)} fps, ${r.inputsPerS.toFixed(1)} inputs/s, reconciles ${JSON.stringify(r.reconciles)}; B ${r.remoteFps.toFixed(1)} fps; correction per frame p95 ${r.frameP95.toFixed(3)} m (max ${r.frameMax.toFixed(3)}), per step p95 ${r.stepP95.toFixed(4)} m (max ${r.stepMax.toFixed(4)}; frames above 2 m/s: ${r.moving}, p95 ${r.movingStepP95.toFixed(4)}); remote: frame jump max ${r.jump.toFixed(3)} m, teleport max ${r.tele.toFixed(3)} m, step change max ${r.excess.toFixed(3)} m`);
const remoteNamed = (page, name) => page.evaluate((name) => window.__nnRemote().find((p) => p.name === name) ?? null, name);
const remoteA = (page) => remoteNamed(page, 'Check A');
const teleport = (page, x, z) => page.evaluate(([x, z]) => window.__nnConn().sendTeleport(x, z), [x, z]);

/**
 * Press E and wait for `pred`. A press right after a teleport or a lag spike can be lost (the use pulse is a single
 * step), so settle for half a second first and press again (up to 3 times, 100 steps each) before giving up.
 */
async function useE(p, pred, what) {
  const s = await p.state();
  await p.until((s, n) => s.steps > n, s.steps + 30, 120, 'no steps while settling');
  for (let i = 1; ; i++) {
    await p.page.keyboard.press('KeyE');
    try {
      return await p.until(pred, null, 100, what);
    } catch (e) {
      if (i === 3) throw e;
    }
  }
}

const browser = await chromium.launch({ args: browserArgs });
let failed = false;
try {
  const a = await join(browser, 'Check A');
  const b = await join(browser, 'Check B');
  for (const p of [a, b]) await p.until((s) => s.players === 2, null, STEPS.join, 'did not see 2 players');
  console.log('both see 2 players');
  await installRecorder(b.page, 'Check A');
  await installRecorder(a.page, 'Check B');
  const { parked, bikes } = await a.page.evaluate(() => fetch('/world/manifest.json').then((r) => r.json()));

  const results = {};
  if (lag) {
    // 20 s on foot (W along the spawn heading)
    await record(a.page, true); await record(b.page, true);
    await a.page.keyboard.down('KeyW');
    const w0 = await a.state();
    await a.until((s, n) => s.steps > n, w0.steps + LAG_STEPS, LAG_STEPS + 60, 'walk phase did not finish');
    await a.page.keyboard.up('KeyW');
    await record(a.page, false); await record(b.page, false);
    const walkA = await takeRecord(a.page), walkB = await takeRecord(b.page);
    results.walk = phaseStats(walkA, walkB);
    showStats('walk 20 s', results.walk);
  }
  // A to the parked car nearest the spawn that has no bike within 8 m (with a bike in reach, E enters the one the
  // figure faces), standing 1.5 m beside it
  const { spawn } = await a.page.evaluate(() => fetch('/world/manifest.json').then((r) => r.json()));
  // and no other parked car in the 45 m ahead of it (driving W straight on must not end behind a bumper)
  const clearAhead = (c) => parked.every((o) => {
    if (o === c) return true;
    const dx = o.x - c.x, dz = o.z - c.z;
    const along = dx * Math.sin(c.heading) + dz * Math.cos(c.heading), side = dx * Math.cos(c.heading) - dz * Math.sin(c.heading);
    return !(along > -3 && along < 45 && Math.abs(side) < 3);
  });
  // no dev hooks (production server): the spawn is where everything happens, see the header
  const canTeleport = await a.page.evaluate(() => typeof window.__nnConn === 'function');
  if (!canTeleport) console.log('production server (no teleport): using the car and the bike at the spawn');
  const nearSpawn = (o) => ({ ...o, d: Math.hypot(o.x - spawn.x, o.z - spawn.z) });
  const car = !canTeleport ? parked.map(nearSpawn).sort((p, q) => p.d - q.d)[0] : parked.filter((c) => bikes.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 8) && clearAhead(c))
    .map((c) => ({ ...c, d: Math.hypot(c.x - spawn.x, c.z - spawn.z) })).sort((p, q) => p.d - q.d)[0];
  const sx = car.x + Math.cos(car.heading) * 1.5, sz = car.z - Math.sin(car.heading) * 1.5;
  if (canTeleport) {
    await teleport(a.page, sx, sz);
    await a.until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) < 1, [sx, sz], STEPS.tele, 'teleport next to the car did not arrive');
  }
  const s0 = await useE(a, (s) => s.mode === 'drive', 'E did not enter the car');
  await a.until((s) => s.engine === 'running', null, STEPS.engine, 'engine did not start');
  const startA = await remoteA(b.page);
  if (!startA) throw new Error('B does not see A');
  console.log(`A entered the car at (${s0.x.toFixed(1)}, ${s0.z.toFixed(1)}); B sees A as ${startA.mode}`);
  let maxD = 0;
  await record(a.page, true); await record(b.page, true);
  await a.page.keyboard.down('KeyW');
  if (lag) {
    // 20 s shuttling along the street the car stands in (no steering: it keeps to its lane): W until 28 m from where it
    // started, then S back to within 6 m of it, and so on; half-second chunks
    let dir = 'KeyW';
    const t0 = (await a.state()).steps;
    for (;;) {
      const before = await a.state();
      if (before.steps - t0 >= LAG_STEPS) break;
      const d = Math.hypot(before.x - s0.x, before.z - s0.z);
      maxD = Math.max(maxD, d);
      if (dir === 'KeyW' && d > 28) dir = 'KeyS';
      else if (dir === 'KeyS' && d < 6) dir = 'KeyW';
      for (const k of ['KeyW', 'KeyS']) await a.page.keyboard[k === dir ? 'down' : 'up'](k);
      await a.until((s, n) => s.steps > n, before.steps + 30, 200, 'drive phase did not finish');
    }
    for (const k of ['KeyW', 'KeyS']) await a.page.keyboard.up(k);
  } else {
    await a.until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) >= 32, [s0.x, s0.z], STEPS.drive, 'car did not get 32 m far');
  }
  await a.page.keyboard.up('KeyW');
  {
    await record(a.page, false); await record(b.page, false);
    const dA = await takeRecord(a.page), dB = await takeRecord(b.page);
    results.drive = phaseStats(dA, dB);
    showStats(lag ? 'drive 20 s' : 'drive', results.drive);
  }
  const sA = await a.state();
  const movedA = lag ? maxD : Math.hypot(sA.x - s0.x, sA.z - s0.z); // --lag shuttles: the farthest point counts
  console.log(`A drove ${movedA.toFixed(1)} m`);
  if (movedA < 30) throw new Error(`A drove only ${movedA.toFixed(1)} m (< 30)`);
  // B sees it (the remote catches up within a moment)
  if (!lag) {
    await b.until((s, [x, z]) => {
      const r = window.__nnRemote().find((p) => p.name === 'Check A');
      return !!r && Math.hypot(r.x - x, r.z - z) >= 30;
    }, [startA.x, startA.z], STEPS.see, 'B did not see A move 30 m');
    const seen = await remoteA(b.page);
    console.log(`B sees A ${Math.hypot(seen.x - startA.x, seen.z - startA.z).toFixed(1)} m from its start, mode ${seen.mode}`);
  }

  // stop, get out
  await a.page.keyboard.down('Space');
  await a.until((s) => s.speed < 0.5, null, STEPS.stop, 'car did not stop');
  await a.page.keyboard.up('Space');
  const out = await useE(a, (s) => s.mode === 'walk', 'E did not get out of the car');
  // the server must have applied the E press before the teleport: a fresh figure next to the bike that gets the
  // still-queued E input would get on the bike right away (and the press below would get off again)
  await b.until(() => window.__nnRemote().find((p) => p.name === 'Check A')?.mode === 'walk', null, STEPS.see, 'B did not see A get out');

  // ride (A with teleports, else B who is still by the spawn): the nearest bike with no other bike within 4 m (so E there
  // can only mean this one) and, with teleports, away from the car's start (the car just drove off and may have pushed a
  // bike around there)
  const [rider, watcher] = canTeleport ? [a, b] : [b, a];
  const rName = rider.name;
  const rOut = await rider.state();
  const lone = bikes.filter((k, i) => (!canTeleport || Math.hypot(k.x - s0.x, k.z - s0.z) > 10) && bikes.every((o, j) => j === i || Math.hypot(o.x - k.x, o.z - k.z) >= 4));
  const bike = lone.map((k) => ({ ...k, d: Math.hypot(k.x - rOut.x, k.z - rOut.z) })).sort((p, q) => p.d - q.d)[0];
  if (canTeleport) {
    const bx = bike.x + Math.cos(bike.heading), bz = bike.z - Math.sin(bike.heading);
    console.log(`nearest lone bike (${bike.x.toFixed(1)}, ${bike.z.toFixed(1)}), ${bike.d.toFixed(0)} m away: teleporting beside it`);
    await teleport(rider.page, bx, bz);
    await rider.until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) < 1.5, [bx, bz], STEPS.tele, 'teleport next to the bike did not arrive');
  } else {
    // walk to within 2 m of the bike: W when it is ahead of the spawn heading (the camera yaw starts there), else S
    const key = (bike.x - rOut.x) * Math.sin(spawn.heading) + (bike.z - rOut.z) * Math.cos(spawn.heading) > 0 ? 'KeyW' : 'KeyS';
    console.log(`bike at the spawn (${bike.x.toFixed(1)}, ${bike.z.toFixed(1)}), ${bike.d.toFixed(1)} m away: walking to it (${key})`);
    if (bike.d > 2) {
      await rider.page.keyboard.down(key);
      await rider.until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) < 2, [bike.x, bike.z], STEPS.tele, 'did not walk to the bike');
      await rider.page.keyboard.up(key);
    }
  }
  const on = await useE(rider, (s) => s.mode === 'ride', 'E did not get on the bike');
  await rider.page.keyboard.down('KeyW');
  await rider.until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) >= 10, [on.x, on.z], STEPS.ride, 'bike did not get 10 m far');
  const rideA = await rider.state();
  try {
    await watcher.until((s, n) => !!window.__nnRemote().find((p) => p.name === n && p.mode === 'ride'), rName, STEPS.see, `${watcher.name} did not see ${rName} riding`);
  } catch (e) {
    console.error(`${rName} now`, JSON.stringify(await rider.state()), `${watcher.name} sees`, JSON.stringify(await watcher.page.evaluate(() => window.__nnRemote())));
    throw e;
  }
  await rider.page.keyboard.up('KeyW');
  console.log(`${rName} rode ${Math.hypot(rideA.x - on.x, rideA.z - on.z).toFixed(1)} m; ${watcher.name} sees it in mode ${(await remoteNamed(watcher.page, rName)).mode}`);

  if (lag) {
    for (const [k, r] of Object.entries(results)) {
      if (r.stepP95 > P95_MAX) { console.error(`FAIL: ${k} correction per step p95 ${r.stepP95.toFixed(4)} m > ${P95_MAX}`); failed = true; }
      if (r.tele > JUMP_MAX) { console.error(`FAIL: ${k} remote teleport ${r.tele.toFixed(3)} m > ${JUMP_MAX}`); failed = true; }
      if (r.excess > JUMP_MAX) { console.error(`FAIL: ${k} remote step change ${r.excess.toFixed(3)} m > ${JUMP_MAX}`); failed = true; }
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('mp-check: OK');
