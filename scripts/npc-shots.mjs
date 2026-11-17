// Usage: npm run npc-shots -- <base url> [wait s]
// Screenshots of NPCs at a few places (offline: the local NPC director), host GPU like screenshot.mjs.
// Each place: ?offline=1&debug=1&cam=x,y,z,yaw,pitch, wait for the world, then `wait` seconds for NPCs to appear.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { browserArgs } from './browser-args.mjs';

const [base, waitArg] = process.argv.slice(2);
if (!base) {
  console.error('usage: npm run npc-shots -- <base url> [wait s]');
  process.exit(2);
}
const wait = Number(waitArg ?? 14) * 1000;
/** name → camera (x, y, z, yaw°, pitch°); y is the eye height above the ground there. */
const places = (process.env.NN_SHOTS ?? 'spawn').split(',');
const CAMS = {
  // looking along Neusser Straße at the spawn
  spawn: null,
  // the signalled junction south of the spawn, from above
  junction: '128,18,-60,200,-35',
  // the signalled junction just south of the spawn, looking south over it
  signals: '131,3.5,10,0,-6',
};
mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ args: browserArgs });
try {
  for (const name of places) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
    const u = new URL(base);
    u.searchParams.set('offline', '1');
    u.searchParams.set('debug', '1');
    if (CAMS[name]) u.searchParams.set('cam', CAMS[name]);
    if (process.env.NN_TIME) u.searchParams.set('time', process.env.NN_TIME);
    await page.goto(u.href);
    await page.waitForFunction(() => window.__nnReady !== undefined, null, { timeout: 180_000 });
    if ((await page.evaluate(() => window.__nnReady)) !== true) throw new Error('world failed to load');
    await page.waitForTimeout(wait);
    const out = `shots/npc-${name}${process.env.NN_TIME ? '-' + process.env.NN_TIME.replace(':', '') : ''}.png`;
    await page.screenshot({ path: out });
    console.log(`saved ${out}`);
    await page.close();
  }
} finally {
  await browser.close();
}
