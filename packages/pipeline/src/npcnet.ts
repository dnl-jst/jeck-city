import { GraphIndex, prng, type NetEdge, type NetGraph, type NpcNet, type SeatRing } from '@nn/shared';
import { buildJunctions } from './signals.js';
import type { BuildingMesh } from './buildings.js';
import { footprintContains } from './footprint.js';
import type { Pt, Road } from './osm.js';
import { cumulative, dedupe, distToPolyline, DRIVABLE, offsetLine, pointAt, pointInPolygon } from './polyline.js';
import { edgeAt, onCarriageway } from './roadprofile.js';
import { buildingGrid, widthAt, type SidewalkWidths } from './sidewalkwidth.js';

/** Edges are densified to points at most this far apart (m), so the server can follow the terrain along them. */
export const NET_STEP = 4;
/** Ways people walk on besides the sidewalks. */
const WALK_KINDS = new Set(['footway', 'path', 'pedestrian']);
/** Width (m) of crossing and corner connectors. */
const CROSSING_WIDTH = 3;
/** A footway end this close (m) to another walk line is joined to it. */
const ATTACH_MAX = 10;
/** A sidewalk point inside a building is moved to this distance (m) beyond the kerb. */
const KERB_HUG = 0.6;
/** Node positions are merged on this grid (m). */
const SNAP = 0.05;

const key = (p: Pt): string => `${Math.round(p.x / SNAP)},${Math.round(p.z / SNAP)}`;
const d2 = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);
/** Spatial grid cell (m). */
const CELL = 50;

/** Items with a bounding box, by the CELL cells it touches. */
export class BoxGrid<T> {
  private readonly cells = new Map<string, T[]>();
  add(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
      for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
        const c = `${cx},${cz}`;
        (this.cells.get(c) ?? this.cells.set(c, []).get(c)!).push(item);
      }
    }
  }
  /** Items whose cells overlap the square of half-size r around (x, z). */
  near(x: number, z: number, r: number): Set<T> {
    const out = new Set<T>();
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) for (const t of this.cells.get(`${cx},${cz}`) ?? []) out.add(t);
    }
    return out;
  }
}

const bboxOf = (pts: Pt[]): [number, number, number, number] => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.z); c = Math.max(c, p.x); d = Math.max(d, p.z); }
  return [a, b, c, d];
};

type Line = { pts: Pt[]; width: number; crossing: boolean; oneway: boolean };

/**
 * Collects polylines and turns them into a graph: a vertex becomes a node where a line ends or where its position is
 * shared with another line; lines are split at nodes and densified to NET_STEP.
 */
export class NetBuilder {
  readonly lines: Line[] = [];
  /** Lines by the 50 m cells their segments touch. */
  private readonly cells = new Map<string, Set<Line>>();
  /** Lines by the positions (key) of their points. */
  private readonly atKey = new Map<string, Set<Line>>();

  add(pts: Pt[], width: number, crossing = false, oneway = false): Line | null {
    const clean = dedupeSnap(pts);
    if (clean.length < 2) return null;
    const l = { pts: clean, width, crossing, oneway };
    this.lines.push(l);
    this.index(l);
    return l;
  }

