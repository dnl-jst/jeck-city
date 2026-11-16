/**
 * Load test against a dev server (devTeleport must be allowed):
 *   npm run loadtest -- [--url ws://localhost:2567] [--bots 100] [--minutes 10] [--seed 1]
 * Bots: 50 % walk, 40 % drive, 10 % ride (per ten bots), all teleported within 300 m of the spawn. Every 10 s /healthz is polled.
 * At the end a table; the exit code is 1 when a criterion of spec 13.5 is missed. The server needs NN_JOIN_PER_MIN
 * raised (all bots join from one address); it reads the world from the same files as the server (NN_WORLD_DIR).
 */
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { parseManifest, worldHash, type WorldManifest } from '@nn/shared';
import { loadConfig } from '../config';
import { connectBot, prng, type BotRole, type ConnectedBot, type VehicleSpot } from './bot';

const AREA_RADIUS = 300;
const POLL_S = 10;
/** Seconds after its join before a bot's received bytes count (the join sends the full slow state once). */
const BYTES_SKIP_S = 5;
/** Seconds after the last join before tick times count. */
const SETTLE_S = 20;
const LIMITS = { tickP95Ms: 8, droppedPct: 1, kbPerS: 50, rssGrowthPct: 10 };

type Health = { players: number; tickP95Ms: number; dropped: number; ticks: number; droppedTotal: number; rssMb: number };
type Sample = { t: number; h: Health; connected: number; modes: string; kbps: number };

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:2567' },
    bots: { type: 'string', default: '100' },
    minutes: { type: 'string', default: '10' },
    seed: { type: 'string', default: '1' },
  },
});
const url = args.url!;
const nBots = Number(args.bots);
const minutes = Number(args.minutes);
const seed = Number(args.seed);
const httpUrl = url.replace(/^ws/, 'http');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
};
const fmt = (v: number, d = 2) => v.toFixed(d);

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function health(): Promise<Health> {
  const r = await fetch(`${httpUrl}/healthz`);
  return (await r.json()) as Health;
}

/** Bot roles and starting points: walkers next to a parked car, drivers and riders each with their own vehicles. */
function plan(m: WorldManifest, rng: () => number): { role: BotRole; start: { x: number; z: number }; vehicles: VehicleSpot[] }[] {
  const home = m.spawn;
  const near = <T extends { x: number; z: number }>(xs: T[]) => xs.filter((v) => Math.hypot(v.x - home.x, v.z - home.z) <= AREA_RADIUS);
  const cars = shuffle(near(m.parked), rng);
  const bikes = shuffle(near(m.bikes), rng);
  // interleaved, so no two bots of a kind aim for the same vehicle first
  const spots = (pool: { x: number; z: number; heading: number }[], k: number, n: number): VehicleSpot[] =>
    pool.filter((_, i) => i % n === k).map(({ x, z, heading }) => ({ x, z, heading }));
  const out: ReturnType<typeof plan> = [];
  for (let i = 0; i < nBots; i++) {
    // per ten bots: 5 walk, 4 drive, 1 ride
    const k = i % 10;
    const role: BotRole = k === 9 ? 'ride' : k % 2 === 0 ? 'walk' : 'drive';
    const c = cars[Math.floor(rng() * cars.length)]!;
    const side = rng() < 0.5 ? 3 : -3;
    out.push({ role, start: { x: c.x + side * Math.cos(c.heading), z: c.z - side * Math.sin(c.heading) }, vehicles: [] });
  }
  const drivers = out.filter((b) => b.role === 'drive'), riders = out.filter((b) => b.role === 'ride');
  drivers.forEach((b, k) => { b.vehicles = spots(cars, k, drivers.length); });
  riders.forEach((b, k) => { b.vehicles = spots(bikes, k, riders.length); });
  return out;
}

