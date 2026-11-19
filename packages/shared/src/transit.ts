import { TICK_HZ } from './net/constants';

/**
 * Underground Stadtbahn (manifest.transit, written by the pipeline's transit.ts). Trains run by themselves: where a
 * train is depends only on the tick, so the server, the client's prediction and the rendering agree without any
 * network traffic.
 */
export type TransitTrack = {
  /** Centre line at rail-top height, flat x, y, z; trains run from the first point to the last. */
  pts: number[];
  /**
   * Where a train's centre stops: distance along `pts` (m), the station and the platform's side (1 left, −1 right of
   * travel). under: the stop is underground (a station with walls for signs, a ceiling for the departure board).
   */
  stops: { station: number; s: number; side: 1 | -1; under?: boolean }[];
  /** The line's number and where it goes (the trains' displays, the departure boards). Missing: unnamed. */
  line?: string;
  to?: string;
  /** Seconds between two trains on this path, and how far its departures are shifted; missing: the common headway, shifted by half of it per path. */
  headway?: number;
  phase?: number;
  /** The real timetable of this path (see Timetable); with it, headway and phase are not used. */
  timetable?: Timetable;
};

/**
 * A path's timetable. patterns: the stop times of a kind of trip, per stop of the path in seconds after the first
 * served one (−1: not served). days: per kind of day (weekday, Saturday, Sunday) the trips as pairs of pattern and
 * the first served stop's time (seconds after the service day's midnight; past 24 h for trips after midnight).
 */
export type Timetable = { patterns: number[][]; days: [number[], number[], number[]] };

export type Transit = {
  /** Seconds between two trains on a track. */
  headway: number;
  /** Stations: name and a point on the platform (for signs and announcements). */
  stations: { name: string; x: number; y: number; z: number }[];
  tracks: TransitTrack[];
  /**
   * Openings in the ground (stairwells), each a ring of flat x, z: inside one, people ignore the terrain collider
   * (the rendered ground and the pavement collision are cut out by the pipeline).
   */
  openings: number[][];
};

/** One unit: three sections with open gangways; a train is TRAIN_UNITS units coupled. */
export const TRAIN = {
  units: 2,
  sections: 3,
  /** A section's body (m), the gap between two sections of a unit and between two units. */
  sectionLength: 9.3, joint: 0.1, coupling: 0.8,
  /** Half the distance between the two points of a section that follow the track. */
  bogie: 3.3,
  halfWidth: 1.325,
  /** Floor above the rail top (= platform height), inner ceiling and outer roof. */
  floor: 0.35, ceiling: 2.7, roof: 3.3,
  doorWidth: 1.5,
  wall: 0.08,
  /** The driver's cab at each end of a unit: its back wall this far in from the end (closed to passengers). */
  cab: 1.45,
} as const;

/**
 * Station cross-section (m): the platform edge from a track's centre, the width of a side platform, and the tunnel
 * wall from the centre of a track that has no platform on that side.
 */
export const STATION = { edge: 1.45, platformWidth: 4.2, wallClear: 2.2, /** Inner ceiling above the rail top. */ ceiling: 4.4 } as const;

const UNIT_LENGTH = TRAIN.sections * TRAIN.sectionLength + (TRAIN.sections - 1) * TRAIN.joint;
export const TRAIN_LENGTH = TRAIN.units * UNIT_LENGTH + (TRAIN.units - 1) * TRAIN.coupling;
export const TRAIN_SECTIONS = TRAIN.units * TRAIN.sections;

/**
 * Driving: acceleration and braking (m/s²), top speed (m/s; 60 km/h), time at a platform (s): with the doors' timing
 * below they are open, or moving, for 15 s.
 */
const ACCEL = 1.0, VMAX = 60 / 3.6, DWELL = 17;
/** Doors: open this long after the stop, start closing this long before leaving, take this long to move (s). */
const DOOR_AFTER = 0.8, DOOR_BEFORE = 3, DOOR_MOVE = 1.6;
/** A train starts and ends with its tail (head) this far from the track's ends. */
const END_MARGIN = 2;

/** Offset (m, + ahead) of section i's centre from the train's centre. */
export function sectionOffset(i: number): number {
  const u = Math.floor(i / TRAIN.sections), k = i % TRAIN.sections;
  const unit = (u - (TRAIN.units - 1) / 2) * (UNIT_LENGTH + TRAIN.coupling);
  return unit + (k - (TRAIN.sections - 1) / 2) * (TRAIN.sectionLength + TRAIN.joint);
}

/** A stretch between two standstills: from t0 over d metres from s0, speeding up at `a` for tAcc to v, cruising, braking at `a`. */
type Leg = { t0: number; s0: number; d: number; tAcc: number; tCruise: number; v: number; a: number; p0?: number; p1?: number };
/** A stop of a run: the train stands from t0 to t1; its doors are shut again by `doors` (it may wait on for its time). */
type Dwell = { t0: number; t1: number; doors: number; side: 1 | -1; station: number };
/**
 * One run along a track: how the train moves (legs) and where it stands (dwells), by seconds from the run's start.
 * at: the dwell per stop of the track (undefined: not served). lead: when the first served stop's timetable time is.
 */
type Profile = { legs: Leg[]; dwells: Dwell[]; at: (Dwell | undefined)[]; duration: number; lead: number };
type Track = {
  pts: number[]; cum: Float64Array; length: number;
  /** Trains needed at once (the pool per track). */
  slots: number;
  /** Without a timetable: one run every `headway` seconds, shifted by `phase`. */
  periodic: { profile: Profile; headway: number; phase: number } | null;
  /**
   * With a timetable: the runs' profiles, and per kind of day (weekday, Saturday, Sunday) the trips by their start
   * (seconds after the service day's midnight; may pass 24 h) with their profile. longest: the longest run (s).
   */
  profiles: Profile[];
  days: { start: Float64Array; profile: Int32Array }[];
  longest: number;
};

