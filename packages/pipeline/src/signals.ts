import { GraphIndex, prng, type Approach, type JunctionInfo, type NetGraph, type PedSignal, type Pole } from '@nn/shared';
import type { NetBuilder, LaneJunction } from './npcnet.js';
import type { Pt, Road } from './osm.js';
import { distToPolyline } from './polyline.js';

/** Traffic signal nodes this close (m) to a junction belong to it. */
const SIGNAL_RADIUS = 30;
/** Signal nodes this close (m) to each other are one midblock signal. */
const MIDBLOCK_CLUSTER = 20;
/** Cars stop this far (m) before the end of their arriving lane. */
const STOP_BACK = 3;
/** A give_way/stop node this close (m) to an arm's way and this close to the junction lowers that arm. */
const SIGN_TO_WAY = 6;
const SIGN_TO_JUNCTION = 30;
/** A car pole and a pedestrian pole this close (m) become one combined pole. */
const POLE_MERGE = 2.5;
/** Seconds of a signal cycle (for the offsets): junction and midblock. */
const CYCLE_S = 52, MIDBLOCK_CYCLE_S = 40;

const RANK: Record<string, number> = { primary: 5, secondary: 4, tertiary: 3, residential: 2, unclassified: 2, living_street: 1, service: 1 };
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);
const headingOf = (d: Pt): number => Math.atan2(d.x, d.z);

/** Two groups of directions by axis (angles mod π): k-means with k = 2 on the doubled angles. */
function axisGroups(dirs: Pt[]): (0 | 1)[] {
  const ang = dirs.map((d) => Math.atan2(d.z, d.x) * 2);
  let c = [ang[0]!, ang[0]! + Math.PI];
  let g: (0 | 1)[] = [];
  for (let it = 0; it < 8; it++) {
    g = ang.map((a) => (Math.cos(a - c[0]!) >= Math.cos(a - c[1]!) ? 0 : 1));
    c = [0, 1].map((k) => {
      let sx = 0, sz = 0;
      ang.forEach((a, i) => { if (g[i] === k) { sx += Math.cos(a); sz += Math.sin(a); } });
      return sx === 0 && sz === 0 ? c[k]! : Math.atan2(sz, sx);
    });
  }
  return g;
}

/** Last edge of a line (the arriving lane's piece at the junction) and its length. */
const lastEdge = (b: NetBuilder, l: unknown): number | undefined => {
  const es = b.edgesOf.get(l as never);
  return es?.[es.length - 1];
};

export type JunctionInput = {
  drive: { graph: NetGraph; b: NetBuilder; junctions: LaneJunction[] };
  cycle: { graph: NetGraph; b: NetBuilder; junctions: LaneJunction[] };
  walk: NetGraph;
  signals: Pt[]; giveWay: Pt[]; stops: Pt[]; seed: number;
};

/**
 * Junction info for every junction of the drive graph (three or more arms): approaches with signal group (two axis
 * groups), stop position and rank; turn arcs; the same for the cycle graph; and, where traffic signals stand within
 * 30 m, a signal with a seeded cycle offset, pedestrian signals on the walk crossings around it, poles (car poles right
 * of each stop line on the sidewalk, pedestrian poles at both ends of each crossing; close pairs combined) and stop
 * lines. Signals away from junctions become midblock pedestrian signals on the nearest way.
 */
