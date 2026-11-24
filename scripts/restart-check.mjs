// Usage: npm run restart-check   (node scripts/restart-check.mjs)
// End to end: an announced server restart counts down in the browser, and the page reloads by itself once the new
// server is up; an unannounced crash (kill -KILL) shows neither banner nor reload, only the usual connection message.
// Starts everything itself on spare ports (never 2567/5173): a production-mode game server (NODE_ENV=production
// RESTART_NOTICE_S=20 NN_WEATHER=off, no WORLD_URL: world files from apps/client/public/world) on
// NN_CHECK_SERVER_PORT (default 2603) and the client's Vite dev server in front of it on NN_CHECK_CLIENT_PORT
// (default 5203; it proxies /healthz, matchmaking and the WebSocket to the game server). Vite dev instead of a client
// build: `vite build` would copy the whole 1.7 GB world into apps/client/dist. Only the processes started here are
// signalled (by their PIDs), and they are all stopped in the end, also on failure.
// Steps: server A up → one headless Chromium joins as "Restart Check" (name dialog: fill, Enter) → kill -TERM A → the
// banner counts down from 0:20 (0:19 accepted: so far the first value seen has always been 0:19), highlighted from 0:10
// on → A exits after the notice → the net status reads "Die Stadt wird aktualisiert …" → server B started → the page
// reloads by itself: its /healthz poll sees B within 3 s of B answering here (every 2 s + round trip), the reload
// follows within 5.5 s (random 0–5 s). Both limits are extended by the page's measured main-thread stalls (a headless
// WebGL page under load runs its timers late by seconds; ?quality=low keeps that down). Gegenprobe: join
// again, kill -KILL B → no banner, "Verbindung unterbrochen …", then "Verbindung verloren – bitte Seite neu laden.";
// server C started → the page does not reload (15 s).
// Takes about 2–3.5 minutes (world load in the browser twice, 20 s notice, three server starts, 15 s reconnect window).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const SERVER_PORT = Number(process.env.NN_CHECK_SERVER_PORT ?? 2603);
const CLIENT_PORT = Number(process.env.NN_CHECK_CLIENT_PORT ?? 5203);
const NOTICE_S = 20;
const RESTART_TEXT = 'Die Stadt wird aktualisiert …';
const RECONNECTING_TEXT = 'Verbindung unterbrochen …';
const LOST_TEXT = 'Verbindung verloren – bitte Seite neu laden.';
/**
 * The page polls /healthz every 2 s (+ the poll's round trip through Vite to a server that has just started) and then
 * waits a random 0–5 s (+ the time the reload takes to commit): together the nominal 2–7 s.
 */
