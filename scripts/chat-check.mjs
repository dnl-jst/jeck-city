// Usage: npm run chat-check -- [baseUrl]
// Needs the dev stack running (npm run dev: game server in dev mode + Vite; baseUrl defaults to http://localhost:5173/).
// Two headless Chromium contexts join as "Chat A" and "Chat B" (name dialog) and must both see (at least) 2 players. Then:
//  1. A: Enter, "/w treffen am Dom?", Enter → B gets the world line.
//  2. A: Enter, "wasd", Enter → A did not move (the keys went to the chat field), the channel stayed world (B gets it as 'w').
//  3. A is teleported in front of B's camera; A: Enter, "/s hallo", Enter → B gets the say line and shows 1 bubble.
//     Screenshots shots/chat-a.png, shots/chat-b.png.
//  4. B leaves; a touch context "Chat C" (?touch=1): the chat button is visible, gets the unread dot on a new line, its tap opens
//     the sheet (controls suspended), tab "Welt", text, "Senden" → A gets the world line. Screenshot shots/chat-touch.png.
//  5. Offline (?offline=1&touch=1): no chat button, no chat window, no chat hook.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const SHOTS = 'shots';
mkdirSync(SHOTS, { recursive: true });

function pageUrl(extra = {}) {
  const url = new URL(base);
  url.searchParams.set('time', '14:00');
  url.searchParams.set('date', '2026-06-15');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.href;
}

