import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TRAIN_LENGTH, wgs84ToLocal, type Transit } from '@nn/shared';

/**
 * The real timetable: VRS's open GTFS feed (data/raw/gtfs, see fetchGtfs) for the Stadtbahn lines, read into the trips
 * of three sample days (a weekday, a Saturday, a Sunday) and matched to the line paths of the network.
 */
export const GTFS_URL = 'https://download.vrs.de/gtfs/google_transit_goR.zip';
const FILES = ['routes.txt', 'trips.txt', 'calendar.txt', 'calendar_dates.txt', 'stops.txt', 'stop_times.txt'];

/** A trip of a line on the sample days it runs on (bit 0 weekday, 1 Saturday, 2 Sunday), with its stops: position and time (s after the service day's midnight). */
export type GtfsTrip = { line: string; days: number; headsign: string; stops: { x: number; z: number; t: number }[] };

/** One CSV line into fields (quotes with doubled quotes inside). */
export function csvFields(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Reads a GTFS table line by line: `row` gets each record as a function from column name to value. */
async function table(file: string, row: (get: (col: string) => string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let cols: Map<string, number> | null = null, fields: string[] = [];
  const get = (c: string) => fields[cols!.get(c) ?? -1] ?? '';
  for await (const raw of rl) {
    const line = cols ? raw : raw.replace(/^﻿/, '');
    if (!line) continue;
    fields = csvFields(line);
    if (!cols) { cols = new Map(fields.map((c, i) => [c.trim(), i])); continue; }
    row(get);
  }
}

const ymd = (d: Date) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

/**
 * The trips of `lines` (KVB Stadtbahn: route ids de:vrs:<line>:104) on three sample days: the first Tuesday, Saturday
 * and Sunday from `from` on that the feed covers. Stops outside `keep` are left out. Cached in `cache` until the feed
 * changes (stop_times.txt has 400 MB).
 */
export async function loadGtfsTrips(dir: string, lines: string[], keep: (x: number, z: number) => boolean, cache: string, from = new Date()): Promise<GtfsTrip[]> {
  for (const f of FILES) if (!existsSync(join(dir, f))) throw new Error(`gtfs: ${join(dir, f)} is missing`);
  const stamp = `${(await stat(join(dir, 'stop_times.txt'))).mtimeMs}|${lines.join(',')}`;
  if (existsSync(cache)) {
    const c = JSON.parse(await readFile(cache, 'utf8')) as { stamp: string; trips: GtfsTrip[] };
    if (c.stamp === stamp) return c.trips;
  }
  const routes = new Map(lines.map((l) => [`de:vrs:${l}:104`, l]));
  // service → weekday flags and validity; removals per service
  const cal = new Map<string, { flags: number[]; start: number; end: number }>();
  await table(join(dir, 'calendar.txt'), (g) => {
    cal.set(g('service_id'), {
      flags: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => Number(g(d))), start: Number(g('start_date')), end: Number(g('end_date')),
    });
  });
  const removed = new Set<string>();
  await table(join(dir, 'calendar_dates.txt'), (g) => { if (g('exception_type') === '2') removed.add(`${g('service_id')}|${g('date')}`); });
  // the sample days: the first Tuesday, Saturday, Sunday from `from` on inside the feed's validity
  let lo = Infinity, hi = -Infinity;
  for (const c of cal.values()) { lo = Math.min(lo, c.start); hi = Math.max(hi, c.end); }
  const sample = [2, 6, 0].map((weekday) => {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    for (let k = 0; k < 400; k++, d.setDate(d.getDate() + 1)) if (d.getDay() === weekday && ymd(d) >= lo && ymd(d) <= hi) return { weekday, date: ymd(d) };
    throw new Error(`gtfs: the feed (valid ${lo}–${hi}) covers no day of the week ${weekday} from today on: download a current one`);
  });
  const runsOn = (service: string): number => {
    const c = cal.get(service);
    if (!c) return 0;
    return sample.reduce((m, s, i) => m | (c.flags[s.weekday] && s.date >= c.start && s.date <= c.end && !removed.has(`${service}|${s.date}`) ? 1 << i : 0), 0);
  };
  const trips = new Map<string, GtfsTrip>();
  await table(join(dir, 'trips.txt'), (g) => {
    const line = routes.get(g('route_id'));
    if (!line) return;
    const days = runsOn(g('service_id'));
    if (days) trips.set(g('trip_id'), { line, days, headsign: g('trip_headsign'), stops: [] });
  });
  const stops = new Map<string, { x: number; z: number }>();
  await table(join(dir, 'stops.txt'), (g) => { stops.set(g('stop_id'), wgs84ToLocal(Number(g('stop_lat')), Number(g('stop_lon')))); });
  const seq = new Map<GtfsTrip, number[]>();
  await table(join(dir, 'stop_times.txt'), (g) => {
    const trip = trips.get(g('trip_id'));
    if (!trip) return;
    const p = stops.get(g('stop_id'));
    if (!p || !keep(p.x, p.z)) return;
    const [h, m, s] = (g('departure_time') || g('arrival_time')).split(':').map(Number) as [number, number, number];
    trip.stops.push({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, t: h * 3600 + m * 60 + (s || 0) });
    let order = seq.get(trip);
    if (!order) seq.set(trip, (order = []));
    order.push(Number(g('stop_sequence')));
  });
  const out: GtfsTrip[] = [];
  for (const trip of trips.values()) {
    const order = seq.get(trip);
    if (!order || trip.stops.length < 2) continue;
    const idx = order.map((_, i) => i).sort((a, b) => order[a]! - order[b]!);
    out.push({ ...trip, stops: idx.map((i) => trip.stops[i]!) });
  }
  await writeFile(cache, JSON.stringify({ stamp, trips: out }));
  return out;
}

/** A stop of a trip belongs to a path's stop within this distance (m; GTFS gives the platform's middle, OSM the stop position on the track). */
const STOP_MATCH = 90;

/**
 * Gives every line path its timetable: each trip goes to a path of its line that serves its stops in the trip's order
 * (the first that fits; branches of a line share their way through the play area). Paths without any trip keep the
 * makeshift headway. Returns how many trips were placed and how many found no path.
 */
export function applyTimetable(tracks: Transit['tracks'], trips: GtfsTrip[]): { placed: number; lost: number } {
  // where each path's stops are
  const stopAt = tracks.map((tr) => {
    const cum = [0];
    for (let i = 3; i < tr.pts.length; i += 3) cum.push(cum[cum.length - 1]! + Math.hypot(tr.pts[i]! - tr.pts[i - 3]!, tr.pts[i + 1]! - tr.pts[i - 2]!, tr.pts[i + 2]! - tr.pts[i - 1]!));
    return tr.stops.map((st) => {
      const i = Math.max(0, cum.findIndex((c) => c >= st.s));
      return { x: tr.pts[i * 3]!, z: tr.pts[i * 3 + 2]! };
    });
  });
  type Days = [number[], number[], number[]];
  const patterns: Map<string, number>[] = tracks.map(() => new Map()), lists: Days[] = tracks.map(() => [[], [], []]);
  const table: number[][][] = tracks.map(() => []);
  let placed = 0, lost = 0;
  for (const trip of trips) {
    let done = false;
    for (let k = 0; k < tracks.length && !done; k++) {
      if (tracks[k]!.line !== trip.line) continue;
      // the trip's time at each stop of the path (−1: not served), going through the path's stops in order
      const times = new Array<number>(stopAt[k]!.length).fill(-1);
      let from = 0, served = 0, ordered = true;
      for (const st of trip.stops) {
        let hit = -1;
        for (let j = 0; j < stopAt[k]!.length; j++) {
          if (Math.hypot(stopAt[k]![j]!.x - st.x, stopAt[k]![j]!.z - st.z) <= STOP_MATCH && (hit < 0 || Math.abs(j - from) < Math.abs(hit - from))) hit = j;
        }
        if (hit < 0) continue;
        if (hit < from) { ordered = false; break; }
        if (times[hit]! < 0) { times[hit] = st.t; served++; }
        from = hit;
      }
      if (!ordered || served < 2 || served < Math.min(3, stopAt[k]!.length)) continue;
      const first = times.find((t) => t >= 0)!;
      const rel = times.map((t) => (t < 0 ? -1 : t - first)), key = rel.join(',');
      let p = patterns[k]!.get(key);
      if (p === undefined) { p = table[k]!.push(rel) - 1; patterns[k]!.set(key, p); }
      for (let d = 0; d < 3; d++) if (trip.days & (1 << d)) lists[k]![d]!.push(p, first);
      done = true;
      placed++;
    }
    if (!done) lost++;
  }
  tracks.forEach((tr, k) => {
    if (table[k]!.length === 0) return;
    // by departure, as pairs (pattern, first stop's time)
    const days = lists[k]!.map((l) => {
      const pairs: [number, number][] = [];
      for (let i = 0; i < l.length; i += 2) pairs.push([l[i]!, l[i + 1]!]);
      pairs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      // (the same departure listed twice: once)
      return pairs.filter((p, i) => i === 0 || p[1] !== pairs[i - 1]![1] || p[0] !== pairs[i - 1]![0]).flat();
    }) as Days;
    tr.timetable = { patterns: table[k]!, days };
  });
  return { placed, lost };
}

export { TRAIN_LENGTH };