/** The tracks with everything precomputed that the poses need. */
export type TransitModel = {
  headway: number; tracks: Track[];
  /** Sections in total (all tracks, all slots). */
  count: number;
  /** The real time of tick 0 (ms since the epoch): timetables run on the clock in Köln. Both sides of a connection use the server's. */
  epochMs: number;
  /** Makes the trips of a kind of day keep apart (once, on first use: see keepApart). */
  apart: (kind: number) => void;
};

/** Quickest run over d metres from standstill to standstill (s). */
const quickest = (d: number): number => (d >= (VMAX * VMAX) / ACCEL ? d / VMAX + VMAX / ACCEL : 2 * Math.sqrt(Math.max(0, d) / ACCEL));

/** With time to spare a train speeds up and brakes as gently as this (m/s²), and cruises no slower than this (m/s; 30 km/h). */
const GENTLE = 0.4, SLOW = 30 / 3.6;

/** The longest a train takes over d metres when it has time to spare: gentle all the way, cruising at SLOW. */
const easiest = (d: number): number => (d >= (SLOW * SLOW) / GENTLE ? d / SLOW + SLOW / GENTLE : 2 * Math.sqrt(Math.max(0, d) / GENTLE));

/**
 * A leg over d metres from s0, starting at t0 and taking `time` seconds (at least the quickest run). With more time
 * than that it speeds up and brakes more gently before it gives up top speed: first one long gentle rise and fall of
 * the speed, then, at the gentlest, a slower cruise between.
 */
function legOf(t0: number, s0: number, d: number, time: number): Leg {
  const D = Math.max(time, quickest(d));
  if (d <= 0) return { t0, s0, d: 0, tAcc: 0, tCruise: D, v: 0, a: ACCEL };
  // speeding up for half the time and braking for the other half
  const even = (4 * d) / (D * D), peak = (2 * d) / D;
  if (even <= ACCEL && even >= GENTLE && peak <= VMAX) return { t0, s0, d, tAcc: D / 2, tCruise: 0, v: peak, a: even };
  if (peak > VMAX) {
    // a long stretch: at top speed between, as gentle as the time allows
    const a = Math.min(ACCEL, Math.max(GENTLE, VMAX / Math.max(1e-6, D - d / VMAX)));
    if (a > GENTLE || d / VMAX + VMAX / GENTLE >= D) {
      const tAcc = VMAX / a;
      return { t0, s0, d, tAcc, tCruise: Math.max(0, D - 2 * tAcc), v: VMAX, a };
    }
  }
  // accelerate at a to v, cruise, brake: d = v · (D − v / a)
  const a = even < GENTLE ? GENTLE : ACCEL;
  const v = Math.min(VMAX, (a * D - Math.sqrt(Math.max(0, a * a * D * D - 4 * a * d))) / 2);
  const tAcc = v / a;
  return { t0, s0, d, tAcc, tCruise: Math.max(0, D - 2 * tAcc), v, a };
}

/** A train reaches a stop STAND_BEFORE seconds before its timetable time (which is given in whole minutes). */
const STAND_BEFORE = 6;

/**
 * The profile of a run over the stops of a track. times: per stop its timetable time in seconds after the first
 * served one (−1: not served). Then the run starts and ends on time, the stops between within about half a minute
 * (see below); without times it serves every stop as quickly as it can.
 */
function profileOf(tr: TransitTrack, length: number, times?: readonly number[]): Profile {
  const first = TRAIN_LENGTH / 2 + END_MARGIN, last = length - TRAIN_LENGTH / 2 - END_MARGIN;
  const served = tr.stops.map((_, i) => i).filter((i) => !times || times[i]! >= 0);
  const legs: Leg[] = [], dwells: Dwell[] = [], at: (Dwell | undefined)[] = tr.stops.map(() => undefined);
  let lead = 0, time = 0, pos = first;
  // The timetable is in whole minutes: kept stop by stop, a train would crawl over one stretch and race over the next.
  // So only the run as a whole keeps the timetable (first to last served stop): every stretch is driven slower than
  // the quickest run by the same share, as far as driving gently allows (see legOf, easiest), and only what time is
  // left then is waited out in equal parts at the stops, doors shut.
  let ease = 1, wait = 0;
  const hopOf = (n: number): number => tr.stops[served[n]!]!.s - tr.stops[served[n - 1]!]!.s;
  const runOf = (n: number, share: number): number => Math.min(quickest(hopOf(n)) * share, Math.max(quickest(hopOf(n)), easiest(hopOf(n))));
  if (times && served.length > 1) {
    const hops = served.length - 1, given = times[served[hops]!]! - hops * DWELL;
    const total = (share: number): number => { let sum = 0; for (let n = 1; n <= hops; n++) sum += runOf(n, share); return sum; };
    // the share that uses the time up, if gentle driving can
    let lo = 1, hi = 8;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (total(mid) < given) lo = mid; else hi = mid; }
    ease = lo;
    wait = Math.max(0, (given - total(ease)) / hops);
  }
  served.forEach((i, n) => {
    const stop = tr.stops[i]!;
    let arrive: number;
    if (n === 0) {
      // from the track's start to its first stop (a run that begins further on appears standing at its first stop)
      const leg = legOf(0, i === 0 ? first : stop.s, i === 0 ? Math.max(0, stop.s - first) : 0, 0);
      legs.push(leg);
      arrive = 2 * leg.tAcc + leg.tCruise;
      lead = arrive + STAND_BEFORE;
    } else {
      const prev = dwells[dwells.length - 1]!, d = Math.max(0, stop.s - pos), run = runOf(n, ease);
      prev.t1 = prev.t0 + DWELL + wait;
      arrive = prev.t1 + run;
      legs.push(legOf(prev.t1, pos, d, run));
    }
    pos = stop.s;
    const dwell: Dwell = { t0: arrive, t1: arrive + DWELL, doors: arrive + DWELL, side: stop.side, station: stop.station };
    dwells.push(dwell);
    at[i] = dwell;
    time = dwell.t1;
  });
  // on to the track's end (a run that ends before the last stop disappears standing there)
  if (served.length === 0 || served[served.length - 1] === tr.stops.length - 1) {
    const leg = legOf(time, pos, Math.max(0, last - pos), 0);
    legs.push(leg);
    time += 2 * leg.tAcc + leg.tCruise;
  }
  return { legs, dwells, at, duration: time, lead };
}

