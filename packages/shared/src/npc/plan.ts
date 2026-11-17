import { TICK_HZ } from '../net/constants';
import type { NpcPose, PathPt, Plan, SpeedRamp } from './types';

/** Acceleration (m/s²) of a ramp when buildPlan is not given one. */
const DEFAULT_ACCEL = 1.5;
/** The heading turns over this distance (m) before and after a corner of the path. */
const CORNER_BLEND = 0.5;

type Cache = { cum: number[]; length: number; rampT: number[]; duration: number };
const caches = new WeakMap<Plan, Cache>();

const rampTime = (r: SpeedRamp): number => {
  const d = r.s1 - r.s0;
  if (d <= 0) return 0;
  const v = r.v0 + r.v1;
  return v > 0 ? (2 * d) / v : Infinity;
};

function cacheOf(p: Plan): Cache {
  let c = caches.get(p);
  if (c) return c;
  const cum = [0];
  for (let i = 1; i < p.path.length; i++) {
    const a = p.path[i - 1]!, b = p.path[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
  }
  const rampT = [0];
  for (const r of p.ramps) rampT.push(rampT[rampT.length - 1]! + rampTime(r));
  const moving = p.action === 'move' || p.action === 'down';
  const total = rampT[rampT.length - 1]!;
  const duration = moving ? Math.ceil(total * TICK_HZ - 1e-9) : Infinity;
  c = { cum, length: cum[cum.length - 1]!, rampT, duration };
  caches.set(p, c);
  return c;
}

/** Ticks from startTick until the plan's end (Infinity for wait and sit). */
export function planDuration(p: Plan): number {
  return cacheOf(p).duration;
}

/** Distance travelled and speed t seconds into the ramps. */
function travel(p: Plan, c: Cache, t: number): { s: number; v: number } {
  for (let i = 0; i < p.ramps.length; i++) {
    const r = p.ramps[i]!;
    const t0 = c.rampT[i]!, t1 = c.rampT[i + 1]!;
    if (t > t1) continue;
    const d = r.s1 - r.s0, dt = t - t0;
    const a = d > 0 ? (r.v1 * r.v1 - r.v0 * r.v0) / (2 * d) : 0;
    return { s: Math.min(r.s1, r.s0 + r.v0 * dt + 0.5 * a * dt * dt), v: r.v0 + a * dt };
  }
  const last = p.ramps[p.ramps.length - 1];
  return { s: last ? last.s1 : 0, v: 0 };
}

const headingOfSeg = (a: PathPt, b: PathPt): number => Math.atan2(b.x - a.x, b.z - a.z);
const angleLerp = (a: number, b: number, k: number): number => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

/** Point, heading and pitch at distance s along the path (heading blended over CORNER_BLEND around each corner). */
function along(path: PathPt[], cum: number[], s: number): { x: number; y: number; z: number; heading: number; pitch: number } {
  if (path.length === 1) return { ...path[0]!, heading: 0, pitch: 0 };
  let i = 1;
  while (i < path.length - 1 && cum[i]! < s) i++;
  const a = path[i - 1]!, b = path[i]!;
  const len = cum[i]! - cum[i - 1]!;
  const k = len > 0 ? Math.max(0, Math.min(1, (s - cum[i - 1]!) / len)) : 0;
  let heading = headingOfSeg(a, b);
  const flat = Math.hypot(b.x - a.x, b.z - a.z);
  const pitch = Math.atan2(b.y - a.y, flat);
  // approaching the corner at b: blend towards the next segment's heading; just past the corner at a: from the previous
  if (i < path.length - 1) {
    const w = Math.min(CORNER_BLEND, len / 2, (cum[i + 1]! - cum[i]!) / 2);
    const toEnd = cum[i]! - s;
    if (w > 0 && toEnd < w) heading = angleLerp(heading, headingOfSeg(b, path[i + 1]!), 0.5 * (1 - toEnd / w));
  }
  if (i > 1) {
    const w = Math.min(CORNER_BLEND, len / 2, (cum[i - 1]! - cum[i - 2]!) / 2);
    const fromStart = s - cum[i - 1]!;
    if (w > 0 && fromStart < w) heading = angleLerp(headingOfSeg(path[i - 2]!, a), heading, 0.5 + 0.5 * (fromStart / w));
  }
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, heading, pitch };
}

/** Where the NPC of plan `p` is at `tick` (the only way NPC positions are computed, on the server and the clients). */
export function planAt(p: Plan, tick: number): NpcPose {
  const c = cacheOf(p);
  const t = (tick - p.startTick) / TICK_HZ;
  if (p.action !== 'move' && p.action !== 'down') {
    const at = along(p.path, c.cum, 0);
    return { ...at, speed: 0, s: 0, done: false };
  }
  if (t <= 0) return { ...along(p.path, c.cum, 0), speed: 0, s: 0, done: false };
  if (tick - p.startTick >= c.duration) return { ...along(p.path, c.cum, c.length), speed: 0, s: c.length, done: true };
  const { s, v } = travel(p, c, t);
  return { ...along(p.path, c.cum, s), speed: v, s, done: false };
}

/**
 * A plan along `path`: starting at startSpeed (default speed), cruising at speed, ending at endSpeed (default speed),
 * changing speed at `accel` m/s². If the path is too short to reach the cruising speed, the peak is lowered.
 */
export function buildPlan(p: Omit<Plan, 'ramps'> & { speed: number; startSpeed?: number; endSpeed?: number; accel?: number }): Plan {
  const { speed, startSpeed, endSpeed, accel, ...rest } = p;
  const plan: Plan = { ...rest, ramps: [] };
  if (p.action !== 'move' && p.action !== 'down') return plan;
  let L = 0;
  for (let i = 1; i < p.path.length; i++) {
    const a = p.path[i - 1]!, b = p.path[i]!;
    L += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  const a = accel ?? DEFAULT_ACCEL;
  const vs = startSpeed ?? speed, ve = endSpeed ?? speed;
  let vp = speed;
  let d1 = Math.max(0, (vp * vp - vs * vs) / (2 * a)), d2 = Math.max(0, (vp * vp - ve * ve) / (2 * a));
  if (d1 + d2 > L) {
    vp = Math.sqrt(Math.max(0, (2 * a * L + vs * vs + ve * ve) / 2));
    d1 = Math.max(0, (vp * vp - vs * vs) / (2 * a));
    d2 = Math.max(0, L - d1);
  }
  const ramps: SpeedRamp[] = [];
  if (d1 > 0) ramps.push({ s0: 0, s1: d1, v0: vs, v1: vp });
  if (L - d1 - d2 > 1e-9) ramps.push({ s0: d1, s1: L - d2, v0: vp, v1: vp });
  if (d2 > 0) ramps.push({ s0: L - d2, s1: L, v0: vp, v1: ve });
  plan.ramps = ramps;
  return plan;
}
