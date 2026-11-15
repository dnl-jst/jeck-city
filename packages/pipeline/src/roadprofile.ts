import type { CrossSection } from './crosssection.js';
import type { Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, junctions, pointAt, ptKey } from './polyline.js';

/**
 * Distances (m, ≥ 0) from the way's centre line to the edges on one side: the outer edge of the car lanes, of the
 * cycle lane and the kerb (outer edge of the parking strip).
 */
export type SideEdges = { lane: number; cycle: number; kerb: number };
export type EdgeKey = keyof SideEdges;
const KEYS: EdgeKey[] = ['lane', 'cycle', 'kerb'];

/**
 * Side geometry of a cross-section: the car lanes lie symmetric about the way's centre line, cycle lane and
 * parking strip are added outwards on their own side (so a strip that appears on one side does not move the lanes).
 */
export function sideOffsets(c: CrossSection): { left: SideEdges; right: SideEdges } {
  const lane = ((c.lanesForward + c.lanesBackward) * c.laneWidth) / 2;
  const side = (cycle: number, park: number): SideEdges => ({ lane, cycle: lane + cycle, kerb: lane + cycle + park });
  return { left: side(c.cycleLeft, c.parkLeft), right: side(c.cycleRight, c.parkRight) };
}

/**
 * Per vertex of dedupe(road.points): the edges on each side and the centre line's offset (between the directions'
 * lanes, signed, right of travel > 0); arc lengths; ramp intervals [s0, s1] (incl. their run-out to the node);
 * laneEnds: where this way's lanes ramp to a neighbour with other lane counts (counts in this way's direction).
 */
export type Profile = {
  cum: number[]; left: SideEdges[]; right: SideEdges[]; centre: number[]; ramps: [number, number][];
  laneEnds: { s0: number; s1: number; fwd: number; bwd: number }[];
};

/** Centre line offset of a cross-section: lanes symmetric about the way, the backward lanes on the left. */
export const centreOffset = (c: CrossSection): number => -sideOffsets(c).left.lane + c.lanesBackward * c.laneWidth;

const cache = new WeakMap<Road, Profile>();

/** The road's profile: the one withProfiles attached, else constant edges from its cross-section. */
export function profileOf(r: Road): Profile {
  if (r.profile) return r.profile;
  let p = cache.get(r);
  if (!p) {
    const pts = dedupe(r.points);
    const o = sideOffsets(r.cross);
    p = { cum: cumulative(pts), left: pts.map(() => o.left), right: pts.map(() => o.right), centre: pts.map(() => centreOffset(r.cross)), ramps: [], laneEnds: [] };
    cache.set(r, p);
  }
  return p;
}

/** One edge on side (+1 right of travel, -1 left) per vertex of dedupe(road.points). */
export function edges(r: Road, side: number, key: EdgeKey): number[] {
  const p = profileOf(r);
  return (side > 0 ? p.right : p.left).map((e) => e[key]);
}

/** One edge on side at arc length s (linear between vertices, clamped). */
export function edgeAt(r: Road, side: number, key: EdgeKey, s: number): number {
  const p = profileOf(r);
  const v = side > 0 ? p.right : p.left;
  const cum = p.cum;
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < s) i++;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1)));
  return v[i - 1]![key] + (v[i]![key] - v[i - 1]![key]) * t;
}

/** Centre line offset at arc length s (follows lane ramps). */
export function centreAt(r: Road, s: number): number {
  const p = profileOf(r);
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i]! < s) i++;
  const t = Math.min(1, Math.max(0, (s - p.cum[i - 1]!) / (p.cum[i]! - p.cum[i - 1]! || 1)));
  return p.centre[i - 1]! + (p.centre[i]! - p.centre[i - 1]!) * t;
}

/** Lanes per direction at arc length s: inside a lane ramp only those the neighbouring way also has. */
export function laneCountsAt(r: Road, s: number): { fwd: number; bwd: number } {
  let fwd = r.cross.lanesForward, bwd = r.cross.lanesBackward;
  for (const e of profileOf(r).laneEnds) {
    if (s < Math.min(e.s0, e.s1) || s > Math.max(e.s0, e.s1)) continue;
    fwd = Math.min(fwd, e.fwd);
    bwd = Math.min(bwd, e.bwd);
  }
  return { fwd, bwd };
}

/** Whether [s0, s1] overlaps a ramp of the road. */
export const inRamp = (r: Road, s0: number, s1: number): boolean => profileOf(r).ramps.some(([a, b]) => s0 < b && s1 > a);