/** The rails are cut into blocks of this length (m); a block holds one train at a time, as between signals. */
const BLOCK = 40;
/** A train takes up its block and those within this far of its middle (m), and a block is free again this long after it left (s). */
const BLOCK_REACH = TRAIN_LENGTH / 2 + 12, BLOCK_GAP = 6;
/** A trip is held back by at most this long (s) to keep that distance. */
const MAX_HELD = 600;

/** The time after its start at which a run first is `s` metres along its track. */
function timeAt(p: Profile, s: number, from = { leg: 0 }): number {
  // (from: where the last call for a smaller s ended, to go on from there)
  for (; from.leg < p.legs.length; from.leg++) {
    const leg = p.legs[from.leg]!;
    if (s > leg.s0 + leg.d) continue;
    const ds = s - leg.s0;
    if (ds <= 0 || leg.d <= 0) return leg.t0;
    const sAcc = 0.5 * leg.a * leg.tAcc * leg.tAcc;
    if (ds <= sAcc) return leg.t0 + Math.sqrt((2 * ds) / leg.a);
    if (ds <= sAcc + leg.v * leg.tCruise) return leg.t0 + leg.tAcc + (ds - sAcc) / leg.v;
    return leg.t0 + 2 * leg.tAcc + leg.tCruise - Math.sqrt((2 * Math.max(0, leg.d - ds)) / leg.a);
  }
  return p.duration;
}

/** A wait of a run: after its m-th served stop, in that station (doors shut) or out on the line at `s` metres, until `until` seconds after its start. */
type Wait = { after: number; s: number; until: number; inStation: boolean };

/**
 * The run of `base` with waits put in: the train stands where the waits say until their time, and from there on makes
 * up for it, driving as quickly as it can and standing no longer than the doors take, until it is on time again.
 */
function withWaits(tr: Transit['tracks'][number], base: Profile, served: number[], waits: Wait[]): Profile {
  const legs: Leg[] = [base.legs[0]!], dwells: Dwell[] = [], at: (Dwell | undefined)[] = new Array(tr.stops.length).fill(undefined);
  let time = 0;
  served.forEach((i, n) => {
    const plan = base.at[i]!, stop = tr.stops[i]!;
    let arrive = plan.t0;
    if (n > 0) {
      const prev = dwells[n - 1]!, before = base.at[served[n - 1]!]!, from = tr.stops[served[n - 1]!]!.s, whole = Math.max(1e-6, stop.s - from);
      const here = waits.filter((w) => w.after === n - 1);
      prev.t1 = Math.max(prev.t0 + DWELL, before.t1, ...here.filter((w) => w.inStation).map((w) => w.until));
      let t = prev.t1, pos = from;
      for (const w of here.filter((x) => !x.inStation && x.s > from + 1 && x.s < stop.s - 1).sort((a, b) => a.s - b.s)) {
        const d = w.s - pos, leg = legOf(t, pos, d, Math.max(quickest(d), ((plan.t0 - before.t1) * d) / whole));
        legs.push({ ...leg, p0: (pos - from) / whole, p1: (w.s - from) / whole });
        t = Math.max(t + 2 * leg.tAcc + leg.tCruise, w.until);
        pos = w.s;
      }
      const d = stop.s - pos;
      arrive = Math.max(plan.t0, t + quickest(d));
      legs.push({ ...legOf(t, pos, d, arrive - t), p0: (pos - from) / whole, p1: 1 });
    }
    const dwell: Dwell = { t0: arrive, t1: arrive + DWELL, doors: arrive + DWELL, side: plan.side, station: plan.station };
    dwells.push(dwell);
    at[i] = dwell;
    time = dwell.t1;
  });
  // (the last stop: as long as planned, if there is a way on from it)
  if (base.legs.length > base.dwells.length) {
    const tail = base.legs[base.legs.length - 1]!;
    legs.push({ ...tail, t0: time });
    time += 2 * tail.tAcc + tail.tCruise;
  }
  return { legs, dwells, at, duration: time, lead: base.lead };
}

/**
 * Lines that share rails have their own timetables, each in whole minutes: now and then two trains would be in one
 * place at once, one inside the other (at a platform, where tracks join or cross, where a line turns back on one
 * track). So the rails are cut into blocks, and the trips of a day are gone through in the order they start: a trip
 * that would come into a block while another train is in it waits before it, out on the line, and makes the time up
 * again afterwards (withWaits). Only where that does not do (the block lies before its first stop) it starts later.
 */
