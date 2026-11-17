import type { NetEdge, NetGraph } from '@nn/shared';
import type { BuildingMesh } from './buildings.js';
import { footprintContains } from './footprint.js';
import type { Pt, Road } from './osm.js';
import { cumulative, dedupe, distToPolyline, DRIVABLE, offsetLine, pointAt } from './polyline.js';
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

type Line = { pts: Pt[]; width: number; crossing: boolean };

/**
 * Collects polylines and turns them into a graph: a vertex becomes a node where a line ends or where its position is
 * shared with another line; lines are split at nodes and densified to NET_STEP.
 */
export class NetBuilder {
  readonly lines: Line[] = [];

  add(pts: Pt[], width: number, crossing = false): Line | null {
    const clean = dedupeSnap(pts);
    if (clean.length < 2) return null;
    const l = { pts: clean, width, crossing };
    this.lines.push(l);
    return l;
  }

  /** Joins p to the nearest point of another line within maxD (that point becomes a vertex there); false if none. */
  attach(p: Pt, maxD: number, skip?: Line, width = CROSSING_WIDTH, isCrossing?: (a: Pt, b: Pt) => boolean): boolean {
    let best: { l: Line; i: number; q: Pt; d: number } | null = null;
    for (const l of this.lines) {
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
    if (key(q) !== key(l.pts[i - 1]!) && key(q) !== key(l.pts[i]!)) l.pts.splice(i, 0, q);
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
          const e: NetEdge = { a, b, pts: densify(piece).map((p) => [r2(p.x), r2(p.z)]), width: r2(l.width), oneway: false };
          if (l.crossing) e.crossing = true;
          g.edges.push(e);
        }
        start = i;
      }
    }
    return g;
  }
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

function dedupeSnap(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || key(out[out.length - 1]!) !== key(p)) out.push(p);
  return out;
}

/** Points at most NET_STEP apart (the original vertices kept). */
export function densify(pts: Pt[], step = NET_STEP): Pt[] {
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
  const onAnyCarriageway = (p: Pt): boolean => drivable.some((r) => distToPolyline(p, r.points) < 20 && onCarriageway(r, p));

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
    const crossAt = crossings
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
      const shared = b.lines.some((o) => o !== l && o.pts.some((q) => key(q) === key(p)));
      if (!shared) b.attach(p, ATTACH_MAX, l, CROSSING_WIDTH, crossesRoad);
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
