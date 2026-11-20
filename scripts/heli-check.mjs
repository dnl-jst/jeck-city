// Usage: node scripts/heli-check.mjs [baseUrl] [shotsDir] [--online]
// Runs offline (?offline=1: local simulation, no server) unless --online (a dev-mode server: it joins through the name
// dialog, is teleported by ?cam and reports the server's corrections); further query parameters in baseUrl are kept.
// Scripted flight in headless Chromium (host GPU; NN_SOFTWARE_GL=1: SwiftShader): start beside the helicopter (the
// parked "car" of type heli in the manifest), press E, wait for the rotor, hold Space (climb > 15 m), hold W (fly
// > 60 m), check that E does not let the pilot out in the air, hold Shift until it stands on the ground again, get out.
// Saves heli-parked.png, heli-hover.png and heli-flight.png into shotsDir when given.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const online = process.argv.includes('--online');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = args[0] ?? 'http://localhost:5173/';
const shots = args[1];
const HANG_MS = 10 * 60_000;
const HELI_TYPE = 4; // index of 'heli' in CAR_TYPES

const { parked } = await fetch(new URL('/world/manifest.json', base)).then((r) => r.json());
const heli = parked.find((c) => c.type === HELI_TYPE);
if (!heli) throw new Error('no helicopter in the manifest (run `npm run ship-cars`)');
// 2.2 m to its left, beside the pilot's door
const start = { x: heli.x + Math.cos(heli.heading) * 2.2, z: heli.z - Math.sin(heli.heading) * 2.2 };
console.log(`helicopter at (${heli.x}, ${heli.z}); starting beside it`);

const browser = await chromium.launch({ args: browserArgs });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
try {
  const url = new URL(base);
  if (!online) url.searchParams.set('offline', '1');
  url.searchParams.set('cam', `${start.x.toFixed(2)},2,${start.z.toFixed(2)},${(((heli.heading * 180) / Math.PI) - 60).toFixed(0)},-8`);
  url.searchParams.set('time', '15:00');
  url.searchParams.set('date', '2026-06-15');
  url.searchParams.set('weather', 'clear');
  await page.goto(url.href);
  if (online) {
    const begin = page.locator('.nn-intro-start');
    if (await begin.count()) await begin.click();
    await page.locator('.nn-intro-go').click();
    await page.locator('.nn-lobby-input').fill('Heli Check');
    await page.keyboard.press('Enter');
  }
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  const state = () => page.evaluate(() => window.__nnState());
  /** Waits until pred(state, arg) holds; fails with `what` after `budget` more physics steps. */
  const until = async (pred, arg, budget, what) => {
    const limit = (await state()).steps + budget;
    await page.waitForFunction(([src, arg, limit]) => {
      const s = window.__nnState();
      return s.steps > limit || (0, eval)(`(${src})`)(s, arg);
    }, [pred.toString(), arg, limit], { timeout: HANG_MS, polling: 'raf' });
    const s = await state();
    if (!(await page.evaluate(([src, arg]) => (0, eval)(`(${src})`)(window.__nnState(), arg), [pred.toString(), arg]))) {
      console.error(JSON.stringify(s));
      throw new Error(`${what} (within ${budget} physics steps)`);
    }
    return s;
  };
  const shot = async (name) => {
    if (!shots) return;
    await page.screenshot({ path: `${shots}/${name}` });
    console.log(`saved ${shots}/${name}`);
  };

  await until((s, n) => s.steps > n, (await state()).steps + 60, 600, 'no frames');
  await shot('heli-parked.png');
  await page.keyboard.press('KeyE');
  const s0 = await until((s) => s.mode === 'drive', null, 300, 'E did not enter the helicopter');
  if (Math.hypot(s0.x - heli.x, s0.z - heli.z) > 1) throw new Error(`entered something else: ${JSON.stringify(s0)}`);
  await until((s) => s.engine === 'running', null, 600, 'the rotor did not start');

  // W on the ground does nothing
  await page.keyboard.down('KeyW');
  const ground = await until((s, n) => s.steps > n, s0.steps + 400, 600, 'no frames');
  await page.keyboard.up('KeyW');
  if (Math.hypot(ground.x - s0.x, ground.z - s0.z) > 0.5) throw new Error('the helicopter rolled on the ground');

  await page.keyboard.down('Space');
  const up = await until((s, y) => s.y > y + 15, s0.y, 600, 'did not climb 15 m');
  await page.keyboard.up('Space');
  const hover = await until((s, n) => s.steps > n, up.steps + 120, 300, 'no frames');
  const hover2 = await until((s, n) => s.steps > n, hover.steps + 120, 300, 'no frames');
  console.log(`climbed to ${(hover2.y - s0.y).toFixed(1)} m above the start; hover drift ${Math.abs(hover2.y - hover.y).toFixed(2)} m in 2 s`);
  if (Math.abs(hover2.y - hover.y) > 0.3) throw new Error('does not hold its height');
  await shot('heli-hover.png');

  await page.keyboard.press('KeyE');
  await until((s, n) => s.steps > n, hover2.steps + 30, 300, 'no frames');
  if ((await state()).mode !== 'drive') throw new Error('got out in the air');

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await until((s, n) => s.steps > n, hover2.steps + 150, 400, 'no frames');
  await page.keyboard.up('KeyD');
  const far = await until((s, [x, z]) => Math.hypot(s.x - x, s.z - z) > 60, [s0.x, s0.z], 900, 'did not fly 60 m');
  await shot('heli-flight.png');
  await page.keyboard.up('KeyW');
  console.log(`flew ${Math.hypot(far.x - s0.x, far.z - s0.z).toFixed(0)} m at ${(far.speed * 3.6).toFixed(0)} km/h`);
  await until((s) => s.speed < 1, null, 900, 'did not stop when let go');

  await page.keyboard.down('ShiftLeft');
  let last = await state();
  for (let i = 0; i < 40; i++) {
    const s = await until((s, n) => s.steps > n, last.steps + 60, 300, 'no frames');
    if (Math.abs(s.y - last.y) < 0.02) break; // stands
    last = s;
  }
  await page.keyboard.up('ShiftLeft');
  const down = await state();
  const surface = await page.evaluate(([x, z]) => window.__nnSurfaceY(x, z), [down.x, down.z]);
  console.log(`landed at (${down.x.toFixed(1)}, ${down.z.toFixed(1)}), y ${down.y.toFixed(2)}, surface ${surface?.toFixed(2)}`);
  await shot('heli-landed.png');
  await page.keyboard.press('KeyE');
  await until((s) => s.mode === 'walk', null, 600, 'E did not let the pilot out on the ground');
  if (online) console.log(`server corrections: ${JSON.stringify((await state()).reconciles)}`);
  console.log('heli-check ok');
} finally {
  await browser.close();
}