async function main(): Promise<number> {
  const cfg = loadConfig(process.env);
  const bytes = readFileSync(`${cfg.worldDir}/manifest.json`);
  const manifest = parseManifest(JSON.parse(bytes.toString('utf8')));
  const hash = await worldHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const rng = prng(seed);
  const roles = plan(manifest, rng);
  const home = { x: manifest.spawn.x, z: manifest.spawn.z };
  const count = (r: BotRole) => roles.filter((b) => b.role === r).length;
  console.log(`load test: ${nBots} bots (${count('walk')} walk, ${count('drive')} drive, ${count('ride')} ride) against ${url} for ${minutes} min`);

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const bots: (ConnectedBot & { leftCode: number | null })[] = [];
  const t0 = performance.now();
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i]!;
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await connectBot(url, `Bot ${i + 1}`, hash, { role: r.role, seed: seed * 1000 + i, home, start: r.start, vehicles: r.vehicles });
        const entry = { ...c, leftCode: null as number | null };
        void c.left.then((code) => { entry.leftCode = code; });
        c.bot.start();
        bots.push(entry);
        break;
      } catch (e) {
        if (attempt >= 4) throw new Error(`bot ${i + 1} could not join: ${String(e)}`);
        await sleep(2000);
      }
    }
    await sleep(100);
  }
  console.log(`all joined after ${fmt((performance.now() - t0) / 1000, 1)} s; settling ${SETTLE_S} s`);
  await sleep(SETTLE_S * 1000);

  const start = await health();
  const tStart = performance.now();
  const samples: Sample[] = [];
  const bytesAt = () => bots.map((b) => b.bot.bytesPerSecond().reduce((a, v) => a + v, 0));
  let lastBytes = bytesAt();
  const end = tStart + minutes * 60_000;
  console.log('   t s | players | tick p95 ms | dropped | rss MB | bots | modes w/d/x/r | KB/s per bot');
  while (performance.now() < end) {
    await sleep(Math.min(POLL_S * 1000, end - performance.now()));
    const h = await health();
    const now = bytesAt();
    const connected = bots.filter((b) => b.leftCode === null).length;
    const kbps = now.reduce((a, v, i) => a + v - lastBytes[i]!, 0) / Math.max(1, connected) / POLL_S / 1024;
    lastBytes = now;
    const m = [0, 1, 2, 3].map((k) => bots.filter((b) => b.leftCode === null && b.bot.mode === k).length).join('/');
    const s: Sample = { t: (performance.now() - tStart) / 1000, h, connected, modes: m, kbps };
    samples.push(s);
    console.log(`${fmt(s.t, 0).padStart(6)} | ${String(h.players).padStart(7)} | ${fmt(h.tickP95Ms).padStart(11)} | ${String(h.dropped).padStart(7)} | ${String(h.rssMb).padStart(6)} | ${String(connected).padStart(4)} | ${m.padStart(13)} | ${fmt(kbps, 1)}`);
  }
  loop.disable();

  for (const b of bots) b.bot.stop();
  const last = samples.at(-1)!.h;
  const ticks = last.ticks - start.ticks;
  const dropped = last.droppedTotal - start.droppedTotal;
  const droppedPct = (100 * dropped) / Math.max(1, ticks + dropped);
  const tickP95s = samples.map((s) => s.h.tickP95Ms);
  // per bot and second, from BYTES_SKIP_S after its join to the end of the measurement
  const perSecond: number[] = [];
  const perBotP95: number[] = [];
  for (const b of bots) {
    const secs = b.bot.bytesPerSecond().slice(BYTES_SKIP_S);
    perSecond.push(...secs);
    perBotP95.push(p95(secs));
  }
  const kbP95 = p95(perSecond) / 1024;
  const at2 = samples.find((s) => s.t >= 120);
  const rssGrowthPct = at2 && minutes >= 3 ? (100 * (last.rssMb - at2.h.rssMb)) / at2.h.rssMb : null;
  const disconnected = bots.filter((b) => b.leftCode !== null).length;
  const sentPerS = bots.reduce((a, b) => a + b.bot.inputsSent, 0) / bots.length / ((performance.now() - t0) / 1000);

  const rows: [string, string, string, boolean][] = [
    ['tick p95 (p95 of 10 s windows)', `${fmt(p95(tickP95s))} ms (max ${fmt(Math.max(...tickP95s))})`, `< ${LIMITS.tickP95Ms} ms`, p95(tickP95s) < LIMITS.tickP95Ms],
    ['dropped ticks', `${dropped} of ${ticks + dropped} (${fmt(droppedPct, 3)} %)`, `< ${LIMITS.droppedPct} %`, droppedPct < LIMITS.droppedPct],
    ['bandwidth p95 per client', `${fmt(kbP95, 1)} KB/s (worst client p95 ${fmt(Math.max(...perBotP95) / 1024, 1)})`, `< ${LIMITS.kbPerS} KB/s`, kbP95 < LIMITS.kbPerS],
    ['RSS minute 2 → end', rssGrowthPct === null ? `n/a (run ≥ 3 min), end ${last.rssMb} MB` : `${at2!.h.rssMb} → ${last.rssMb} MB (${fmt(rssGrowthPct, 1)} %)`, `< ${LIMITS.rssGrowthPct} %`, rssGrowthPct === null || rssGrowthPct < LIMITS.rssGrowthPct],
    ['bots still connected', `${bots.length - disconnected} of ${bots.length}`, 'all', disconnected === 0],
  ];
  console.log('\n| criterion | measured | limit | ok |\n|---|---|---|---|');
  for (const [name, v, lim, ok] of rows) console.log(`| ${name} | ${v} | ${lim} | ${ok ? 'yes' : 'NO'} |`);
  console.log(`\nbot process: ${fmt(sentPerS, 1)} inputs/s per bot sent, event loop delay p99 ${fmt(loop.percentile(99) / 1e6, 1)} ms`);

  await Promise.all(bots.map((b) => b.room.leave().catch(() => 0)));
  return rows.every((r) => r[3]) ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e);
  process.exit(2);
});
