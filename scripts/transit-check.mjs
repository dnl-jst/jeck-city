// Usage: node scripts/transit-check.mjs [baseUrl] [shotsDir] [station]
// Runs offline (?offline=1: local simulation, no server) against the Vite dev server; NN_ONLINE=1: on the game server
// instead (it must run in dev mode: the spawn is a dev teleport), reporting the server's corrections during the ride.
// Scripted trip on the underground Stadtbahn in headless Chromium (host GPU; NN_SOFTWARE_GL=1: SwiftShader): spawn at a
// stairwell of `station` (index in manifest.transit.stations, default 2), walk down to the platform, wait for a train,
// walk in through an open door, ride to the next station (carried along while standing) and walk out onto its platform.
// Saves stills into shotsDir when given.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const shots = process.argv[3];
const stationIndex = Number(process.argv[4] ?? 2);
const DEG = 180 / Math.PI;

const browser = await chromium.launch({ args: browserArgs });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  const origin = new URL(base).origin;
  const manifest = await (await fetch(`${origin}/world/manifest.json`)).json();
  const transit = manifest.transit;
  if (!transit) throw new Error('the world has no transit');
  const station = transit.stations[stationIndex];
  // the stairwell nearest to the station: its ring runs up one side (bottom → top) and down the other
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const stairs = transit.openings.map((r) => {
    const pts = [];
    for (let i = 0; i < r.length; i += 2) pts.push({ x: r[i], z: r[i + 1] });
    const h = pts.length / 2;
    return { bottom: mid(pts[0], pts[pts.length - 1]), top: mid(pts[h - 1], pts[h]) };
  }).sort((a, b) => Math.hypot(a.bottom.x - station.x, a.bottom.z - station.z) - Math.hypot(b.bottom.x - station.x, b.bottom.z - station.z));
  const stair = stairs[0];
  const len = Math.hypot(stair.bottom.x - stair.top.x, stair.bottom.z - stair.top.z);
  const down = { x: (stair.bottom.x - stair.top.x) / len, z: (stair.bottom.z - stair.top.z) / len };
  const start = { x: stair.top.x - down.x * 3, z: stair.top.z - down.z * 3 };
  const yaw = Math.atan2(down.x, down.z) * DEG;
  console.log(`${station.name}: stair top (${stair.top.x.toFixed(1)}, ${stair.top.z.toFixed(1)}), ${len.toFixed(1)} m long; platform at y ${station.y}`);

  const url = new URL(base);
  const online = process.env.NN_ONLINE === '1';
  if (!online) url.searchParams.set('offline', '1');
  url.searchParams.set('time', '14:00');
  url.searchParams.set('cam', `${start.x.toFixed(2)},0,${start.z.toFixed(2)},${yaw.toFixed(1)},-10`);
  await page.goto(url.href);
  if (online) {
    // the intro (its full-screen start layer first), then the name dialog
    const startLayer = page.locator('.nn-intro-start');
    if (await startLayer.count()) await startLayer.click();
    await page.locator('.nn-intro-go').click();
    await page.locator('.nn-lobby-input').fill('Bahn-Check');
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  await page.waitForTimeout(1500);
  const state = () => page.evaluate(() => window.__nnState());
  const trains = (p) => page.evaluate(([x, z]) => window.__nnTrains(x, z), [p.x, p.z]);
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  await page.mouse.click(640, 360); // pointer lock / focus
  await shot('transit-1-entrance');

  /** Turns the camera (and with it the walking direction) towards `to`, to within `tol` rad. */
  const face = async (to, tol = 0.08) => {
    for (let i = 0; i < 40; i++) {
      const s = await state();
      let err = Math.atan2(to.x - s.x, to.z - s.z) - s.yaw;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      if (Math.abs(err) < tol) return;
      // mouse right (dx > 0) lowers the yaw: MOUSE rad per pixel (camera.ts)
      await page.evaluate((dx) => window.__nnWheelNudge?.(dx, 0), -err / 0.0025);
      await page.waitForTimeout(60);
    }
  };
  /** Walks towards `to` (first turning to face it, then holding W and keeping the heading) until within `near` m. */
  const walkTo = async (to, near, what, { run = false, seconds = 40 } = {}) => {
    await face(to);
    await page.keyboard.down('KeyW');
    if (run) await page.keyboard.down('ShiftLeft');
    const t0 = Date.now();
    try {
      for (;;) {
        await page.waitForTimeout(100);
        const s = await state();
        const d = Math.hypot(to.x - s.x, to.z - s.z);
        if (d < near) return s;
        if (Date.now() - t0 > seconds * 1000) throw new Error(`${what}: still ${d.toFixed(1)} m away after ${seconds} s at (${s.x.toFixed(1)}, ${s.y.toFixed(1)}, ${s.z.toFixed(1)})`);
        await face(to, 0.2);
      }
    } finally {
      await page.keyboard.up('KeyW');
      if (run) await page.keyboard.up('ShiftLeft');
    }
  };

  // down the stairs
  const s0 = await state();
  await walkTo(mid(stair.top, stair.bottom), 1.2, 'walking down the stairs');
  await shot('transit-2-stairs');
  const sBottom = await walkTo({ x: stair.bottom.x + down.x * 2.5, z: stair.bottom.z + down.z * 2.5 }, 1, 'reaching the platform');
  console.log(`down the stairs: y ${s0.y.toFixed(2)} → ${sBottom.y.toFixed(2)}`);
  if (Math.abs(sBottom.y - station.y) > 0.3) throw new Error(`not on the platform (y ${sBottom.y.toFixed(2)}, platform ${station.y})`);
  await shot('transit-3-platform');

  // a train standing here with its doors open on this side
  const openHere = (t, p) => t.station === stationIndex && Math.max(t.left, t.right) > 0.9 && Math.hypot(t.x - p.x, t.z - p.z) < 60;
  let section = null;
  for (let i = 0; i < 400 && !section; i++) {
    const p = await state();
    const near = (await trains(p)).filter((t) => {
      if (!openHere(t, p)) return false;
      // on our side: the open doors face the player
      const lx = Math.cos(t.yaw), lz = -Math.sin(t.yaw), side = (p.x - t.x) * lx + (p.z - t.z) * lz;
      return (side > 0 && t.left > 0.9) || (side < 0 && t.right > 0.9);
    });
    if (near.length) section = near[0];
    else await page.waitForTimeout(500);
  }
  if (!section) throw new Error('no train came within 200 s');
  await shot('transit-4-train');
  await walkTo(section, 0.8, 'walking into the train', { seconds: 15 });
  const inTrain = await state();
  console.log(`in the train at (${inTrain.x.toFixed(1)}, ${inTrain.y.toFixed(2)}, ${inTrain.z.toFixed(1)}), mode ${inTrain.mode}`);
  await shot('transit-5-inside');

  // carried along: after the next stop begins, still in the same section
  const rel = (s, t) => Math.hypot(s.x - t.x, s.z - t.z);
  let moved = 0, arrived = null, worst = 0;
  const before = await state();
  for (let i = 0; i < 600 && !arrived; i++) {
    await page.waitForTimeout(500);
    const s = await state(), t = (await trains(s))[0];
    moved = Math.hypot(s.x - inTrain.x, s.z - inTrain.z);
    worst = Math.max(worst, s.correction);
    if (rel(s, t) > 4) throw new Error(`fell out of the train: ${rel(s, t).toFixed(1)} m from the nearest section after ${moved.toFixed(0)} m`);
    if (moved > 30 && i % 20 === 0) await shot('transit-6-riding');
    if (moved > 100 && t.station >= 0 && Math.max(t.left, t.right) > 0.9) arrived = { s, t };
  }
  if (!arrived) throw new Error(`the train did not reach the next station (moved ${moved.toFixed(0)} m)`);
  console.log(`rode ${moved.toFixed(0)} m to ${transit.stations[arrived.t.station].name}`);
  if (online) {
    const r = arrived.s.reconciles, r0 = before.reconciles;
    console.log(`online: largest correction seen ${worst.toFixed(3)} m; reconciles during the ride: ${r.replayed - r0.replayed} replayed, ${r.skipped - r0.skipped} matched, ${r.hard - r0.hard} hard`);
    if (!arrived.s.online) throw new Error('not online');
  }

  // out through the open doors
  const { t } = arrived, side = t.left > 0.9 ? 1 : -1;
  const out = { x: t.x + Math.cos(t.yaw) * side * 3.6, z: t.z - Math.sin(t.yaw) * side * 3.6 };
  await walkTo(t, 0.15, 'walking to the door', { seconds: 10 }); // (from wherever in the section: first abeam the door)
  const onPlatform = await walkTo(out, 0.8, 'walking out of the train', { seconds: 15 });
  const there = transit.stations[t.station];
  if (Math.abs(onPlatform.y - there.y) > 0.3) throw new Error(`not on the platform after getting out (y ${onPlatform.y.toFixed(2)}, platform ${there.y})`);
  await shot('transit-7-arrived');
  console.log(`out at ${there.name}: (${onPlatform.x.toFixed(1)}, ${onPlatform.y.toFixed(2)}, ${onPlatform.z.toFixed(1)})`);
  console.log('transit-check ok');
} finally {
  await browser.close();
}
