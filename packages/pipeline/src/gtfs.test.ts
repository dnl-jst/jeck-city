import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gtfsCalendar, gtfsSampleDays, loadGtfsTrips } from './gtfs';
import { GTFS_FIXTURE } from './raw/zipfixture';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nn-gtfs-')); });
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

const FEED = [{ start: 20261101, end: 20261231 }, { start: 20261115, end: 20270131 }];

it('gtfsSampleDays: from Wed 2026-11-25 with a feed valid 20261101–20270131 → [20261201, 20261128, 20261129]', () => {
  expect(gtfsSampleDays(FEED, new Date(2026, 10, 25))).toEqual([20261201, 20261128, 20261129]);
  // a sample day may be `from` itself (Tuesday 2026-11-24), and the time of day does not matter
  expect(gtfsSampleDays(FEED, new Date(2026, 10, 24, 23, 59))).toEqual([20261124, 20261128, 20261129]);
  // before the feed starts: the first days inside it
  expect(gtfsSampleDays(FEED, new Date(2026, 9, 1))).toEqual([20261103, 20261107, 20261101]);
});

it('gtfsSampleDays throws when the feed ended before `from`', () => {
  expect(() => gtfsSampleDays(FEED, new Date(2027, 1, 1))).toThrow(/20261101–20270131/);
  // a feed ending on a Monday covers no Tuesday after that Monday's Sunday
  expect(() => gtfsSampleDays([{ start: 20261101, end: 20261130 }], new Date(2026, 10, 25))).toThrow(/day of the week 2/);
  expect(() => gtfsSampleDays([], new Date(2026, 10, 25))).toThrow(/gtfs/);
});

it('gtfsCalendar reads the validity of every service from calendar.txt', () => {
  expect(gtfsCalendar(GTFS_FIXTURE['calendar.txt']!)).toEqual([{ start: 20261101, end: 20270131 }, { start: 20261101, end: 20270131 }]);
});

async function writeFeed(): Promise<string> {
  const feed = join(dir, 'feed');
  await mkdir(feed);
  for (const [name, text] of Object.entries(GTFS_FIXTURE)) await writeFile(join(feed, name), text);
  return feed;
}

const DAYS: [number, number, number] = [20261201, 20261128, 20261129];
const everywhere = () => true;

it('loadGtfsTrips gives the same trips for the same days whatever the current date', async () => {
  const feed = await writeFeed();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 25));
  const a = await loadGtfsTrips(feed, ['13'], everywhere, join(dir, 'a.json'), DAYS, 'feedhash');
  vi.setSystemTime(new Date(2027, 5, 1)); // after the feed ended
  const b = await loadGtfsTrips(feed, ['13'], everywhere, join(dir, 'b.json'), DAYS, 'feedhash');
  expect(b).toEqual(a);
  // t1 runs daily but not on Sunday 20261129 (removed), t2 on the weekday only; t3 is another line
  expect(a.map((t) => [t.headsign, t.days, t.stops.map((s) => s.t)])).toEqual([
    ['Sülzgürtel', 0b011, [8 * 3600 + 30, 8 * 3600 + 120]],
    ['Holweide', 0b001, [9 * 3600, 9 * 3600 + 120]],
  ]);
});

it('loadGtfsTrips reuses its cache only for the same feed hash, lines and days', async () => {
  const feed = await writeFeed();
  const cache = join(dir, 'trips.json');
  const first = await loadGtfsTrips(feed, ['13'], everywhere, cache, DAYS, 'feedhash');
  const stamp = (JSON.parse(await readFile(cache, 'utf8')) as { stamp: string }).stamp;
  expect(stamp).toContain('feedhash');
  // a doctored cache with the same key is returned as is …
  await writeFile(cache, JSON.stringify({ stamp, trips: [] }));
  expect(await loadGtfsTrips(feed, ['13'], everywhere, cache, DAYS, 'feedhash')).toEqual([]);
  // … but another feed or other days are read from the tables again
  expect(await loadGtfsTrips(feed, ['13'], everywhere, cache, DAYS, 'otherfeed')).toEqual(first);
  await writeFile(cache, JSON.stringify({ stamp: (JSON.parse(await readFile(cache, 'utf8')) as { stamp: string }).stamp, trips: [] }));
  const otherDays = await loadGtfsTrips(feed, ['13'], everywhere, cache, [20261208, 20261205, 20261206], 'otherfeed');
  expect(otherDays.map((t) => t.days)).toEqual([0b111, 0b001]);
});

it('loadGtfsTrips rejects sample days the feed does not cover', async () => {
  const feed = await writeFeed();
  await expect(loadGtfsTrips(feed, ['13'], everywhere, join(dir, 'c.json'), [20270202, 20261128, 20261129], 'feedhash')).rejects.toThrow(/20270202/);
});