const POLL_MAX_MS = 3000;
const JITTER_MAX_MS = 5500;
const root = fileURLToPath(new URL('..', import.meta.url));
const base = `http://localhost:${CLIENT_PORT}/`;
const health = `http://127.0.0.1:${SERVER_PORT}/healthz`;

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it returns a truthy value (returned) or `timeoutMs` passes (throws `what`). */
async function until(fn, timeoutMs, what, everyMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout (${timeoutMs / 1000} s): ${what}`);
    await sleep(everyMs);
  }
}
const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
const healthTicks = () => fetch(health, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).then((h) => (typeof h.ticks === 'number' ? h : null), () => null);

/** Children started here (only these are ever signalled). */
const children = new Set();
function start(label, args, cwd, env) {
  const c = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(c);
  const forward = (s) => (d) => { for (const line of String(d).split('\n')) if (line.trim()) s.write(`  [${label}] ${line}\n`); };
  c.stdout.on('data', forward(process.stdout));
  c.stderr.on('data', forward(process.stderr));
  c.exited = new Promise((r) => c.once('exit', (code, signal) => { children.delete(c); r({ code, signal, at: Date.now() }); }));
  log(`${label} started (pid ${c.pid})`);
  return c;
}
function startServer(label) {
  const env = { NODE_ENV: 'production', RESTART_NOTICE_S: String(NOTICE_S), PORT: String(SERVER_PORT), NN_WEATHER: 'off', WORLD_URL: '', PUBLIC_URL: '' };
  return start(label, ['--import', 'tsx', 'src/main.ts'], `${root}apps/server`, env);
}
async function serverUp(label) {
  const h = await until(healthTicks, 120_000, `${label} did not answer /healthz with ticks`, 100);
  log(`${label} up: /healthz ticks ${h.ticks}`);
  return Date.now();
}

/** Opens the game (or answers the dialog after a reload) and waits until the world is ready and the player is online. */
async function join(page, name, reloaded) {
  if (!reloaded) {
    const url = new URL(base);
    url.searchParams.set('time', '14:00');
    url.searchParams.set('date', '2026-06-15');
    url.searchParams.set('quality', 'low'); // the lightest renderer: fewer main-thread stalls in the timing checks
    await page.goto(url.href);
  }
  // the intro: its full-screen start layer first (it starts the music), then the button into the lobby
  // (after a reload the browser may allow autoplay: the layer then leaves by itself and must not be clicked)
  await page.locator('.nn-intro-go').waitFor({ timeout: 120_000 });
  const start = page.locator('.nn-intro-start:not(.nn-leaving)');
  if (await start.count()) await start.click({ timeout: 2000 }).catch(() => undefined);
  await page.locator('.nn-intro-go').click();
  await page.locator('.nn-lobby-input').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 300_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error(`${name}: world failed to load`);
  await page.waitForFunction(() => window.__nnState().online, null, { timeout: 60_000 });
  // the page's own recorder (gone after a reload): banner and net status changes, sent to `seen` below
  await page.evaluate(() => {
    window.__rcMarker = true;
    let last = '';
    let tick = performance.now();
    setInterval(() => {
      // main-thread stalls (a slow headless frame): every timer of the page, its /healthz polls too, is late by as much
      const now = performance.now();
      if (now - tick > 250) window.__rcStall(now - tick - 50);
      tick = now;
      const b = document.querySelector('.nn-restart');
      const e = {
        banner: b && !b.hidden ? b.textContent : null, soon: !!b?.classList.contains('nn-restart-soon'),
        net: document.querySelector('.nn-net')?.textContent ?? '',
      };
      const key = JSON.stringify(e);
      if (key !== last) { last = key; window.__rcSeen(e); }
    }, 50);
  });
}

/** Everything the page's recorder reported, with the time it arrived here. */
const seen = [];
/** Main-thread stalls of the page (ms beyond its 50 ms interval), with the time they ended. */
const stalls = [];
/** How late the page's timers ran in total between `from` and `to` (stalls ending in that span). */
const stalledMs = (from, to) => stalls.filter((s) => s.at >= from && s.at <= to).reduce((a, s) => a + s.ms, 0);
const lastSeen = () => seen[seen.length - 1] ?? { banner: null, soon: false, net: '' };
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};

let browser = null;
let vite = null;
try {
  for (const port of [SERVER_PORT, CLIENT_PORT]) {
    if (await reachable(`http://127.0.0.1:${port}/`)) throw new Error(`port ${port} is taken: set NN_CHECK_SERVER_PORT / NN_CHECK_CLIENT_PORT`);
  }
  let server = startServer('server A');
  vite = start('vite', [`${root}node_modules/vite/bin/vite.js`, '--logLevel', 'warn'], `${root}apps/client`, { NN_CLIENT_PORT: String(CLIENT_PORT), PORT: String(SERVER_PORT) });
  await serverUp('server A');
  // the local world files, not a bucket (WORLD_URL is set empty above, also against a .env)
  const { worldUrl } = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/config.json`)).json();
  if (worldUrl !== null) throw new Error(`server A names a world bucket (${worldUrl}): expected none`);
  await until(() => reachable(base), 60_000, 'vite did not come up');

  browser = await chromium.launch({ args: browserArgs });
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  await ctx.exposeBinding('__rcSeen', (_src, e) => { seen.push({ ...e, at: Date.now() }); });
  await ctx.exposeBinding('__rcStall', (_src, ms) => { stalls.push({ at: Date.now(), ms }); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  /** Main-frame navigations after the first load (the reloads). */
  const navigations = [];
  let loaded = false;
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && loaded) navigations.push(Date.now()); });
  /** When the page's own /healthz polls got an answer with ticks (to tell poll delay from the random wait). */
  const pagePolls = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname !== '/healthz') return;
    void r.json().then((h) => { if (typeof h?.ticks === 'number') pagePolls.push({ at: Date.now(), ticks: h.ticks }); }, () => undefined);
  });
  await join(page, 'Restart Check', false);
  loaded = true;
  log('joined, world loaded, online');

  // ---- announced restart ----
  seen.length = 0;
  const termAt = Date.now();
  process.kill(server.pid, 'SIGTERM');
  log(`kill -TERM ${server.pid}`);
  const exitA = await Promise.race([server.exited, sleep((NOTICE_S + 30) * 1000).then(() => null)]);
  if (!exitA) throw new Error('server A did not exit after the notice');
  log(`server A exited (${exitA.signal ?? exitA.code}) ${((exitA.at - termAt) / 1000).toFixed(1)} s after SIGTERM`);
  check(exitA.at - termAt >= (NOTICE_S - 1) * 1000, `server A waited the notice (${((exitA.at - termAt) / 1000).toFixed(1)} s >= ${NOTICE_S - 1} s)`);
  await until(() => lastSeen().net === RESTART_TEXT, 20_000, `net status did not become "${RESTART_TEXT}"`);
  log(`net status: "${RESTART_TEXT}"`);

  const banners = seen.filter((e) => e.banner !== null);
  const secs = (t) => { const m = /in (\d+):(\d\d)$/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : t.endsWith('jetzt') ? 0 : NaN; };
  const shown = [];
  for (const e of banners) if (shown[shown.length - 1]?.text !== e.banner || shown[shown.length - 1]?.soon !== e.soon) shown.push({ text: e.banner, soon: e.soon, s: secs(e.banner) });
  console.log(`banner: ${shown.map((b) => `${b.s}${b.soon ? '!' : ''}`).join(' ')}`);
  check(shown.length > 0 && (shown[0].s === NOTICE_S || shown[0].s === NOTICE_S - 1), `countdown starts at 0:${NOTICE_S} or 0:${NOTICE_S - 1} (first: "${shown[0]?.text}")`);
  check(shown.every((b, i) => i === 0 || b.s <= shown[i - 1].s), 'countdown never goes up');
  check(shown.every((b) => b.soon === (b.s <= 10)), 'highlighted exactly from 0:10 on');
  check(shown.some((b) => b.s === 10 && b.soon), 'saw 0:10 highlighted');
  check(shown.some((b) => b.s <= 2), 'counted down to the end');
  check(shown.every((b) => b.text.startsWith('Die Stadt wird aktualisiert – ')), 'banner text');
  check(navigations.length === 0, 'no reload while the server is down');

  // ---- the new server: the page reloads by itself ----
  server = startServer('server B');
  const readyAt = await serverUp('server B');
  const navAt = await until(() => navigations[0], POLL_MAX_MS + JITTER_MAX_MS + 5000, 'the page did not reload by itself', 20).catch(() => null);
  const seenAt = pagePolls.find((p) => p.at >= readyAt - 1000)?.at ?? null;
  const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
  // the page's timers run late by its main-thread stalls (a headless renderer under load): they extend both limits
  const pollLate = seenAt === null ? 0 : stalledMs(readyAt - 2000, seenAt);
  const waitLate = seenAt === null || navAt === null ? 0 : stalledMs(seenAt, navAt);
  log(`server B answered → page's poll saw it ${seenAt === null ? 'never' : sec(seenAt - readyAt)} (page stalled ${sec(pollLate)}) → reload ${navAt === null || seenAt === null ? '-' : sec(navAt - seenAt)} (page stalled ${sec(waitLate)}); total ${navAt === null ? '-' : sec(navAt - readyAt)}`);
  check(navAt !== null, 'the page reloaded by itself');
  check(seenAt !== null && seenAt - readyAt <= POLL_MAX_MS + pollLate, `the page's poll saw server B within ${sec(POLL_MAX_MS)} + stalls`);
  check(navAt !== null && seenAt !== null && navAt - seenAt <= JITTER_MAX_MS + waitLate, `reload within ${sec(JITTER_MAX_MS)} + stalls after that (random wait 0–5 s)`);
  if (navAt === null) throw new Error('no reload');
  await page.waitForLoadState('load', { timeout: 60_000 });
  check((await page.evaluate(() => window.__rcMarker)) === undefined, 'the marker on window is gone (a real page load)');

  // ---- Gegenprobe: a crash without announcement ----
  await join(page, 'Restart Check', true);
  log('joined again after the reload');
  seen.length = 0;
  const navBefore = navigations.length;
  process.kill(server.pid, 'SIGKILL');
  log(`kill -KILL ${server.pid}`);
  await server.exited;
  await until(() => seen.some((e) => e.net === RECONNECTING_TEXT), 20_000, `net status did not become "${RECONNECTING_TEXT}"`);
  log(`net status: "${RECONNECTING_TEXT}"`);
  await until(() => lastSeen().net === LOST_TEXT, 30_000, `net status did not become "${LOST_TEXT}"`);
  log(`net status: "${LOST_TEXT}"`);
  server = startServer('server C');
  await serverUp('server C');
  await sleep(15_000);
  check(seen.every((e) => e.banner === null), 'Gegenprobe: no banner');
  check(seen.every((e) => e.net !== RESTART_TEXT), `Gegenprobe: never "${RESTART_TEXT}"`);
  check(lastSeen().net === LOST_TEXT, `Gegenprobe: still "${LOST_TEXT}"`);
  check(navigations.length === navBefore, 'Gegenprobe: no reload (15 s after server C answered)');
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser?.close().catch(() => undefined);
  // SIGTERM first (Vite stops its helpers; a server without players shuts down at once), SIGKILL after 5 s
  await Promise.all([...children].map(async (c) => {
    try { process.kill(c.pid, 'SIGTERM'); } catch { /* already gone */ }
    if (await Promise.race([c.exited, sleep(5000).then(() => null)])) return;
    try { process.kill(c.pid, 'SIGKILL'); } catch { /* already gone */ }
    await c.exited;
  }));
}
log(failed ? 'restart-check: FAILED' : 'restart-check: OK');
process.exit(failed ? 1 : 0);