  private index(l: Line): void {
    for (let i = 0; i < l.pts.length; i++) {
      const k = key(l.pts[i]!);
      (this.atKey.get(k) ?? this.atKey.set(k, new Set()).get(k)!).add(l);
      if (i === 0) continue;
      const a = l.pts[i - 1]!, b = l.pts[i]!;
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++) {
        for (let cz = Math.floor(Math.min(a.z, b.z) / CELL); cz <= Math.floor(Math.max(a.z, b.z) / CELL); cz++) {
          const c = `${cx},${cz}`;
          (this.cells.get(c) ?? this.cells.set(c, new Set()).get(c)!).add(l);
        }
      }
    }
  }

  /** Whether another line than `l` has a point at p. */
  shared(p: Pt, l: Line): boolean {
    for (const o of this.atKey.get(key(p)) ?? []) if (o !== l) return true;
    return false;
  }

  /** Joins p to the nearest point of another line within maxD (that point becomes a vertex there); false if none. */
  attach(p: Pt, maxD: number, skip?: Line, width = CROSSING_WIDTH, isCrossing?: (a: Pt, b: Pt) => boolean): boolean {
    let best: { l: Line; i: number; q: Pt; d: number } | null = null;
    const cand = new Set<Line>();
    for (let cx = Math.floor((p.x - maxD) / CELL); cx <= Math.floor((p.x + maxD) / CELL); cx++) {
      for (let cz = Math.floor((p.z - maxD) / CELL); cz <= Math.floor((p.z + maxD) / CELL); cz++) for (const l of this.cells.get(`${cx},${cz}`) ?? []) cand.add(l);
    }
    for (const l of cand) {
      if (l === skip) continue;
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1]!, b = l.pts[i]!;
        const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
        const q = { x: a.x + t * dx, z: a.z + t * dz };
        const d = d2(p, q);
        if (d <= maxD && (!best || d < best.d)) best = { l, i, q, d };
      }
    }
    if (!best) return false;
    const { l, i, q } = best;
    if (key(q) !== key(l.pts[i - 1]!) && key(q) !== key(l.pts[i]!)) {
      l.pts.splice(i, 0, q);
      (this.atKey.get(key(q)) ?? this.atKey.set(key(q), new Set()).get(key(q))!).add(l);
    }
    if (key(q) !== key(p)) this.add([p, q], width, isCrossing?.(p, q) ?? false);
    return true;
  }

  build(): NetGraph {
    const count = new Map<string, number>();
    for (const l of this.lines) for (const k of new Set(l.pts.map(key))) count.set(k, (count.get(k) ?? 0) + 1);
    const g: NetGraph = { nodes: [], edges: [] };
    const ids = new Map<string, number>();
    const node = (p: Pt): number => {
      const k = key(p);
      let id = ids.get(k);
      if (id === undefined) {
        id = g.nodes.length;
        ids.set(k, id);
        g.nodes.push([r2(p.x), r2(p.z)]);
      }
      return id;
    };
    for (const l of this.lines) {
      let start = 0;
      for (let i = 1; i < l.pts.length; i++) {
        if (i < l.pts.length - 1 && (count.get(key(l.pts[i]!)) ?? 0) < 2) continue;
        const piece = l.pts.slice(start, i + 1);
        const a = node(piece[0]!), b = node(piece[piece.length - 1]!);
        if (a !== b) {
          const e: NetEdge = { a, b, pts: densify(piece).map((p) => [r2(p.x), r2(p.z)]), width: r2(l.width), oneway: l.oneway };
          if (l.crossing) e.crossing = true;
          const list = this.edgesOf.get(l);
          if (list) list.push(g.edges.length);
          else this.edgesOf.set(l, [g.edges.length]);
          g.edges.push(e);
        }
        start = i;
      }
    }
    return g;
  }

  /** After build(): the edges each line became, in order along it. */
  readonly edgesOf = new Map<Line, number[]>();
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

function dedupeSnap(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || key(out[out.length - 1]!) !== key(p)) out.push(p);
  return out;
}

/** Points at most NET_STEP apart (the original vertices kept). */
export function densify(pts: Pt[], step = NET_STEP): Pt[] {
  if (!pts.length) return [];
  const out = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const n = Math.max(1, Math.ceil(d2(a, b) / step - 1e-9));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** The part of a polyline from arc length s0 to s1. */
function trim(pts: Pt[], s0: number, s1: number): Pt[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1]!;
  s0 = Math.max(0, s0);
  s1 = Math.min(total, s1);
  if (s1 - s0 < 0.3) return [];
  const out = [pointAt(pts, cum, s0).p];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i]! > s0 && cum[i]! < s1) out.push(pts[i]!);
  out.push(pointAt(pts, cum, s1).p);
  return out;
}

/** A drivable way cut at junction nodes: its points with arc lengths on the whole way. */
type Piece = { road: Road; pts: Pt[]; s: number[]; widths: SidewalkWidths };
/** A piece leaving a node: direction away from it, sidewalk centre offsets right/left of that direction, and its end. */
type Arm = { piece: Piece; atStart: boolean; dir: Pt; offR: number; offL: number; angle: number };

/** Offset of the sidewalk centre on side (+1 right of the way, -1 left) at arc length s. */
const sideOffset = (p: Piece, side: number, s: number): number => edgeAt(p.road, side, 'kerb', s) + widthAt(p.widths, side, s) / 2;

/**
 * The walking network: a centre line along each sidewalk of every drivable way (kerb + half the sidewalk width),
 * ending short of junctions where it would reach into another way's carriageway; corner connectors between the
 * sidewalks of neighbouring arms; crossings over every arm at junctions of three or more arms and at OSM crossings
 * on a way; footways, paths and pedestrian ways, joined to the nearest walk line within 10 m. Sidewalk points inside
 * a building move to 0.6 m beyond the kerb, or are dropped if that is inside too.
 */
