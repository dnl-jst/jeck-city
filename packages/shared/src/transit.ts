import { TICK_HZ } from './net/constants';

/**
 * Underground Stadtbahn (manifest.transit, written by the pipeline's transit.ts). Trains run by themselves: where a
 * train is depends only on the tick, so the server, the client's prediction and the rendering agree without any
 * network traffic.
 */
export type TransitTrack = {
  /** Centre line at rail-top height, flat x, y, z; trains run from the first point to the last. */
  pts: number[];
  /** Where a train's centre stops: distance along `pts` (m), the station and the platform's side (1 left, −1 right of travel). */
  stops: { station: number; s: number; side: 1 | -1 }[];
};

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

/** Driving: acceleration and braking (m/s²), top speed (m/s; 60 km/h), time at a platform (s). */
const ACCEL = 1.0, VMAX = 60 / 3.6, DWELL = 22;
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

type Leg = { t0: number; s0: number; d: number; tAcc: number; tCruise: number; v: number };
type Track = {
  pts: number[]; cum: Float64Array; length: number;
  legs: Leg[];
  /** Per stop: when the train stands there (s after the trip's start) and the platform side. */
  dwells: { t0: number; t1: number; side: 1 | -1; station: number }[];
  duration: number;
  /** Trains needed at once (the pool per track). */
  slots: number;
  /** Seconds this track's departures are shifted by. */
  phase: number;
};

/** The tracks with everything precomputed that the poses need. */
export type TransitModel = { headway: number; tracks: Track[]; /** Sections in total (all tracks, all slots). */ count: number };

export function transitModel(t: Transit): TransitModel {
  const tracks = t.tracks.map((tr, k): Track => {
    const n = tr.pts.length / 3, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1]! + Math.hypot(tr.pts[i * 3]! - tr.pts[i * 3 - 3]!, tr.pts[i * 3 + 1]! - tr.pts[i * 3 - 2]!, tr.pts[i * 3 + 2]! - tr.pts[i * 3 - 1]!);
    }
    const length = cum[n - 1]!;
    const way = [TRAIN_LENGTH / 2 + END_MARGIN, ...tr.stops.map((s) => s.s), length - TRAIN_LENGTH / 2 - END_MARGIN];
    const legs: Leg[] = [], dwells: Track['dwells'] = [];
    let time = 0;
    for (let i = 0; i + 1 < way.length; i++) {
      const d = Math.max(0, way[i + 1]! - way[i]!);
      const full = d >= (VMAX * VMAX) / ACCEL;
      const tAcc = full ? VMAX / ACCEL : Math.sqrt(d / ACCEL), v = full ? VMAX : tAcc * ACCEL;
      const tCruise = full ? (d - (VMAX * VMAX) / ACCEL) / VMAX : 0;
      legs.push({ t0: time, s0: way[i]!, d, tAcc, tCruise, v });
      time += 2 * tAcc + tCruise;
      const stop = tr.stops[i];
      if (stop && i + 2 < way.length) {
        dwells.push({ t0: time, t1: time + DWELL, side: stop.side, station: stop.station });
        time += DWELL;
      }
    }
    return { pts: tr.pts, cum, length, legs, dwells, duration: time, slots: Math.ceil(time / t.headway) + 1, phase: (k * t.headway) / 2 };
  });
  return { headway: t.headway, tracks, count: tracks.reduce((n, tr) => n + tr.slots * TRAIN_SECTIONS, 0) };
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
function tripDistance(tr: Track, t: number): { s: number; v: number } {
  let leg = tr.legs[0]!;
  for (const l of tr.legs) if (l.t0 <= t) leg = l;
  const u = t - leg.t0, total = 2 * leg.tAcc + leg.tCruise;
  if (u >= total) return { s: leg.s0 + leg.d, v: 0 };
  if (u < leg.tAcc) return { s: leg.s0 + 0.5 * ACCEL * u * u, v: ACCEL * u };
  const sAcc = 0.5 * ACCEL * leg.tAcc * leg.tAcc;
  if (u < leg.tAcc + leg.tCruise) return { s: leg.s0 + sAcc + leg.v * (u - leg.tAcc), v: leg.v };
  const r = total - u;
  return { s: leg.s0 + leg.d - 0.5 * ACCEL * r * r, v: ACCEL * r };
}

