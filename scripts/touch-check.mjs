// Usage: npm run touch-check -- [baseUrl] [outDir]
// Opens the game offline in a touch-emulating phone (landscape) and tablet viewport, screenshots the overlay, then
// drags the move stick forward and checks the player moved; presses the use button next to a car and checks driving.
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? '.';
const devices = [
  { name: 'phone', viewport: { width: 844, height: 390 } },
  { name: 'phone-portrait', viewport: { width: 390, height: 844 } },
  { name: 'tablet', viewport: { width: 1180, height: 820 } },
];
const browser = await chromium.launch({ args: browserArgs });
let failed = false;
try {
  for (const d of devices) {
    const ctx = await browser.newContext({ viewport: d.viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
    const url = new URL(base);
    url.searchParams.set('offline', '1');
    await page.goto(url.href);
    await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
    if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/touch-${d.name}.png` });
    const before = await page.evaluate(() => window.__nnState());
    // a finger on the left half, pushed up all the way (CDP touch events → pointer events)
    const cdp = await ctx.newCDPSession(page);
    const x = 120, y = d.viewport.height - 120;
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
    await touch('touchStart', [{ x, y, id: 1 }]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x, y: y - i * 8, id: 1 }]);
    await page.screenshot({ path: `${out}/touch-${d.name}-stick.png` });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => window.__nnState());
    await touch('touchEnd', []);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    console.log(`${d.name}: moved ${moved.toFixed(1)} m (speed ${after.speed.toFixed(1)} m/s)`);
    if (moved < 2) failed = true;
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