export function buildWalkGraph(roads: Road[], sidewalks: Map<Road, SidewalkWidths>, crossings: Pt[], buildings: BuildingMesh[]): NetGraph {
  const drivable = roads.filter((r) => DRIVABLE.has(r.kind) && sidewalks.has(r) && dedupe(r.points).length >= 2);
  const grid = buildingGrid(buildings);
  const inBuilding = (p: Pt): boolean => grid.near(p, 0.5).some((b) => footprintContains(b, p.x, p.z));
  const roadGrid = new BoxGrid<Road>();
  for (const r of drivable) roadGrid.add(r, ...bboxOf(r.points));
  const onAnyCarriageway = (p: Pt): boolean => [...roadGrid.near(p.x, p.z, 25)].some((r) => onCarriageway(r, p));
  const crossingGrid = new BoxGrid<Pt>();
  for (const c of crossings) crossingGrid.add(c, c.x, c.z, c.x, c.z);

  // nodes: vertices shared by two or more drivable ways (or appearing twice in one)
  const uses = new Map<string, number>();
  for (const r of drivable) dedupe(r.points).forEach((p, i, a) => uses.set(key(p), (uses.get(key(p)) ?? 0) + (i === 0 || i === a.length - 1 ? 1 : 2)));
  const isNode = (p: Pt): boolean => (uses.get(key(p)) ?? 0) >= 2;

  const pieces: Piece[] = [];
  for (const r of drivable) {
    const pts = dedupe(r.points), cum = cumulative(pts);
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      if (i < pts.length - 1 && !isNode(pts[i]!)) continue;
      pieces.push({ road: r, pts: pts.slice(start, i + 1), s: cum.slice(start, i + 1), widths: sidewalks.get(r)! });
      start = i;
    }
  }

  // arms per node
  const arms = new Map<string, Arm[]>();
  for (const pc of pieces) {
    for (const atStart of [true, false]) {
      const end = atStart ? pc.pts[0]! : pc.pts[pc.pts.length - 1]!;
      if (!isNode(end)) continue;
      const next = atStart ? pc.pts[1]! : pc.pts[pc.pts.length - 2]!;
      const l = d2(end, next) || 1;
      const dir = { x: (next.x - end.x) / l, z: (next.z - end.z) / l };
      const s = atStart ? pc.s[0]! : pc.s[pc.s.length - 1]!;
      // right of the arm's direction away from the node is the way's right when the arm starts there, else its left
      const offR = sideOffset(pc, atStart ? 1 : -1, s), offL = sideOffset(pc, atStart ? -1 : 1, s);
      const list = arms.get(key(end)) ?? [];
      list.push({ piece: pc, atStart, dir, offR, offL, angle: Math.atan2(dir.z, dir.x) });
      arms.set(key(end), list);
    }
  }
  /** How far (m) from the node an arm's sidewalks end: clear of the other arms' sidewalks. */
  const cutOf = new Map<Arm, number>();
  for (const list of arms.values()) {
    for (const a of list) {
      let cut = 0;
      for (const o of list) {
        if (o === a) continue;
        const sin = Math.abs(a.dir.x * o.dir.z - a.dir.z * o.dir.x);
        const cos = a.dir.x * o.dir.x + a.dir.z * o.dir.z;
        if (cos < -0.87) continue; // runs on straight ahead: no cut
        cut = Math.max(cut, Math.min(25, Math.max(o.offR, o.offL) / Math.max(0.3, sin)));
      }
      cutOf.set(a, cut);
    }
  }

  const b = new NetBuilder();
  /** The sidewalk ends at nodes: per arm, its right and left end points. */
  const ends = new Map<Arm, { r: Pt | null; l: Pt | null }>();
  const armAt = (pc: Piece, atStart: boolean): Arm | undefined => arms.get(key(atStart ? pc.pts[0]! : pc.pts[pc.pts.length - 1]!))?.find((a) => a.piece === pc && a.atStart === atStart);

  for (const pc of pieces) {
    const cumP = cumulative(pc.pts), total = cumP[cumP.length - 1]!;
    const a0 = armAt(pc, true), a1 = armAt(pc, false);
    const cut0 = a0 ? cutOf.get(a0)! : 0, cut1 = a1 ? cutOf.get(a1)! : 0;
    // OSM crossings on this piece: arc lengths
    const [bx0, bz0, bx1, bz1] = bboxOf(pc.pts);
    const crossAt = [...crossingGrid.near((bx0 + bx1) / 2, (bz0 + bz1) / 2, Math.max(bx1 - bx0, bz1 - bz0) / 2 + 30)]
      .map((c) => ({ c, n: nearestArc(pc.pts, cumP, c) }))
      .filter(({ n }) => n.dist < edgeAt(pc.road, 1, 'kerb', pc.s[0]! + n.s) + 1 && n.s > cut0 + 1 && n.s < total - cut1 - 1)
      .map(({ n }) => n.s);
    const stations = [cut0, ...crossAt.sort((x, y) => x - y), total - cut1];
    const sideLine = (side: number): Pt[] => {
      const off = pc.pts.map((_, i) => side * sideOffset(pc, side, pc.s[i]!));
      const line = offsetLine(pc.pts, off);
      // keep points out of buildings: hug the kerb, else drop
      const hug = offsetLine(pc.pts, pc.pts.map((_, i) => side * (edgeAt(pc.road, side, 'kerb', pc.s[i]!) + KERB_HUG)));
      return line.map((p, i) => (inBuilding(p) ? hug[i]! : p));
    };
    for (const side of [1, -1]) {
      const line = sideLine(side);
      const lineCum = cumulative(line);
      // stations on the offset line: by the fraction of the centre line's length
      const st = stations.map((s) => (s / (total || 1)) * lineCum[lineCum.length - 1]!);
      for (let k = 1; k < st.length; k++) {
        const part = trim(line, st[k - 1]!, st[k]!);
        // split where a point is (still) inside a building
        let run: Pt[] = [];
        for (const p of densify(part)) {
          if (inBuilding(p)) {
            if (run.length >= 2) b.add(run, widthAt(pc.widths, side, pc.s[0]!));
            run = [];
          } else run.push(p);
        }
        if (run.length >= 2) b.add(run, widthAt(pc.widths, side, pc.s[0]!));
      }
      const at = (s: number): Pt | null => {
        const p = pointAt(line, lineCum, s).p;
        return inBuilding(p) ? null : p;
      };
      const first = st[1]! - st[0]! >= 0.3 ? at(st[0]!) : null;
      const last = st[st.length - 1]! - st[st.length - 2]! >= 0.3 ? at(st[st.length - 1]!) : null;
      // side +1 is the way's right: at the start arm that is the arm's right, at the end arm the arm's left
      if (a0) {
        const e = ends.get(a0) ?? { r: null, l: null };
        if (side > 0) e.r = first; else e.l = first;
        ends.set(a0, e);
      }
      if (a1) {
        const e = ends.get(a1) ?? { r: null, l: null };
        if (side > 0) e.l = last; else e.r = last;
        ends.set(a1, e);
      }
    }
    // mid-block crossings: from one side's station point to the other's
    for (const s of crossAt) {
      const c = pointAt(pc.pts, cumP, s);
      const n = { x: -c.dir.z, z: c.dir.x };
      const sAbs = pc.s[0]! + s;
      const pr = sideOffset(pc, 1, sAbs), pl = sideOffset(pc, -1, sAbs);
      b.add([{ x: c.p.x + n.x * pr, z: c.p.z + n.z * pr }, { x: c.p.x - n.x * pl, z: c.p.z - n.z * pl }], CROSSING_WIDTH, true);
    }
  }
  // the side lines at a mid-block crossing must share its end points: split them there
  for (const l of [...b.lines]) if (l.crossing) for (const p of [l.pts[0]!, l.pts[l.pts.length - 1]!]) b.attach(p, 0.5, l);

  // junctions: corners between neighbouring arms, crossings over each arm (three or more arms)
  for (const list of arms.values()) {
    const sorted = [...list].sort((x, y) => x.angle - y.angle);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!, n = sorted[(i + 1) % sorted.length]!;
      if (a === n) continue;
      const ea = ends.get(a), en = ends.get(n);
      if (ea?.r && en?.l && key(ea.r) !== key(en.l)) b.add([ea.r, en.l], CROSSING_WIDTH, onAnyCarriageway(mid(ea.r, en.l)));
    }
    if (sorted.length >= 3) for (const a of sorted) {
      const e = ends.get(a);
      if (e?.r && e?.l) b.add([e.r, e.l], CROSSING_WIDTH, true);
    }
  }

  // footways, paths, pedestrian ways
  const walkLines: Line[] = [];
  for (const r of roads) {
    if (!WALK_KINDS.has(r.kind)) continue;
    // ends lying on a carriageway (a footway mapped up to the road's centre line) are cut back to the kerb side
    const pts = densify(dedupe(r.points), 1);
    let i0 = 0, i1 = pts.length - 1;
    while (i0 < i1 && onAnyCarriageway(pts[i0]!)) i0++;
    while (i1 > i0 && onAnyCarriageway(pts[i1]!)) i1--;
    const l = b.add(densify(simplifyStraight(pts.slice(i0, i1 + 1))), Math.max(1.5, r.width));
    if (l) walkLines.push(l);
  }
  const crossesRoad = (p: Pt, q: Pt): boolean => onAnyCarriageway(mid(p, q));
  for (const l of walkLines) {
    for (const p of [l.pts[0]!, l.pts[l.pts.length - 1]!]) {
      if (!b.shared(p, l)) b.attach(p, ATTACH_MAX, l, CROSSING_WIDTH, crossesRoad);
    }
  }
  const g = b.build();
  // footway pieces running over a carriageway are crossings
  for (const e of g.edges) {
    if (e.crossing) continue;
    const m = e.pts[Math.floor(e.pts.length / 2)]!;
    if (onAnyCarriageway({ x: m[0], z: m[1] })) e.crossing = true;
  }
  return g;
}