function keepApart(t: Transit, tracks: Track[]): (kind: number) => void {
  let blocksOf: number[][][] | null = null, ids = 0;
  const done = new Set<number>();
  const prepare = (): number[][][] => {
  // the blocks: BLOCK metres of a track each; where tracks run on the same rails or into each other (closer than tracks side by side are), a block
  // also takes up the blocks of the tracks before it that lie there
  const CELL = 4, near = new Map<string, { x: number; y: number; z: number; id: number }[]>();
  return tracks.map((tr, k) => {
    const n = tr.cum.length, count = Math.max(1, Math.ceil(tr.length / BLOCK)), own = ids;
    ids += count;
    const sets: Set<number>[] = Array.from({ length: count }, (_, b) => new Set([own + b]));
    const mine: { x: number; y: number; z: number; id: number }[] = [];
    let i = 1;
    for (let s = 0; s <= tr.length; s += 3) {
      while (i < n - 1 && tr.cum[i]! < s) i++;
      const u = tr.cum[i]! > tr.cum[i - 1]! ? (s - tr.cum[i - 1]!) / (tr.cum[i]! - tr.cum[i - 1]!) : 0, a = (i - 1) * 3, c = i * 3;
      const x = tr.pts[a]! + (tr.pts[c]! - tr.pts[a]!) * u, y = tr.pts[a + 1]! + (tr.pts[c + 1]! - tr.pts[a + 1]!) * u, z = tr.pts[a + 2]! + (tr.pts[c + 2]! - tr.pts[a + 2]!) * u;
      const b = Math.min(count - 1, Math.floor(s / BLOCK)), gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const o of near.get(`${gx + dx}_${gz + dz}`) ?? []) if (Math.abs(o.y - y) < 2 && Math.hypot(o.x - x, o.z - z) < 2.3) sets[b]!.add(o.id);
        }
      }
      mine.push({ x, y, z, id: own + b });
    }
    for (const q of mine) {
      const key = `${Math.floor(q.x / CELL)}_${Math.floor(q.z / CELL)}`;
      let list = near.get(key);
      if (!list) near.set(key, (list = []));
      list.push(q);
    }
    void k;
    return sets.map((set) => [...set]);
  });
  };
  // when a run is in which block, after its start (per profile, made on first use)
  type Visit = { id: number; blk: number; a: number; b: number };
  const visits = new Map<Profile, Visit[]>();
  const visitsOf = (k: number, p: Profile, keep = true): Visit[] => {
    let v = keep ? visits.get(p) : undefined;
    if (!v) {
      v = [];
      const first = p.legs[0], last = p.legs[p.legs.length - 1];
      const s0 = first ? first.s0 : 0, s1 = last ? last.s0 + last.d : 0, blocks = (blocksOf ??= prepare())[k]!;
      const in_ = { leg: 0 }, out = { leg: 0 };
      for (let b = Math.max(0, Math.floor((s0 - BLOCK_REACH) / BLOCK)); b < blocks.length && b * BLOCK <= s1 + BLOCK_REACH; b++) {
        const from = timeAt(p, b * BLOCK - BLOCK_REACH, in_), to = timeAt(p, (b + 1) * BLOCK + BLOCK_REACH, out) + BLOCK_GAP;
        for (const id of blocks[b]!) v.push({ id, blk: b, a: from, b: to });
      }
      if (keep) visits.set(p, v);
    }
    return v;
  };
  return (d: number): void => {
    if (done.has(d)) return;
    done.add(d);
    blocksOf ??= prepare();
    const trips: { k: number; i: number; start: number }[] = [];
    tracks.forEach((tr, k) => { const day = tr.days[d]; if (day) for (let i = 0; i < day.start.length; i++) trips.push({ k, i, start: day.start[i]! }); });
    trips.sort((a, b) => a.start - b.start || a.k - b.k);
    // per block the times it is taken, in order (they do not overlap)
    const taken: { a: number; b: number; trip: number }[][] = Array.from({ length: ids }, () => []);
    const place = (list: { a: number }[], a: number): number => {
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]!.a < a) lo = mid + 1; else hi = mid; }
      return lo;
    };
    /** The first block of `v` (a trip started at `start`) that another train is in: the block and when it is free. */
    const blocked = (v: Visit[], start: number): { blk: number; at: number; free: number } | null => {
      let hit: { blk: number; at: number; free: number } | null = null;
      for (const q of v) {
        const a = start + q.a, b = start + q.b, list = taken[q.id]!, at = place(list, a);
        let free = at > 0 && list[at - 1]!.b > a ? list[at - 1]!.b : -Infinity;
        for (let j = at; j < list.length && list[j]!.a < b; j++) free = Math.max(free, list[j]!.b);
        if (free > -Infinity && (!hit || a < hit.at)) hit = { blk: q.blk, at: a, free };
      }
      return hit;
    };
    trips.forEach((trip, n) => {
      const tr = tracks[trip.k]!, base = tr.profiles[tr.days[d]!.profile[trip.i]!]!;
      let v = visitsOf(trip.k, base);
      let held = 0;
      // first the way of a real train: it waits before the block that is taken, out on the line (in its station only
      // where the block lies right ahead of it), and makes the time up again as far as it can
      if (base.dwells.length > 0 && blocked(v, trip.start)) {
        const stops = t.tracks[trip.k]!.stops, served = stops.map((_, i) => i).filter((i) => base.at[i]);
        const waits: Wait[] = [];
        let own: Profile | null = null;
        for (let pass = 0; pass < 24; pass++) {
          const hit = blocked(own ? visitsOf(trip.k, own, false) : v, trip.start);
          if (!hit) break;
          own = null;
          const sH = hit.blk * BLOCK - BLOCK_REACH - 2, until = hit.free - trip.start;
          let m = served.length - 1;
          while (m >= 0 && stops[served[m]!]!.s > sH) m--;
          if (m < 0 || until > base.duration + MAX_HELD) break; // (before the first stop: started later instead, below)
          const inStation = sH - stops[served[m]!]!.s < 8;
          const same = waits.find((w) => w.after === m && w.inStation === inStation && (inStation || Math.abs(w.s - sH) < 1));
          if (same) same.until = Math.max(same.until, until + (same.until >= until ? 1 : 0));
          else waits.push({ after: m, s: sH, until, inStation });
          own = withWaits(t.tracks[trip.k]!, base, served, waits);
        }
        if (own && !blocked(visitsOf(trip.k, own, false), trip.start)) {
          tr.days[d]!.profile[trip.i] = tr.profiles.push(own) - 1;
          v = visitsOf(trip.k, own, false);
        }
      }
      for (let pass = 0; pass < 40; pass++) {
        let more = held;
        for (const q of v) {
          const a = trip.start + held + q.a, b = trip.start + held + q.b, list = taken[q.id]!;
          // the one before and those after that overlap
          const at = place(list, a);
          if (at > 0 && list[at - 1]!.b > a) more = Math.max(more, held + list[at - 1]!.b - a);
          for (let j = at; j < list.length && list[j]!.a < b; j++) more = Math.max(more, held + list[j]!.b - a);
        }
        if (more === held) break;
        if (more > MAX_HELD) { held = 0; break; }
        held = more;
      }
      tr.days[d]!.start[trip.i] = trip.start + held;
      for (const q of v) {
        const a = trip.start + held + q.a, list = taken[q.id]!, at = place(list, a);
        // (a block listed twice for this trip: one entry, its whole time there)
        if (at > 0 && list[at - 1]!.trip === n) list[at - 1]!.b = Math.max(list[at - 1]!.b, trip.start + held + q.b);
        else list.splice(at, 0, { a, b: trip.start + held + q.b, trip: n });
      }
    });
    // (held trips may have fallen behind later ones of their own track: in order again)
    for (const tr of tracks) {
      const day = tr.days[d];
      if (!day) continue;
      const order = Array.from(day.start.keys()).sort((x, y) => day.start[x]! - day.start[y]!);
      const start = order.map((i) => day.start[i]!), profile = order.map((i) => day.profile[i]!);
      day.start.set(start);
      day.profile.set(profile);
    }
  };
}