/** How far the doors on `side` are open (0..1) `t` seconds into a trip. */
function doorOpen(tr: Track, t: number, side: 1 | -1): number {
  for (const d of tr.dwells) {
    if (d.side !== side || t < d.t0 || t > d.t1) continue;
    const opening = (t - d.t0 - DOOR_AFTER) / DOOR_MOVE, closing = (d.t1 - DOOR_BEFORE + DOOR_MOVE - t) / DOOR_MOVE;
    return Math.max(0, Math.min(1, opening, closing));
  }
  return 0;
}

/** Floats per section in sectionStates' output. */
export const SECTION_STRIDE = 11;

/**
 * Every section of every train at `tick` (may be fractional), SECTION_STRIDE floats each: active (0/1), x, y, z (the
 * section's centre at rail-top height), yaw (forward = (sin, cos) in x/z), pitch (nose up), doors open left and right
 * (0..1), speed (m/s), the station the train stands at (index, −1 while driving) and the trip's number. Sections are ordered by track,
 * then slot, then along the train from its tail.
 */
export function sectionStates(m: TransitModel, tick: number, out: Float64Array = new Float64Array(m.count * SECTION_STRIDE)): Float64Array {
  const now = tick / TICK_HZ;
  const p = new Float64Array(6);
  let o = 0;
  for (const tr of m.tracks) {
    for (let slot = 0; slot < tr.slots; slot++) {
      // the trip of this slot that is on the way now: trip k leaves at phase + k · headway, slot = k mod slots
      const newest = Math.floor((now - tr.phase) / m.headway);
      const k = newest - ((((newest - slot) % tr.slots) + tr.slots) % tr.slots);
      const t = now - tr.phase - k * m.headway;
      const active = t >= 0 && t < tr.duration;
      const at = active ? tripDistance(tr, t) : { s: 0, v: 0 };
      let station = -1;
      if (active) for (const d of tr.dwells) if (t >= d.t0 && t <= d.t1) station = d.station;
      const left = active ? doorOpen(tr, t, 1) : 0, right = active ? doorOpen(tr, t, -1) : 0;
      for (let i = 0; i < TRAIN_SECTIONS; i++, o += SECTION_STRIDE) {
        out[o] = active ? 1 : 0;
        if (!active) continue;
        const c = at.s + sectionOffset(i);
        trackPoint(tr, c - TRAIN.bogie, p, 0);
        trackPoint(tr, c + TRAIN.bogie, p, 3);
        const dx = p[3]! - p[0]!, dy = p[4]! - p[1]!, dz = p[5]! - p[2]!;
        out[o + 1] = (p[0]! + p[3]!) / 2;
        out[o + 2] = (p[1]! + p[4]!) / 2;
        out[o + 3] = (p[2]! + p[5]!) / 2;
        out[o + 4] = Math.atan2(dx, dz);
        out[o + 5] = Math.atan2(dy, Math.hypot(dx, dz));
        out[o + 6] = left;
        out[o + 7] = right;
        out[o + 8] = at.v;
        out[o + 9] = station;
        out[o + 10] = k;
      }
    }
  }
  return out;
}

/**
 * The next `n` trains at stop `stop` (index in the track's stops) of track `track` at `tick`: seconds until each
 * arrives (0: standing at the platform now) and its trip number (trips count up, one per headway).
 */
export function nextArrivals(m: TransitModel, track: number, stop: number, tick: number, n = 2): { wait: number; trip: number }[] {
  const tr = m.tracks[track], d = tr?.dwells[stop];
  if (!tr || !d) return [];
  // trip k stands here from phase + k · headway + t0 to … + t1
  const since = tick / TICK_HZ - tr.phase - d.t0;
  const first = Math.floor((since - (d.t1 - d.t0)) / m.headway) + 1;
  return Array.from({ length: n }, (_, i) => ({ wait: Math.max(0, (first + i) * m.headway - since), trip: first + i }));
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
  const tr = m.tracks[track], d = tr?.dwells[stop];
  if (!tr || !d) return { standing: false, seconds: Infinity };
  const dwell = d.t1 - d.t0, u = ((((tick / TICK_HZ - tr.phase - d.t0) % m.headway) + m.headway) % m.headway);
  return u < dwell ? { standing: true, seconds: dwell - u } : { standing: false, seconds: u - dwell };
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