/** Drops vertices that lie on the straight line between their neighbours (within 1 cm). */
function simplifyStraight(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) if (distToPolyline(pts[i]!, [out[out.length - 1]!, pts[i + 1]!]) > 0.01) out.push(pts[i]!);
  out.push(pts[pts.length - 1]!);
  return out;
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });

/** Arc length along pts of the point nearest to p, and the distance. */
function nearestArc(pts: Pt[], cum: number[], p: Pt): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, q = pts[i]!;
    const dx = q.x - a.x, dz = q.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
    if (d < best.dist) best = { s: cum[i - 1]! + t * Math.sqrt(l2), dist: d };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Lanes (cars) and cycle lanes

/** Service ways shorter than this (m) get no lanes (driveway stubs). */
const SERVICE_MIN = 30;
/** Points on a turn arc. */
const TURN_POINTS = 6;
/** Cut-back at junctions is capped at this (m). */
const CUT_MAX = 20;

/** Distance (m) from the way's centre line to the lane's centre on side (+1 right of the way, -1 left) at arc length s. */
type LaneOffset = (r: Road, side: number, s: number) => number;

/** Cars: the outermost lane on that side (one-way ways: the rightmost lane, which may be the centre). */
const driveOffset: LaneOffset = (r, side, s) => edgeAt(r, side, 'lane', s) - r.cross.laneWidth / 2;
/** Bikes: the middle of a cycle lane where there is one, else 0.7 m inside the lane's outer edge. */
const cycleOffset: LaneOffset = (r, side, s) => {
  const lane = edgeAt(r, side, 'lane', s), cycle = edgeAt(r, side, 'cycle', s);
  return cycle - lane > 0.5 ? (lane + cycle) / 2 : lane - 0.7;
};