export function buildJunctions(input: JunctionInput): JunctionInfo[] {
  const { drive, cycle, walk, signals, giveWay, stops, seed } = input;
  const driveIx = new GraphIndex(drive.graph), walkIx = new GraphIndex(walk);
  const signs = [...giveWay, ...stops];
  const usedSignals = new Set<number>();
  const out: JunctionInfo[] = [];
  const cycleByKey = new Map(cycle.junctions.map((j) => [j.key, j]));
  const cycleIx = new GraphIndex(cycle.graph);
  const turnEdges = new Set(drive.junctions.flatMap((lj) => lj.turns.flatMap((l) => drive.b.edgesOf.get(l) ?? [])));
  const rng = prng(seed);

  const rankOf = (road: Road, j: Pt): number => {
    let r = (RANK[road.kind] ?? 2) + (road.priority ? 1 : 0);
    if (signs.some((s) => dist(s, j) < SIGN_TO_JUNCTION && distToPolyline(s, road.points) < SIGN_TO_WAY)) r -= 1;
    return r;
  };

  for (const lj of drive.junctions) {
    const centre = { x: lj.x, z: lj.z };
    const groups = axisGroups(lj.arms.map((a) => a.dir));
    const sig = signals.map((s, i) => [s, i] as const).filter(([s]) => dist(s, centre) <= SIGNAL_RADIUS);
    for (const [, i] of sig) usedSignals.add(i);
    const signalled = sig.length > 0;
    const approaches: Approach[] = [];
    const armOfApproach: number[] = [];
    lj.arms.forEach((a, k) => {
      const e = a.inLine ? lastEdge(drive.b, a.inLine) : undefined;
      if (e === undefined) return;
      approaches.push({ edge: e, group: groups[k]!, stopS: r2(Math.max(0, driveIx.length(e) - STOP_BACK)), rank: rankOf(a.road, centre) });
      armOfApproach.push(k);
    });
    const cj = cycleByKey.get(lj.key);
    const cycleApproaches: Approach[] = [];
    const cycleTurns: number[] = [];
    if (cj) {
      cj.arms.forEach((a) => {
        const e = a.inLine ? lastEdge(cycle.b, a.inLine) : undefined;
        if (e === undefined) return;
        // the same arm of the drive junction: the one whose direction matches
        const k = lj.arms.reduce((best, o, i) => (o.dir.x * a.dir.x + o.dir.z * a.dir.z > lj.arms[best]!.dir.x * a.dir.x + lj.arms[best]!.dir.z * a.dir.z ? i : best), 0);
        cycleApproaches.push({ edge: e, group: groups[k]!, stopS: r2(Math.max(0, cycleIx.length(e) - STOP_BACK)), rank: rankOf(a.road, centre) });
      });
      for (const l of cj.turns) for (const e of cycle.b.edgesOf.get(l) ?? []) cycleTurns.push(e);
    }
    const turns: number[] = [];
    for (const l of lj.turns) for (const e of drive.b.edgesOf.get(l) ?? []) turns.push(e);

    const j: JunctionInfo = {
      x: r2(lj.x), z: r2(lj.z), signal: null, approaches, turns, cycleApproaches, cycleTurns, peds: [], poles: [], stopLines: [],
    };
    if (signalled) {
      j.signal = { id: out.length, offsetTicks: Math.floor(rng() * CYCLE_S * 60), midblock: false };
      // pedestrian crossings around the junction: crossing arm k walks across it, parallel to the other axis
      const reach = Math.max(...lj.arms.map((a) => a.kerb)) * 2 + 10;
      for (const ei of walkIx.near(lj.x, lj.z, reach)) {
        const e = walk.edges[ei]!;
        if (!e.crossing) continue;
        const m = e.pts[Math.floor(e.pts.length / 2)]!;
        const mid = { x: (e.pts[0]![0] + e.pts[e.pts.length - 1]![0]) / 2, z: (e.pts[0]![1] + e.pts[e.pts.length - 1]![1]) / 2 };
        if (dist(mid, centre) > reach || dist({ x: m[0], z: m[1] }, centre) > reach) continue;
        const to = { x: mid.x - lj.x, z: mid.z - lj.z };
        const l = Math.hypot(to.x, to.z) || 1;
        const k = lj.arms.reduce((best, a, i) => ((a.dir.x * to.x + a.dir.z * to.z) / l > (lj.arms[best]!.dir.x * to.x + lj.arms[best]!.dir.z * to.z) / l ? i : best), 0);
        j.peds.push({ walkEdge: ei, group: (1 - groups[k]!) as 0 | 1 });
      }
      approaches.forEach((ap, i) => {
        const a = lj.arms[armOfApproach[i]!]!;
        const e = drive.graph.edges[ap.edge]!;
        const p = pointOnEdge(e.pts, driveIx.cum[ap.edge]!, ap.stopS);
        const right = { x: -p.dir.z, z: p.dir.x };
        const half = a.laneWidth / 2;
        j.stopLines.push({ x0: r2(p.x - right.x * (half + 0.2)), z0: r2(p.z - right.z * (half + 0.2)), x1: r2(p.x + right.x * half), z1: r2(p.z + right.z * half) });
        const off = a.rightKerb + 0.5;
        j.poles.push({ x: r2(p.x + right.x * off), z: r2(p.z + right.z * off), heading: r3(headingOf({ x: -p.dir.x, z: -p.dir.z })), kind: 'car', approach: i });
      });
      addPedPoles(j, walk);
    }
    out.push(j);
  }

  // midblock signals: clusters of unused signal nodes
  const rest = signals.filter((_, i) => !usedSignals.has(i));
  const clusters: Pt[][] = [];
  for (const s of rest) {
    const c = clusters.find((cl) => dist(cl[0]!, s) < MIDBLOCK_CLUSTER);
    if (c) c.push(s);
    else clusters.push([s]);
  }
  for (const cl of clusters) {
    const s = { x: cl.reduce((a, p) => a + p.x, 0) / cl.length, z: cl.reduce((a, p) => a + p.z, 0) / cl.length };
    const approaches: Approach[] = [];
    for (const ei of driveIx.near(s.x, s.z, 12)) {
      const e = drive.graph.edges[ei]!;
      if (turnEdges.has(ei)) continue;
      const n = nearestOn(e.pts, driveIx.cum[ei]!, s);
      if (n.d > e.width + 1.5 || n.s < STOP_BACK + 1) continue;
      approaches.push({ edge: ei, group: 0, stopS: r2(n.s - STOP_BACK), rank: 2 });
    }
    if (!approaches.length) continue;
    const j: JunctionInfo = {
      x: r2(s.x), z: r2(s.z), signal: { id: out.length, offsetTicks: Math.floor(rng() * MIDBLOCK_CYCLE_S * 60), midblock: true },
      approaches, turns: [], cycleApproaches: [], cycleTurns: [], peds: [], poles: [], stopLines: [],
    };
    for (const ei of cycleIx.near(s.x, s.z, 10)) {
      const e = cycle.graph.edges[ei]!;
      const n = nearestOn(e.pts, cycleIx.cum[ei]!, s);
      if (n.d < 4 && n.s > STOP_BACK + 1) j.cycleApproaches.push({ edge: ei, group: 0, stopS: r2(n.s - STOP_BACK), rank: 2 });
    }
    const w = walkIx.nearestEdge(s.x, s.z, 10);
    if (w && walk.edges[w.edge]!.crossing) j.peds.push({ walkEdge: w.edge, group: 1 });
    approaches.forEach((ap, i) => {
      const e = drive.graph.edges[ap.edge]!;
      const p = pointOnEdge(e.pts, driveIx.cum[ap.edge]!, ap.stopS);
      const right = { x: -p.dir.z, z: p.dir.x };
      const half = e.width / 2;
      j.stopLines.push({ x0: r2(p.x - right.x * (half + 0.2)), z0: r2(p.z - right.z * (half + 0.2)), x1: r2(p.x + right.x * half), z1: r2(p.z + right.z * half) });
      // the pole stands beside the road: beyond the carriageway edge on the lane's right (lane centre + 1.5 lane widths)
      const off = e.width * 1.5 + 0.5;
      j.poles.push({ x: r2(p.x + right.x * off), z: r2(p.z + right.z * off), heading: r3(headingOf({ x: -p.dir.x, z: -p.dir.z })), kind: 'car', approach: i });
    });
    addPedPoles(j, walk);
    out.push(j);
  }
  return out;
}