/** Opens the game, answers the name dialog and waits until the world is ready and the player is online. */
async function join(browser, name, { touch = false } = {}) {
  const ctx = await browser.newContext(touch
    ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error] ${e.message}`));
  await page.goto(pageUrl(touch ? { touch: '1' } : {}));
  // the intro: its start layer (it closes itself when autoplay turns out to be allowed, so it may be gone), then
  // "Weiter". Clicks dispatched on the elements: with two games already running the third page draws so few frames
  // that Playwright's stability wait for a real click times out.
  const start = page.locator('.nn-intro-start:not(.nn-leaving)');
  if (await start.count()) await start.dispatchEvent('click').catch(() => undefined);
  await page.locator('.nn-intro-go').dispatchEvent('click');
  await page.locator('.nn-lobby-input').fill(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 300_000 });
  if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error(`${name}: world failed to load`);
  await page.waitForFunction(() => window.__nnState().online, null, { timeout: 60_000 });
  return { page, name };
}

/**
 * Waits until `page` has a chat line matching (c, text) from `from` (or "from 2" etc.: a seat of an earlier run still
 * held for its reconnect makes the server number the name).
 */
async function waitLine(page, c, text, from, what) {
  try {
    await page.waitForFunction(([c, text, from]) => window.__nnChat.lines().some((l) => l.c === c && l.text === text && (l.name === from || l.name.startsWith(`${from} `))),
      [c, text, from], { timeout: 10_000 });
  } catch {
    const lines = await page.evaluate(() => window.__nnChat?.lines());
    throw new Error(`${what}: no line ${JSON.stringify({ c, text, from })}; lines: ${JSON.stringify(lines)}`);
  }
}

/** Desktop chat: Enter opens the window, the text is typed into its field, Enter sends. */
async function chat(page, text) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.classList.contains('nn-chat-input'), null, { timeout: 5_000 });
  await page.keyboard.type(text, { delay: 30 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.activeElement?.classList.contains('nn-chat-input'), null, { timeout: 5_000 });
}

/** Resolves after `n` more animation frames (= game frames; a busy machine may render only a few per second). */
const frames = (page, n) => page.evaluate((n) => new Promise((done) => {
  const f = () => (--n <= 0 ? done() : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n);

const browser = await chromium.launch({ args: browserArgs });
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};
try {
  const a = await join(browser, 'Chat A');
  const b = await join(browser, 'Chat B');
  for (const p of [a, b]) await p.page.waitForFunction(() => window.__nnState().players >= 2, null, { timeout: 30_000 });
  console.log('both see 2 players or more');
  // let A settle at the spawn (standing still) before the movement check
  await a.page.waitForTimeout(1500);

  // 1. world line
  await chat(a.page, '/w treffen am Dom?');
  await waitLine(b.page, 'w', 'treffen am Dom?', 'Chat A', '1. world line');
  check(true, '1. B got the world line');

  // 2. typing WASD into the chat does not move A; the channel stays world
  const before = await a.page.evaluate(() => window.__nnState());
  await chat(a.page, 'wasd');
  await a.page.waitForTimeout(500);
  const after = await a.page.evaluate(() => window.__nnState());
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  check(moved < 0.1, `2. A did not move while typing (${moved.toFixed(3)} m)`);
  await waitLine(b.page, 'w', 'wasd', 'Chat A', '2. channel stays world');
  check(true, '2. channel stayed world');

  // 3. say line and bubble: A stands 6 m in front of B's camera first (dev server teleport)
  const sb = await b.page.evaluate(() => window.__nnState());
  const tx = sb.x + Math.sin(sb.yaw) * 6, tz = sb.z + Math.cos(sb.yaw) * 6;
  await a.page.evaluate(([x, z]) => window.__nnConn().sendTeleport(x, z), [tx, tz]);
  await a.page.waitForFunction(([x, z]) => { const s = window.__nnState(); return Math.hypot(s.x - x, s.z - z) < 1.5; }, [tx, tz], { timeout: 10_000 });
  await b.page.waitForTimeout(1000);
  await chat(a.page, '/s hallo');
  await waitLine(b.page, 's', 'hallo', 'Chat A', '3. say line');
  check(true, '3. B got the say line');
  const bubbles = await b.page.evaluate(() => window.__nnChat.bubbles());
  check(bubbles === 1, `3. B shows ${bubbles} bubble(s) (want 1)`);
  // screenshots once a frame has drawn the line and the bubble, B's first: the bubble lasts only about 6 s, and a
  // busy machine renders the game at a frame or so per second (a screenshot then takes seconds)
  await frames(b.page, 1);
  await b.page.screenshot({ path: `${SHOTS}/chat-b.png` });
  await a.page.screenshot({ path: `${SHOTS}/chat-a.png` });

  // 4. touch: button, unread dot, sheet, send on the world channel. B leaves first: a third game in the same
  // headless browser loads very slowly next to two running ones.
  await b.page.context().close();
  const c = await join(browser, 'Chat C', { touch: true });
  await c.page.waitForFunction(() => window.__nnState().players >= 2, null, { timeout: 30_000 });
  const btn = c.page.locator('.nn-tc-sys .nn-tc-btn', { hasText: 'Chat' });
  check(await btn.isVisible(), '4. chat button visible online');
  check(!(await btn.evaluate((e) => e.classList.contains('nn-unread'))), '4. no unread dot before a line');
  await chat(a.page, '/w hallo C');
  await waitLine(c.page, 'w', 'hallo C', 'Chat A', '4. C gets the world line');
  check(await btn.evaluate((e) => e.classList.contains('nn-unread')), '4. unread dot on a new line while the sheet is closed');
  await btn.tap();
  await c.page.locator('.nn-chat-sheet.nn-chat-sheet-open').waitFor({ timeout: 5_000 });
  check(true, '4. sheet open');
  check(await c.page.evaluate(() => document.querySelector('.nn-tc').classList.contains('nn-suspended')), '4. touch controls suspended while the sheet is open');
  check(!(await btn.evaluate((e) => e.classList.contains('nn-unread'))), '4. unread dot gone once the sheet is open');
  await c.page.locator('.nn-chat-sheet-tab', { hasText: 'Welt' }).tap();
  await c.page.locator('.nn-chat-sheet-input').fill('vom Handy');
  await c.page.locator('.nn-chat-sheet-send').tap();
  await waitLine(a.page, 'w', 'vom Handy', 'Chat C', '4. A gets the touch world line');
  check(true, '4. A got the world line from the sheet');
  await frames(c.page, 2);
  await c.page.screenshot({ path: `${SHOTS}/chat-touch.png` });
  await c.page.locator('.nn-chat-sheet-close').tap();
  check(!(await c.page.evaluate(() => document.querySelector('.nn-tc').classList.contains('nn-suspended'))), '4. touch controls back after closing the sheet');

  // 5. offline: no chat at all (the online pages go first, as for C)
  await Promise.all([a.page.context().close(), c.page.context().close()]);
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const off = await ctx.newPage();
  off.on('pageerror', (e) => console.error(`[offline page error] ${e.message}`));
  await off.goto(pageUrl({ offline: '1', touch: '1' }));
  await off.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 300_000 });
  check(!(await off.locator('.nn-tc-sys .nn-tc-btn', { hasText: 'Chat' }).isVisible()), '5. chat button hidden offline');
  check(await off.evaluate(() => !document.querySelector('.nn-chat, .nn-chat-sheet') && window.__nnChat === undefined), '5. no chat window, sheet or hook offline');
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
}
console.log(failed ? 'chat-check FAILED' : 'chat-check PASSED');
process.exit(failed ? 1 : 0);