export function transitModel(t: Transit): TransitModel {
  const tracks = t.tracks.map((tr, k): Track => {
    const n = tr.pts.length / 3, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1]! + Math.hypot(tr.pts[i * 3]! - tr.pts[i * 3 - 3]!, tr.pts[i * 3 + 1]! - tr.pts[i * 3 - 2]!, tr.pts[i * 3 + 2]! - tr.pts[i * 3 - 1]!);
    }
    const length = cum[n - 1]!;
    const base = { pts: tr.pts, cum, length };
    const tt = tr.timetable;
    if (!tt || tt.patterns.length === 0) {
      const profile = profileOf(tr, length), headway = tr.headway ?? t.headway;
      return { ...base, slots: Math.ceil(profile.duration / headway) + 1, periodic: { profile, headway, phase: tr.phase ?? (k * headway) / 2 }, profiles: [profile], days: [], longest: profile.duration };
    }
    const profiles = tt.patterns.map((times) => profileOf(tr, length, times));
    // (a run may take up to MAX_HELD longer where it has to wait for others, see keepApart)
    const longest = Math.max(...profiles.map((p) => p.duration)) + MAX_HELD;
    const days = tt.days.map((list) => {
      const trips: [number, number][] = [];
      for (let i = 0; i + 1 < list.length; i += 2) trips.push([list[i + 1]! - profiles[list[i]!]!.lead, list[i]!]);
      trips.sort((a, b) => a[0] - b[0]);
      return { start: Float64Array.from(trips.map((x) => x[0])), profile: Int32Array.from(trips.map((x) => x[1])) };
    });
    return { ...base, slots: 1, periodic: null, profiles, days, longest };
  });
  for (const tr of tracks) {
    if (tr.periodic) continue;
    // how many are out at once: a trip is over when a later one starts after its end
    let most = 1;
    for (const day of tr.days) {
      for (let i = 0; i < day.start.length; i++) {
        let out = 1;
        // (as the timetable has them; held back, a trip is out up to MAX_HELD longer, see keepApart)
        for (let j = i - 1; j >= 0 && day.start[i]! - day.start[j]! < tr.longest + MAX_HELD; j--) if (day.start[j]! + tr.profiles[day.profile[j]!]!.duration + MAX_HELD > day.start[i]!) out++;
        most = Math.max(most, out);
      }
    }
    tr.slots = most + 1;
  }
  return { headway: t.headway, tracks, count: tracks.reduce((n, tr) => n + tr.slots * TRAIN_SECTIONS, 0), epochMs: Date.now(), apart: keepApart(t, tracks) };
}

/** The clock in Köln: milliseconds to add to UTC, cached by the hour (daylight saving changes on the hour). */
let offsetHour = NaN, offsetMs = 0;
function kölnOffset(ms: number): number {
  const hour = Math.floor(ms / 3_600_000);
  if (hour !== offsetHour) {
    offsetHour = hour;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms));
    const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    offsetMs = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(ms / 1000) * 1000;
  }
  return offsetMs;
}

/** Kind of day of a local day number (days since 1970-01-01, a Thursday): 0 Monday–Friday, 1 Saturday, 2 Sunday. */
const kindOfDay = (day: number): number => { const w = (((day + 4) % 7) + 7) % 7; return w === 0 ? 2 : w === 6 ? 1 : 0; };