const laneRoads = (roads: Road[]): Road[] => roads.filter((r) => {
  const pts = dedupe(r.points);
  if (pts.length < 2) return false;
  if (DRIVABLE.has(r.kind)) return true;
  return r.kind === 'service' && cumulative(pts)[pts.length - 1]! >= SERVICE_MIN;
});

/** A quadratic Bézier from p0 to p2 around the corner where the lines p0 + t·d0 and p2 − u·d2 meet. */
function turnArc(p0: Pt, d0: Pt, p2: Pt, d2: Pt): Pt[] {
  const den = d0.x * d2.z - d0.z * d2.x;
  let c = { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 };
  if (Math.abs(den) > 0.05) {
    const t = ((p2.x - p0.x) * d2.z - (p2.z - p0.z) * d2.x) / den;
    const span = d2Of(p0, p2);
    if (t > 0 && t < 2 * span + 5) c = { x: p0.x + d0.x * t, z: p0.z + d0.z * t };
  }
  const out: Pt[] = [];
  for (let k = 0; k < TURN_POINTS; k++) {
    const u = k / (TURN_POINTS - 1), v = 1 - u;
    out.push({ x: v * v * p0.x + 2 * u * v * c.x + u * u * p2.x, z: v * v * p0.z + 2 * u * v * c.z + u * u * p2.z });
  }
  return out;
}
const d2Of = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);
const unitOf = (a: Pt, b: Pt): Pt => {
  const l = d2Of(a, b) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};

/**
 * One-way lane lines along the ways (one per direction; one-way ways only in theirs), ending short of junctions
 * where they would reach into another way's carriageway; at every junction an arc from each arriving lane to each
 * leaving lane of the other arms (no U-turns); at a dead end of a two-way way a turning arc from one lane to the other.
 */