/** Nearest point of the road's centre line to p: arc length, signed lateral offset (right of travel > 0), segment direction. */
export function nearestOn(r: Road, p: Pt): { s: number; d: number; dir: Pt; dist: number } {
  const pts = dedupe(r.points);
  const cum = profileOf(r).cum;
  let best = { s: 0, d: Infinity, dir: { x: 1, z: 0 }, dist: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-12) continue;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    const fx = a.x + t * dx, fz = a.z + t * dz;
    const dd = Math.hypot(p.x - fx, p.z - fz);
    if (dd < best.dist) {
      const l = Math.sqrt(l2);
      best = { s: cum[i - 1]! + t * l, d: ((p.x - fx) * -dz + (p.z - fz) * dx) / l, dir: { x: dx / l, z: dz / l }, dist: dd };
    }
  }
  return best;
}

/** Whether p lies on the road's carriageway widened by `margin` (side-aware: each side up to its own kerb). */
export function onCarriageway(r: Road, p: Pt, margin = 0): boolean {
  const n = nearestOn(r, p);
  return n.dist < edgeAt(r, n.d >= 0 ? 1 : -1, 'kerb', n.s) + margin;
}

const RAMP_MIN = 6;
const COS30 = Math.cos((30 * Math.PI) / 180);
const JUNCTION_RUNOUT = 1; // at a junction the ramp starts this far beyond the widest crossing kerb

type End = { road: Road; pts: Pt[]; atStart: boolean };
/** Unit direction pointing out of the way at its end. */
const outward = (e: End): Pt => {
  const [a, b] = e.atStart ? [e.pts[1]!, e.pts[0]!] : [e.pts[e.pts.length - 2]!, e.pts[e.pts.length - 1]!];
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};

/**
 * Roads with profiles: where two consecutive ways of the same name meet end to end (continuing within ±30°) and an
 * edge of one side changes, the wider way narrows linearly to the other's value over max(6 m, 2 × the largest |Δ|
 * at that end; the centre line's shift counts too) before the
 * node (at a junction: beyond the widest crossing kerb + 1 m, the rest up to the node at the narrower value; on
 * short ways the run-out, then the ramp shrinks to fit half the way), so
 * kerbs, cycle lanes and strips run on without steps. Where the lanes change (width, centre line, counts), the way
 * with the wider lanes (equal: the lower id) ramps its centre line and records a laneEnd, so its extra dividers end
 * at the ramp start. Ramp ends become vertices; road.points are deduplicated.
 */
