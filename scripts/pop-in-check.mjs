// Usage: node scripts/pop-in-check.mjs [baseUrl] [--speed m/s] [--seconds s] [--quality level]
// Measures how many world chunks arrive only after they have come into view. Flies the dev camera in headless
// Chromium (?offline=1: no server session) in a straight line through the middle of the world at the helicopter's top
// speed and compares, for every chunk, the moment its nearest point comes within the view distance of the camera with
// the moment its download finished (resource timing). Decoding comes on top of the download and is not measured.
// Reports only; it fails on nothing. A dev server must be running (npm run dev). The frame rate it prints tells how far
// the result can be trusted: the loader runs once per frame, so a browser that draws a few frames per second (no GPU)
// loads late whatever the loader does. NN_ANGLE=metal (macOS) picks another ANGLE backend than browser-args.mjs.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const base = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'http://localhost:5173/';
const speed = Number(opt('speed', 38));
const seconds = Number(opt('seconds', 50));
const quality = opt('quality', 'low');
/** Day view distance (m) per quality level (apps/client/src/quality.ts). */
const VIEW = { high: 650, medium: 450, low: 300, minimal: 280 };
const view = VIEW[quality];
if (!view) throw new Error(`unknown quality ${quality}`);
const HEIGHT = 60;
const CHUNK = 200;

const manifest = await fetch(new URL('/world/manifest.json', base)).then((r) => r.json());
const index = await fetch(new URL('/world/index.json', base)).then((r) => r.json());
const xs = manifest.chunks.map((c) => c.x);
const zs = manifest.chunks.map((c) => c.z);
const midX = (Math.min(...xs) + Math.max(...xs) + CHUNK) / 2;
const midZ = (Math.min(...zs) + Math.max(...zs) + CHUNK) / 2;
const length = speed * seconds;
const x0 = midX - length / 2;
console.log(`flying ${length.toFixed(0)} m east at ${speed} m/s through z = ${midZ.toFixed(0)}, ${quality} quality (view ${view} m)`);

const args = process.env.NN_ANGLE ? [`--use-angle=${process.env.NN_ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist'] : browserArgs;
const browser = await chromium.launch({ args });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
try {
  const url = new URL(base);
  url.searchParams.set('offline', '1');
  url.searchParams.set('debug', '1'); // the fly hook
  url.searchParams.set('quality', quality);
  url.searchParams.set('cam', `${x0.toFixed(1)},${HEIGHT},${midZ.toFixed(1)},90,-15`);
  url.searchParams.set('time', '15:00');
  url.searchParams.set('weather', 'clear');
  await page.goto(url.href);
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 300_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
  if (!(await page.evaluate(() => typeof window.__nnFlyTo === 'function'))) throw new Error('no fly hook (dev build needed)');
  await page.waitForTimeout(8000); // let the chunks around the start arrive

  const result = await page.evaluate(async ([x0, z, height, speed, seconds]) => {
    performance.setResourceTimingBufferSize(5000);
    const t0 = performance.now();
    let frames = 0;
    let last = t0;
    const gaps = [];
    await new Promise((done) => {
      const frame = () => {
        const now = performance.now();
        const t = (now - t0) / 1000;
        frames++;
        gaps.push(now - last);
        last = now;
        window.__nnFlyTo(x0 + Math.min(t, seconds) * speed, height, z, 90, -15);
        if (t < seconds + 3) requestAnimationFrame(frame);
        else done();
      };
      frame();
    });
    gaps.sort((a, b) => b - a);
    return { t0, frames, gaps: gaps.slice(0, 5), over250: gaps.filter((g) => g > 250).length, entries: performance.getEntriesByType('resource').map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd })) };
  }, [x0, midZ, HEIGHT, speed, seconds]);

  /** Seconds into the flight at which each downloaded file had arrived, by URL ending. */
  const arrived = (file) => {
    const entry = index.files[file];
    const hits = result.entries.filter((e) => e.name.endsWith(`/${file}`) || (entry && e.name.includes(entry.hash)));
    return hits.length ? Math.min(...hits.map((e) => (e.end - result.t0) / 1000)) : null;
  };
  let entering = 0;
  let missing = 0;
  const late = [];
  const early = [];
  for (const c of manifest.chunks) {
    const dz = Math.max(c.z - midZ, 0, midZ - (c.z + CHUNK));
    if (dz > view) continue;
    // the camera's x at which the chunk's nearest point is `view` away, coming from the west
    const reach = Math.sqrt(view * view - dz * dz);
    const tIn = (c.x - reach - x0) / speed;
    if (tIn < 3 || tIn > seconds) continue; // in view from the start, or never reached
    entering++;
    const at = arrived(c.file);
    if (at === null) missing++;
    else if (at > tIn) late.push(at - tIn);
    else early.push(tIn - at);
  }
  const median = (a) => (a.length ? [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] : 0);
  console.log(`chunks coming into view: ${entering}`);
  console.log(`  downloaded in time: ${early.length} (median ${median(early).toFixed(1)} s before coming into view)`);
  console.log(`  downloaded late:    ${late.length} (median ${median(late).toFixed(1)} s, worst ${Math.max(0, ...late).toFixed(1)} s after coming into view)`);
  console.log(`  not downloaded during the flight: ${missing}`);
  console.log(`frames: ${(result.frames / (seconds + 3)).toFixed(0)} per second; ${result.over250} longer than 0.25 s; the longest ${result.gaps.map((g) => (g / 1000).toFixed(2)).join(', ')} s`);
  // what limited it: the chunk downloads that started during the flight
  const flown = [];
  for (const c of manifest.chunks) {
    const hash = index.files[c.file]?.hash;
    const e = result.entries.find((r) => r.name.endsWith(`/${c.file}`) || (hash && r.name.includes(hash)));
    if (e && e.start >= result.t0) flown.push({ s: (e.end - e.start) / 1000, mb: c.bytes / 1e6 });
  }
  const mb = flown.reduce((sum, d) => sum + d.mb, 0);
  console.log(`downloads during the flight: ${flown.length} chunks, ${mb.toFixed(0)} MB uncompressed, ${(mb / (seconds + 3)).toFixed(1)} MB/s; ` +
    `one chunk took ${median(flown.map((d) => d.s)).toFixed(1)} s (median), ${Math.max(0, ...flown.map((d) => d.s)).toFixed(1)} s at worst`);
} finally {
  await browser.close();
}