function buildLanes(roads: Road[], offset: LaneOffset, b: NetBuilder): LaneJunction[] {
  const ways = laneRoads(roads);
  const uses = new Map<string, number>();
  for (const r of ways) dedupe(r.points).forEach((p, i, a) => uses.set(key(p), (uses.get(key(p)) ?? 0) + (i === 0 || i === a.length - 1 ? 1 : 2)));
  const isNode = (p: Pt): boolean => (uses.get(key(p)) ?? 0) >= 2;

  type LanePiece = { r: Road; pts: Pt[]; s: number[] };
  type LArm = {
    pc: LanePiece; atStart: boolean; dir: Pt; kerb: number; inEnd: Pt | null; outStart: Pt | null;
    inLine: Line | null; outLine: Line | null; rightKerb: number;
  };
  const pieces: LanePiece[] = [];
  for (const r of ways) {
    const pts = dedupe(r.points), cum = cumulative(pts);
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      if (i < pts.length - 1 && !isNode(pts[i]!)) continue;
      pieces.push({ r, pts: pts.slice(start, i + 1), s: cum.slice(start, i + 1) });
      start = i;
    }
  }
  const arms = new Map<string, LArm[]>();
  const armOf = new Map<string, LArm>();
  pieces.forEach((pc, pieceIx) => {
    for (const atStart of [true, false]) {
      const end = atStart ? pc.pts[0]! : pc.pts[pc.pts.length - 1]!;
      const next = atStart ? pc.pts[1]! : pc.pts[pc.pts.length - 2]!;
      const s = atStart ? pc.s[0]! : pc.s[pc.s.length - 1]!;
      const kerb = Math.max(edgeAt(pc.r, 1, 'kerb', s), edgeAt(pc.r, -1, 'kerb', s));
      const arm: LArm = { pc, atStart, dir: unitOf(end, next), kerb, inEnd: null, outStart: null, inLine: null, outLine: null, rightKerb: 0 };
      armOf.set(`${pieceIx}:${atStart}`, arm);
      if (!isNode(end)) continue;
      const list = arms.get(key(end)) ?? [];
      list.push(arm);
      arms.set(key(end), list);
    }
  });
  const cutOf = (a: LArm): number => {
    const list = arms.get(key(a.atStart ? a.pc.pts[0]! : a.pc.pts[a.pc.pts.length - 1]!));
    if (!list) return 0;
    let cut = 0;
    for (const o of list) {
      if (o === a) continue;
      const sin = Math.abs(a.dir.x * o.dir.z - a.dir.z * o.dir.x);
      if (a.dir.x * o.dir.x + a.dir.z * o.dir.z < -0.87) continue;
      cut = Math.max(cut, Math.min(CUT_MAX, o.kerb / Math.max(0.3, sin) + 1));
    }
    return cut;
  };

  pieces.forEach((pc, idx) => {
    const a0 = armOf.get(`${idx}:true`)!, a1 = armOf.get(`${idx}:false`)!;
    const total = pc.s[pc.s.length - 1]! - pc.s[0]!;
    const c0 = cutOf(a0), c1 = cutOf(a1);
    if (total - c0 - c1 < 1) return;
    const width = pc.r.cross.laneWidth;
    const lane = (side: number): Pt[] | null => {
      const line = offsetLine(pc.pts, pc.pts.map((_, i) => side * offset(pc.r, side, pc.s[i]!)));
      const lc = cumulative(line), lt = lc[lc.length - 1]!;
      const part = trim(line, (c0 / total) * lt, lt - (c1 / total) * lt);
      return part.length >= 2 ? part : null;
    };
    const s0 = pc.s[0]!, s1 = pc.s[pc.s.length - 1]!;
    const fwd = lane(1);
    if (fwd) {
      const l = b.add(fwd, width, false, true);
      a0.outStart = fwd[0]!;
      a0.outLine = l;
      a1.inEnd = fwd[fwd.length - 1]!;
      a1.inLine = l;
      a1.rightKerb = edgeAt(pc.r, 1, 'kerb', s1) - offset(pc.r, 1, s1);
    }
    if (!pc.r.oneway) {
      const back = lane(-1)?.reverse() ?? null;
      if (back) {
        const l = b.add(back, width, false, true);
        a1.outStart = back[0]!;
        a1.outLine = l;
        a0.inEnd = back[back.length - 1]!;
        a0.inLine = l;
        a0.rightKerb = edgeAt(pc.r, -1, 'kerb', s0) - offset(pc.r, -1, s0);
      }
    }
  });
  const junctions: LaneJunction[] = [];
  for (const [k, list] of arms) {
    const turns: Line[] = [];
    for (const a of list) {
      if (!a.inEnd) continue;
      for (const o of list) {
        if (o === a || !o.outStart) continue;
        const l = b.add(turnArc(a.inEnd, { x: -a.dir.x, z: -a.dir.z }, o.outStart, o.dir), a.pc.r.cross.laneWidth, false, true);
        if (l) turns.push(l);
      }
    }
    if (list.length < 3) continue;
    const at = list[0]!.atStart ? list[0]!.pc.pts[0]! : list[0]!.pc.pts[list[0]!.pc.pts.length - 1]!;
    junctions.push({
      key: k, x: at.x, z: at.z, turns,
      arms: list.map((a) => ({ road: a.pc.r, dir: a.dir, kerb: a.kerb, inEnd: a.inEnd, inLine: a.inLine, rightKerb: a.rightKerb, laneWidth: a.pc.r.cross.laneWidth })),
    });
  }

  // junctions: arcs from every arriving lane to every leaving lane of another arm
  // dead ends of two-way ways: turn around
  for (const a of armOf.values()) {
    const end = a.atStart ? a.pc.pts[0]! : a.pc.pts[a.pc.pts.length - 1]!;
    if (isNode(end) || !a.inEnd || !a.outStart) continue;
    const back = { x: -a.dir.x, z: -a.dir.z };
    const tip = { x: (a.inEnd.x + a.outStart.x) / 2 + back.x * 3, z: (a.inEnd.z + a.outStart.z) / 2 + back.z * 3 };
    b.add([...turnArc(a.inEnd, back, tip, { x: a.outStart.x - a.inEnd.x, z: a.outStart.z - a.inEnd.z }).slice(0, -1), ...turnArc(tip, unitOf(a.inEnd, a.outStart), a.outStart, a.dir)], a.pc.r.cross.laneWidth, false, true);
  }
  return junctions;
}