/** Pedestrian poles at both ends of each signalled crossing, facing across it; a car pole close to one takes it over. */
function addPedPoles(j: JunctionInfo, walk: NetGraph): void {
  j.peds.forEach((ps: PedSignal, i) => {
    const e = walk.edges[ps.walkEdge]!;
    const a = { x: e.pts[0]![0], z: e.pts[0]![1] }, b = { x: e.pts[e.pts.length - 1]![0], z: e.pts[e.pts.length - 1]![1] };
    for (const [p, q] of [[a, b], [b, a]] as const) {
      const d = { x: q.x - p.x, z: q.z - p.z };
      const l = Math.hypot(d.x, d.z) || 1;
      // 0.6 m back from the crossing's end, onto the sidewalk
      const at = { x: p.x - (d.x / l) * 0.6, z: p.z - (d.z / l) * 0.6 };
      const car = j.poles.find((c: Pole) => c.kind === 'car' && dist(c, at) < POLE_MERGE);
      if (car) {
        car.kind = 'car+ped';
        car.ped = i;
      } else j.poles.push({ x: r2(at.x), z: r2(at.z), heading: r3(headingOf(d)), kind: 'ped', ped: i });
    }
  });
}

/** Point and unit direction at distance s along pts. */
function pointOnEdge(pts: [number, number][], cum: number[], s: number): { x: number; z: number; dir: Pt } {
  let k = 1;
  while (k < pts.length - 1 && cum[k]! < s) k++;
  const [ax, az] = pts[k - 1]!, [bx, bz] = pts[k]!;
  const l = cum[k]! - cum[k - 1]! || 1;
  const t = Math.max(0, Math.min(1, (s - cum[k - 1]!) / l));
  const dl = Math.hypot(bx - ax, bz - az) || 1;
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dir: { x: (bx - ax) / dl, z: (bz - az) / dl } };
}

/** Distance along pts (s) of the point nearest to p, and the distance to it (d). */
function nearestOn(pts: [number, number][], cum: number[], p: Pt): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1]!, [bx, bz] = pts[k]!;
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2)) : 0;
    const d = Math.hypot(p.x - ax - t * dx, p.z - az - t * dz);
    if (d < best.d) best = { s: cum[k - 1]! + t * Math.sqrt(l2), d };
  }
  return best;
}