export function withProfiles(roads: Road[]): Road[] {
  const net = roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service');
  const junc = junctions(net.map((r) => dedupe(r.points)));
  const ends = new Map<string, End[]>();
  const touching = new Map<string, Road[]>(); // drivable roads through or ending at a junction node
  for (const r of roads) {
    const pts = dedupe(r.points);
    if (pts.length < 2 || !DRIVABLE.has(r.kind)) continue;
    for (const atStart of [true, false]) {
      const k = ptKey(atStart ? pts[0]! : pts[pts.length - 1]!);
      ends.set(k, [...(ends.get(k) ?? []), { road: r, pts, atStart }]);
    }
    for (const p of pts) if (junc.has(ptKey(p))) touching.set(ptKey(p), [...(touching.get(ptKey(p)) ?? []), r]);
  }

  return roads.map((r) => {
    const pts = dedupe(r.points);
    if (pts.length < 2 || !DRIVABLE.has(r.kind) || !r.name) return { ...r, points: pts };
    const base = sideOffsets(r.cross);
    const total = cumulative(pts)[pts.length - 1]!;
    const centre0 = centreOffset(r.cross);
    /** Ramps per side (0: the centre line) and key: (s at the wide end, s at the narrow end, target value). */
    const ramps: { side: number; key: EdgeKey | 'centre'; s0: number; s1: number; to: number }[] = [];
    const intervals: [number, number][] = [];
    const laneEnds: Profile['laneEnds'] = [];
    for (const atStart of [true, false]) {
      const me: End = { road: r, pts, atStart };
      const k = ptKey(atStart ? pts[0]! : pts[pts.length - 1]!);
      const out = outward(me);
      let next: { e: End; dot: number } | undefined;
      for (const e of ends.get(k) ?? []) {
        if (e.road === r || e.road.name !== r.name) continue;
        const o = outward(e);
        const dot = -(o.x * out.x + o.z * out.z); // the other way continues away from the node
        if (dot >= COS30 && (!next || dot > next.dot)) next = { e, dot };
      }
      if (!next) continue;
      const nb = next.e.road;
      const same = atStart !== next.e.atStart; // both drawn the same way through the node
      const other = sideOffsets(nb.cross);
      const others = (touching.get(k) ?? []).filter((q) => q !== r && q !== nb);
      const runout = others.length ? Math.max(...others.map((q) => { const o = sideOffsets(q.cross); return Math.max(o.left.kerb, o.right.kerb); })) + JUNCTION_RUNOUT : 0;
      // edges: the wider way narrows to the other's value
      const changes: { side: number; key: EdgeKey | 'centre'; to: number; d: number }[] = [];
      for (const side of [1, -1]) {
        const mine = side > 0 ? base.right : base.left;
        const theirs = (side > 0) === same ? other.right : other.left;
        for (const key of KEYS) if (mine[key] - theirs[key] > 1e-3) changes.push({ side, key, to: theirs[key], d: mine[key] - theirs[key] });
      }
      // centre line and lane counts: the way with the wider lanes ramps them (equal width: the lower id)
      const theirCentre = (same ? 1 : -1) * centreOffset(nb.cross);
      const counts = same ? { fwd: nb.cross.lanesForward, bwd: nb.cross.lanesBackward } : { fwd: nb.cross.lanesBackward, bwd: nb.cross.lanesForward };
      const dLane = base.left.lane - other.left.lane;
      const lanesDiffer = Math.abs(centre0 - theirCentre) > 1e-3 || counts.fwd !== r.cross.lanesForward || counts.bwd !== r.cross.lanesBackward;
      const ownsLanes = lanesDiffer && (dLane > 1e-3 || (Math.abs(dLane) <= 1e-3 && r.id < nb.id));
      if (ownsLanes && Math.abs(centre0 - theirCentre) > 1e-3) changes.push({ side: 0, key: 'centre', to: theirCentre, d: Math.abs(centre0 - theirCentre) });
      if (!changes.length && !ownsLanes) continue;
      if (total / 2 < 0.5) continue; // a stub: keep its own width
      const len = Math.max(RAMP_MIN, 2 * Math.max(0, ...changes.map((c) => c.d)));
      // short ways between junctions: the run-out shrinks first, then the ramp (it never passes the middle)
      const run = Math.max(0, Math.min(runout, total / 2 - len));
      const l = Math.min(len, total / 2 - run);
      const [wide, narrow, node] = atStart ? [run + l, run, 0] : [total - run - l, total - run, total];
      for (const c of changes) ramps.push({ side: c.side, key: c.key, s0: wide, s1: narrow, to: c.to });
      intervals.push(atStart ? [node, wide] : [wide, node]);
      if (ownsLanes) laneEnds.push({ s0: wide, s1: node, ...counts });
    }
    if (!ramps.length && !laneEnds.length) return { ...r, points: pts };
    // ramp ends become vertices
    const cuts = [...new Set([...ramps.flatMap((q) => [q.s0, q.s1]), ...laneEnds.map((e) => e.s0)])].filter((s) => s > 1e-3 && s < total - 1e-3);
    const cum0 = cumulative(pts);
    const all = [...cum0.map((s, i) => ({ s, p: pts[i]! })), ...cuts.map((s) => ({ s, p: pointAt(pts, cum0, s).p }))].sort((a, b) => a.s - b.s);
    const points = dedupe(all.map((q) => q.p));
    const cum = cumulative(points);
    const value = (side: number, key: EdgeKey | 'centre', s: number): number => {
      let v = key === 'centre' ? centre0 : (side > 0 ? base.right : base.left)[key];
      for (const q of ramps) {
        if (q.side !== side || q.key !== key) continue;
        const t = (s - q.s0) / (q.s1 - q.s0); // 0 at the wide end, 1 at the narrow end, > 1 towards the node
        if (t > 0) v += (q.to - v) * Math.min(1, t);
      }
      return v;
    };
    const at = (side: number) => cum.map((s) => ({ lane: value(side, 'lane', s), cycle: value(side, 'cycle', s), kerb: value(side, 'kerb', s) }));
    return { ...r, points, profile: { cum, left: at(-1), right: at(1), centre: cum.map((s) => value(0, 'centre', s)), ramps: intervals, laneEnds } };
  });
}