/**
 * A junction (three or more arms) as buildLanes saw it: per arm the way, its direction away from the node, the widest
 * kerb, the arriving lane (its line and end) and the distance from that lane's centre to its right kerb; the turn arcs.
 */
export type LaneJunction = {
  key: string; x: number; z: number; turns: Line[];
  arms: { road: Road; dir: Pt; kerb: number; inEnd: Pt | null; inLine: Line | null; rightKerb: number; laneWidth: number }[];
};

/** The driving network: lanes and junction arcs (all edges one-way). */
export function buildDriveGraph(roads: Road[]): NetGraph {
  return driveNet(roads).graph;
}

function driveNet(roads: Road[]): { graph: NetGraph; b: NetBuilder; junctions: LaneJunction[] } {
  const b = new NetBuilder();
  const junctions = buildLanes(roads, driveOffset, b);
  return { graph: b.build(), b, junctions };
}

/**
 * The cycling network: lanes at the right edge of the carriageway (or on its cycle lane) like the car lanes, plus OSM
 * cycleways (two-way unless one-way), joined at their ends to the nearest cycle line within 10 m.
 */
export function buildCycleGraph(roads: Road[]): NetGraph {
  return cycleNet(roads).graph;
}

function cycleNet(roads: Road[]): { graph: NetGraph; b: NetBuilder; junctions: LaneJunction[] } {
  const b = new NetBuilder();
  const junctions = buildLanes(roads, cycleOffset, b);
  const ways: Line[] = [];
  for (const r of roads) {
    if (r.kind !== 'cycleway') continue;
    const l = b.add(densify(dedupe(r.points)), Math.max(1.5, r.width), false, r.oneway);
    if (l) ways.push(l);
  }
  for (const l of ways) {
    for (const p of [l.pts[0]!, l.pts[l.pts.length - 1]!]) {
      if (!b.shared(p, l)) b.attach(p, ATTACH_MAX, l, 2);
    }
  }
  return { graph: b.build(), b, junctions };
}

// ---------------------------------------------------------------------------------------------------------------
// Seats

/** Greens from this size (m²) get lawn rings, one per LAWN_PER m². */
const LAWN_MIN_AREA = 2000;
const LAWN_PER = 4000;
const LAWN_RADIUS = 0.9;
const TREE_CLEAR = 3;
const PATH_CLEAR = 2;
const RING_CLEAR = 6;

const area = (ring: Pt[]): number => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
};

const facing = (c: Pt, q: Pt): number => Math.atan2(c.x - q.x, c.z - q.z);
const r2Seat = (c: Pt, q: Pt) => ({ x: r2(q.x), z: r2(q.z), heading: Math.round(facing(c, q) * 1000) / 1000 });

/**
 * Seat rings: every bench inside a green or square becomes a ring of three (two on the bench, one opposite, all
 * facing the ring's centre 1 m in front of the bench, towards the nearest path); greens of 2000 m² and more get one
 * lawn ring per 4000 m² (3–4 seats on a 0.9 m circle) at seeded random spots ≥ 3 m from trees, ≥ 2 m from walk paths.
 */