/** The local time at `tick`: seconds since midnight and the local day number. */
function clockAt(m: TransitModel, tick: number): { sec: number; day: number } {
  const ms = m.epochMs + (tick / TICK_HZ) * 1000, local = ms + kölnOffset(ms);
  const day = Math.floor(local / 86_400_000);
  return { sec: (local - day * 86_400_000) / 1000, day };
}

/**
 * The runs of a track that are on their way at `tick`: `run` gets the slot (which of the track's trains), the trip's
 * number, its profile and the seconds since its start.
 */
function eachRun(m: TransitModel, tr: Track, tick: number, run: (slot: number, trip: number, p: Profile, t: number) => void): void {
  const per = tr.periodic;
  if (per) {
    const now = tick / TICK_HZ;
    for (let slot = 0; slot < tr.slots; slot++) {
      // the trip of this slot that is on the way now: trip k leaves at phase + k · headway, slot = k mod slots
      const newest = Math.floor((now - per.phase) / per.headway);
      const k = newest - ((((newest - slot) % tr.slots) + tr.slots) % tr.slots);
      const t = now - per.phase - k * per.headway;
      if (t >= 0 && t < per.profile.duration) run(slot, k, per.profile, t);
    }
    return;
  }
  const { sec, day } = clockAt(m, tick);
  let taken = 0;
  // today's trips, and yesterday's that run past midnight
  for (const back of [0, 1]) {
    m.apart(kindOfDay(day - back));
    const list = tr.days[kindOfDay(day - back)];
    if (!list) continue;
    const now = sec + back * 86400, start = list.start;
    let lo = 0, hi = start.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (start[mid]! <= now) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0 && now - start[i]! <= tr.longest; i--) {
      const p = tr.profiles[list.profile[i]!]!, t = now - start[i]!;
      const slot = i % tr.slots;
      if (t >= p.duration || taken & (1 << slot)) continue;
      taken |= 1 << slot;
      run(slot, i, p, t);
    }
  }
}