export function buildSeats(greens: Pt[][], squares: Pt[][], benches: Pt[], trees: Pt[], walk: NetGraph, seed: number): SeatRing[] {
  const out: SeatRing[] = [];
  const ix = new GraphIndex(walk);
  const areas = new BoxGrid<Pt[]>();
  for (const a of [...greens, ...squares]) areas.add(a, ...bboxOf(a));
  const treeGrid = new BoxGrid<Pt>();
  for (const t of trees) treeGrid.add(t, t.x, t.z, t.x, t.z);
  for (const bp of benches) {
    if (![...areas.near(bp.x, bp.z, 0)].some((a) => pointInPolygon(bp, a))) continue;
    const n = ix.nearestEdge(bp.x, bp.z, 15);
    let f = { x: 0, z: 1 };
    if (n) {
      const e = walk.edges[n.edge]!;
      const c = ix.cum[n.edge]!;
      let k = 1;
      while (k < e.pts.length - 1 && c[k]! < n.s) k++;
      const [ax, az] = e.pts[k - 1]!, [qx, qz] = e.pts[k]!;
      const t = (n.s - c[k - 1]!) / ((c[k]! - c[k - 1]!) || 1);
      const foot = { x: ax + (qx - ax) * t, z: az + (qz - az) * t };
      if (n.d > 0.1) f = unitOf(bp, foot);
    }
    const c = { x: bp.x + f.x, z: bp.z + f.z };
    const side = { x: -f.z, z: f.x };
    const seats = [
      { x: bp.x + side.x * 0.55, z: bp.z + side.z * 0.55 },
      { x: bp.x - side.x * 0.55, z: bp.z - side.z * 0.55 },
      { x: c.x + f.x * 0.9, z: c.z + f.z * 0.9 },
    ];
    out.push({ x: r2(c.x), z: r2(c.z), seats: seats.map((q) => r2Seat(c, q)), bench: true });
  }
  const rng = prng(seed);
  const taken: Pt[] = out.map((s) => ({ x: s.x, z: s.z }));
  for (const g of greens) {
    const A = area(g);
    if (A < LAWN_MIN_AREA) continue;
    const want = Math.floor(A / LAWN_PER);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of g) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    let placed = 0;
    for (let tries = 0; tries < 200 * want && placed < want; tries++) {
      const c = { x: minX + rng() * (maxX - minX), z: minZ + rng() * (maxZ - minZ) };
      if (!pointInPolygon(c, g) || distToPolyline(c, [...g, g[0]!]) < 2) continue;
      if ([...treeGrid.near(c.x, c.z, TREE_CLEAR)].some((t) => d2Of(t, c) < TREE_CLEAR)) continue;
      if (ix.nearestEdge(c.x, c.z, PATH_CLEAR)) continue;
      if (taken.some((t) => d2Of(t, c) < RING_CLEAR)) continue;
      const n = 3 + Math.floor(rng() * 2);
      const a0 = rng() * Math.PI * 2;
      const seats = Array.from({ length: n }, (_, k) => {
        const a = a0 + (k / n) * Math.PI * 2;
        return r2Seat(c, { x: c.x + Math.sin(a) * LAWN_RADIUS, z: c.z + Math.cos(a) * LAWN_RADIUS });
      });
      out.push({ x: r2(c.x), z: r2(c.z), seats, bench: false });
      taken.push(c);
      placed++;
    }
  }
  return out;
}

export type NpcNetInput = {
  roads: Road[]; sidewalks: Map<Road, SidewalkWidths>; buildings: BuildingMesh[]; crossings: Pt[];
  greens: Pt[][]; squares: Pt[][]; benches: Pt[]; trees: Pt[];
  signals: Pt[]; giveWay: Pt[]; stops: Pt[]; seed: number;
};

/** The whole NPC network: walk, drive and cycle graphs, seat rings and junctions with their signals. */
export function buildNpcNet(i: NpcNetInput): NpcNet {
  const walk = buildWalkGraph(i.roads, i.sidewalks, i.crossings, i.buildings);
  const drive = driveNet(i.roads), cycle = cycleNet(i.roads);
  return {
    version: 1, walk, drive: drive.graph, cycle: cycle.graph,
    seats: buildSeats(i.greens, i.squares, i.benches, i.trees, walk, i.seed),
    junctions: buildJunctions({ drive, cycle, walk, signals: i.signals, giveWay: i.giveWay, stops: i.stops, seed: i.seed }),
  };
}