/** Per stop of a track at `tick`: every time a train stands there, as seconds from now (from, to), soonest first, from `since` seconds ago on. */
function standing(m: TransitModel, tr: Track, stop: number, tick: number, since: number, limit: number): [number, number][] {
  const out: [number, number][] = [];
  const per = tr.periodic;
  if (per) {
    const d = per.profile.at[stop];
    if (!d) return out;
    const now = tick / TICK_HZ - per.phase;
    for (let k = Math.floor((now - since - d.t1) / per.headway) + 1; out.length < limit; k++) out.push([k * per.headway + d.t0 - now, k * per.headway + d.t1 - now]);
    return out;
  }
  const { sec, day } = clockAt(m, tick);
  // yesterday's late trips, today's, tomorrow's
  for (const off of [-1, 0, 1]) {
    m.apart(kindOfDay(day + off));
    const list = tr.days[kindOfDay(day + off)];
    if (!list) continue;
    const base = off * 86400 - sec, start = list.start;
    let lo = 0, hi = start.length;
    const from = -since - base - tr.longest;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (start[mid]! < from) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < start.length && out.length < limit; i++) {
      const d = tr.profiles[list.profile[i]!]!.at[stop];
      if (d && base + start[i]! + d.t1 >= -since) out.push([base + start[i]! + d.t0, base + start[i]! + d.t1]);
    }
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Point of a track at distance s (clamped), written to out[o..o+2]. */
function trackPoint(tr: Track, s: number, out: Float64Array, o: number): void {
  const { cum, pts } = tr, n = cum.length;
  const d = Math.min(Math.max(s, 0), tr.length);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const len = cum[hi]! - cum[lo]!, f = len > 0 ? (d - cum[lo]!) / len : 0;
  for (let k = 0; k < 3; k++) out[o + k] = pts[lo * 3 + k]! + (pts[hi * 3 + k]! - pts[lo * 3 + k]!) * f;
}

/** Distance along the track `t` seconds into a trip, and the speed there. */
function tripDistance(tr: Profile, t: number): { s: number; v: number; leg: number } {
  let leg = tr.legs[0]!;
  for (const l of tr.legs) if (l.t0 <= t) leg = l;
  const u = t - leg.t0, total = 2 * leg.tAcc + leg.tCruise;
  // (a stretch between two stops driven in pieces, with a wait between: p0..p1 is this piece's share of it)
  const p0 = leg.p0 ?? 0, p1 = leg.p1 ?? 1;
  const at = (s: number, v: number) => ({ s, v, leg: p0 + (p1 - p0) * (leg.d > 0 ? Math.min(1, Math.max(0, (s - leg.s0) / leg.d)) : 1) });
  if (u >= total) return at(leg.s0 + leg.d, 0);
  if (u < leg.tAcc) return at(leg.s0 + 0.5 * leg.a * u * u, leg.a * u);
  const sAcc = 0.5 * leg.a * leg.tAcc * leg.tAcc;
  if (u < leg.tAcc + leg.tCruise) return at(leg.s0 + sAcc + leg.v * (u - leg.tAcc), leg.v);
  const r = total - u;
  return at(leg.s0 + leg.d - 0.5 * leg.a * r * r, leg.a * r);
}

/** How far the doors on `side` are open (0..1) `t` seconds into a trip. */
function doorOpen(tr: Profile, t: number, side: 1 | -1): number {
  for (const d of tr.dwells) {
    if (d.side !== side || t < d.t0 || t > d.t1) continue;
    const opening = (t - d.t0 - DOOR_AFTER) / DOOR_MOVE, closing = (d.doors - DOOR_BEFORE + DOOR_MOVE - t) / DOOR_MOVE;
    return Math.max(0, Math.min(1, opening, closing));
  }
  return 0;
}

/** Floats per section in sectionStates' output. */
export const SECTION_STRIDE = 13;

/**
 * Every section of every train at `tick` (may be fractional), SECTION_STRIDE floats each: active (0/1), x, y, z (the
 * section's centre at rail-top height), yaw (forward = (sin, cos) in x/z), pitch (nose up), doors open left and right
 * (0..1), speed (m/s), the station the train stands at (index, −1 while driving), the trip's number and the next
 * station it stops at (where it stands, while it stands; −1 after its last stop) and how far it is on the way there
 * from the last stop (0..1).
 * Sections are ordered by track,
 * then slot, then along the train from its tail.
 */
export function sectionStates(m: TransitModel, tick: number, out: Float64Array = new Float64Array(m.count * SECTION_STRIDE)): Float64Array {
  const p = new Float64Array(6);
  let base = 0;
  for (const tr of m.tracks) {
    for (let k = 0; k < tr.slots * TRAIN_SECTIONS; k++) out[base + k * SECTION_STRIDE] = 0;
    eachRun(m, tr, tick, (slot, trip, prof, t) => {
      const at = tripDistance(prof, t);
      let station = -1, next = -1;
      for (const d of prof.dwells) if (t >= d.t0 && t <= d.t1) station = d.station;
      for (const d of prof.dwells) if (t <= d.t1) { next = d.station; break; }
      const left = doorOpen(prof, t, 1), right = doorOpen(prof, t, -1);
      let o = base + slot * TRAIN_SECTIONS * SECTION_STRIDE;
      for (let i = 0; i < TRAIN_SECTIONS; i++, o += SECTION_STRIDE) {
        const c = at.s + sectionOffset(i);
        trackPoint(tr, c - TRAIN.bogie, p, 0);
        trackPoint(tr, c + TRAIN.bogie, p, 3);
        const dx = p[3]! - p[0]!, dy = p[4]! - p[1]!, dz = p[5]! - p[2]!;
        out[o] = 1;
        out[o + 1] = (p[0]! + p[3]!) / 2;
        out[o + 2] = (p[1]! + p[4]!) / 2;
        out[o + 3] = (p[2]! + p[5]!) / 2;
        out[o + 4] = Math.atan2(dx, dz);
        out[o + 5] = Math.atan2(dy, Math.hypot(dx, dz));
        out[o + 6] = left;
        out[o + 7] = right;
        out[o + 8] = at.v;
        out[o + 9] = station;
        out[o + 10] = trip;
        out[o + 11] = next;
        out[o + 12] = at.leg;
      }
    });
    base += tr.slots * TRAIN_SECTIONS * SECTION_STRIDE;
  }
  return out;
}

/**
 * The next `n` trains at stop `stop` (index in the track's stops) of track `track` at `tick`: seconds until each
 * arrives (0: standing at the platform now) and its trip number (trips count up, one per headway).
 */
export function nextArrivals(m: TransitModel, track: number, stop: number, tick: number, n = 2): { wait: number; trip: number }[] {
  const tr = m.tracks[track];
  if (!tr) return [];
  // (a train that stands there counts until it leaves)
  return standing(m, tr, stop, tick, 0, n).map(([from], i) => ({ wait: Math.max(0, from), trip: i }));
}

/** A double bench in a section's frame (x left, z ahead, from the section's centre): its box and which way it faces along z. */
export type Bench = { x0: number; x1: number; z0: number; z1: number; facing: 1 | -1 };
/** Benches: depth of a seat (along the car), their width (across), the cushion's top above the floor, the top of the back. */
export const BENCH = { depth: 0.47, width: 0.86, seat: 0.5, back: 1.0, backThick: 0.06 } as const;

/**
 * The benches of section k of a unit (0 … TRAIN.sections − 1): rows across the car on both sides of the aisle, in
 * pairs back to back, left free at the doors and in the drivers' cabs.
 */
export function sectionBenches(k: number): Bench[] {
  const L = TRAIN.sectionLength / 2, door = TRAIN.doorWidth / 2, rear = k === 0, front = k === TRAIN.sections - 1;
  const out: Bench[] = [];
  const pair = 2 * BENCH.depth + BENCH.backThick, pitch = pair + 0.56;
  for (const [a, b] of [[-L + (rear ? TRAIN.cab + 0.15 : 0.35), -door - 0.3], [door + 0.3, L - (front ? TRAIN.cab + 0.15 : 0.35)]] as const) {
    const n = Math.floor((b - a + 0.56) / pitch), start = a + (b - a - (n * pitch - 0.56)) / 2;
    for (let i = 0; i < n; i++) {
      const z = start + i * pitch;
      for (const side of [1, -1]) {
        const x0 = side * (TRAIN.halfWidth - TRAIN.wall - 0.03), x1 = x0 - side * BENCH.width;
        out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: z, z1: z + BENCH.depth, facing: -1 });
        out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: z + BENCH.depth + BENCH.backThick, z1: z + pair, facing: 1 });
      }
    }
  }
  return out;
}

/** Someone on a bench: where they sit (the middle of their place on the cushion, world) and the way they face. */
export type Seated = { x: number; y: number; z: number; yaw: number };

/**
 * The place of a bench: the spot a person's middle is at (section frame, on the cushion). One per bench, in its
 * middle: the person is a capsule standing there, and it must stay clear of the bench's back and the car's wall (a
 * capsule put into either is pushed out again, or stuck).
 */
function benchSpots(b: Bench): { x: number; z: number }[] {
  return [{ x: (b.x0 + b.x1) / 2, z: b.facing > 0 ? b.z0 + 0.36 : b.z1 - 0.36 }];
}

/** (x, y, z) in the frame of the section at offset o of `states`: across (left +), up from the rail top, along. */
function sectionLocal(states: Float64Array, o: number, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const yaw = states[o + 4]!, dx = x - states[o + 1]!, dz = z - states[o + 3]!;
  return { x: dx * Math.cos(yaw) - dz * Math.sin(yaw), y: y - states[o + 2]!, z: dx * Math.sin(yaw) + dz * Math.cos(yaw) };
}
function sectionWorld(states: Float64Array, o: number, p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const yaw = states[o + 4]!, s = Math.sin(yaw), c = Math.cos(yaw);
  return { x: states[o + 1]! + p.x * c + p.z * s, y: states[o + 2]! + p.y, z: states[o + 3]! - p.x * s + p.z * c };
}

const carryFrom = new Float64Array(0), carryTo = new Float64Array(0);
let carryA: Float64Array = carryFrom, carryB: Float64Array = carryTo;
/**
 * Someone at (x, y, z) in a train as it is at tick `from`: where the same place in that train is at tick `to`; null
 * outside every train. (A client that runs the trains a tick or two off the server's compares positions this way.)
 */
export function carriedTo(model: TransitModel, x: number, y: number, z: number, from: number, to: number): { x: number; y: number; z: number } | null {
  carryA = sectionStates(model, from, carryA.length ? carryA : undefined);
  const hit = sectionAt(carryA, x, y, z);
  if (!hit) return null;
  carryB = sectionStates(model, to, carryB.length ? carryB : undefined);
  return carryB[hit.o] === 1 ? sectionWorld(carryB, hit.o, hit.local) : null;
}

/**
 * The section (offset into `states`, as from sectionStates) whose body holds the point (x, y, z), and the point in its
 * frame; null outside every train.
 */
export function sectionAt(states: Float64Array, x: number, y: number, z: number): { o: number; local: { x: number; y: number; z: number } } | null {
  const L = TRAIN.sectionLength / 2 + TRAIN.joint;
  for (let o = 0; o < states.length; o += SECTION_STRIDE) {
    if (states[o] !== 1 || Math.abs(x - states[o + 1]!) > L || Math.abs(z - states[o + 3]!) > L) continue;
    const p = sectionLocal(states, o, x, y, z);
    if (Math.abs(p.z) <= L && Math.abs(p.x) <= TRAIN.halfWidth && p.y > 0 && p.y < TRAIN.roof) return { o, local: p };
  }
  return null;
}

/**
 * A place on a bench for someone at (x, y, z) (feet): `on` = the place they are on already (feet on the cushion,
 * within a hand of it), else the nearest place within `reach` m of someone standing on the train's floor; null if
 * there is none. `aisle`: where to stand up to (world, feet on the floor).
 */
export function benchPlace(states: Float64Array, x: number, y: number, z: number, reach = 1.3): { on: boolean; seat: Seated; aisle: { x: number; y: number; z: number } } | null {
  const at = sectionAt(states, x, y, z);
  if (!at) return null;
  const k = ((at.o / SECTION_STRIDE) % TRAIN_SECTIONS) % TRAIN.sections, top = TRAIN.floor + BENCH.seat, yaw = states[at.o + 4]!;
  const sitting = Math.abs(at.local.y - top) < 0.15, standing = Math.abs(at.local.y - TRAIN.floor) < 0.2;
  if (!sitting && !standing) return null;
  let best: { x: number; z: number; facing: 1 | -1 } | null = null, bd = sitting ? 0.3 : reach;
  for (const b of sectionBenches(k)) {
    for (const s of benchSpots(b)) {
      const d = Math.hypot(s.x - at.local.x, s.z - at.local.z);
      if (d < bd) [best, bd] = [{ ...s, facing: b.facing }, d];
    }
  }
  if (!best) return null;
  const w = sectionWorld(states, at.o, { x: best.x, y: top, z: best.z });
  const a = sectionWorld(states, at.o, { x: 0, y: TRAIN.floor, z: best.z + best.facing * 0.25 });
  return { on: sitting, seat: { ...w, yaw: best.facing > 0 ? yaw : yaw + Math.PI }, aisle: a };
}

/**
 * The departure signal of a stop: whether a train stands there, and the seconds until it leaves (standing) or since
 * the last one left.
 */
export function departure(m: TransitModel, track: number, stop: number, tick: number): { standing: boolean; seconds: number } {
  const tr = m.tracks[track];
  if (!tr) return { standing: false, seconds: Infinity };
  // the trains that stood there in the last minutes or stand there now
  const times = standing(m, tr, stop, tick, 600, 8);
  const here = times.find(([from, to]) => from <= 0 && to >= 0);
  if (here) return { standing: true, seconds: here[1] };
  const gone = times.filter(([, to]) => to < 0).map(([, to]) => -to);
  return { standing: false, seconds: gone.length ? Math.min(...gone) : Infinity };
}

/** Rotation of a section: yaw about +y, then the nose up by pitch. */
export function sectionQuat(yaw: number, pitch: number): { x: number; y: number; z: number; w: number } {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2);
  // q = qYaw(y axis) · qPitch(x axis)
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

/** Whether (x, z) lies inside the ring (flat x, z). */
export function inRing(ring: readonly number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]!, zi = ring[i + 1]!, xj = ring[j]!, zj = ring[j + 1]!;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** A test for "inside any of the rings", with a bounding box check first. */
export function openingTest(rings: readonly (readonly number[])[]): (x: number, z: number) => boolean {
  const boxes = rings.map((r) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!); z0 = Math.min(z0, r[i + 1]!); z1 = Math.max(z1, r[i + 1]!); }
    return { x0, x1, z0, z1 };
  });
  return (x, z) => {
    for (let k = 0; k < rings.length; k++) {
      const b = boxes[k]!;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && inRing(rings[k]!, x, z)) return true;
    }
    return false;
  };
}
