import earcut from 'earcut';
import type { BuildingMesh } from './buildings.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, dist, distToPolyline, DRIVABLE, junctions, offsetLine, ptKey, subPolyline } from './polyline.js';
import { buildMarkings } from './markings.js';
import { buildingGrid, sidewalkWidths } from './sidewalkwidth.js';
import { edges } from './roadprofile.js';

/** uv: u = metres along the ribbon, v = metres across (polygons: world x/z metres). */
/** `mark` (markings only): 0 white, 1 red cycle crossing. */
export type Mesh = { positions: Float32Array; indices: Uint32Array; uv: Float32Array; mark?: Float32Array };

const ROAD_Y = 0.01;
const CURB_H = 0.12;
const CURB_W = 0.15;
const JUNCTION_GAP = 5;
const MAX_JUNCTION_GAP = 30;
const DUAL_EXTRA = 6; // dual carriageway: centre lines closer than the half widths + this
const GAUGE = 1.435;
const RAIL_W = 0.07;
const RAIL_Y = 0.02;
const GREEN_Y = 0.005;
const SQUARE_Y = 0.0095;
const PARK_DY = 0.002; // parking strips above their road ribbon (markings: +0.004)
const RANK_STEP = 0.0005; // per road class, keeps overlapping ribbons from z-fighting (max 8 * 0.0005 = 0.004)
const RANK: Record<string, number> = {
  footway: 0, path: 0, cycleway: 0, pedestrian: 1, service: 2, living_street: 3, unclassified: 4,
  residential: 5, tertiary: 6, secondary: 7, primary: 8,
};
const roadY = (r: Road): number => ROAD_Y + (RANK[r.kind] ?? 0) * RANK_STEP;

type V3 = [number, number, number];

class MeshBuilder {
  private pos: number[] = [];
  private idx: number[] = [];
  private uvs: number[] = [];

  /** Quad strip between two 3D lines of equal length (v per line, constant or per point); a_i, b_i, a_i+1 is counter-clockwise seen from the face normal. */
  strip(a: V3[], b: V3[], u: number[], v0: number | number[], v1: number | number[]): void {
    const at = (v: number | number[], i: number) => (typeof v === 'number' ? v : v[i]!);
    for (let i = 0; i < a.length; i++) {
      const base = this.pos.length / 3;
      this.pos.push(...a[i]!, ...b[i]!);
      this.uvs.push(u[i]!, at(v0, i), u[i]!, at(v1, i));
      if (i > 0) this.idx.push(base - 2, base - 1, base, base, base - 1, base + 1);
    }
  }

  polygon(outline: Pt[], y: number): void {
    const ring = outline.length > 1 && ptKey(outline[0]!) === ptKey(outline[outline.length - 1]!) ? outline.slice(0, -1) : outline;
    if (ring.length < 3) return;
    const base = this.pos.length / 3;
    for (const p of ring) {
      this.pos.push(p.x, y, p.z);
      this.uvs.push(p.x, p.z);
    }
    const tris = earcut(ring.flatMap((p) => [p.x, p.z]));
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i]!, tris[i + 1]!, tris[i + 2]!];
      const cross = (ring[b]!.z - ring[a]!.z) * (ring[c]!.x - ring[a]!.x) - (ring[b]!.x - ring[a]!.x) * (ring[c]!.z - ring[a]!.z);
      this.idx.push(base + a, base + (cross >= 0 ? b : c), base + (cross >= 0 ? c : b));
    }
  }

  build(): Mesh {
    return { positions: Float32Array.from(this.pos), indices: Uint32Array.from(this.idx), uv: Float32Array.from(this.uvs) };
  }
}

const lift = (pts: Pt[], y: number): V3[] => pts.map((p) => [p.x, y, p.z]);

/** Pairs of lines → one strip, u measured along the centre line `along`. */
function addRibbon(b: MeshBuilder, along: Pt[], left: Pt[], right: Pt[], yl: number, yr: number, v0: number, v1: number): void {
  b.strip(lift(left, yl), lift(right, yr), cumulative(along), v0, v1);
}

/** Linear interpolation of per-vertex values `v` (at arc lengths `cum`) at arc length s. */
function valueAt(cum: number[], v: number[], s: number): number {
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < s) i++;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1)));
  return v[i - 1]! + (v[i]! - v[i - 1]!) * t;
}

/** Union of [start, end] intervals subtracted from [0, total]; pieces shorter than 0.5 m are dropped. */
function complement(cuts: [number, number][], total: number): [number, number][] {
  cuts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s, e] of cuts) {
    if (s > at) out.push([at, Math.min(s, total)]);
    at = Math.max(at, e);
  }
  if (at < total) out.push([at, total]);
  return out.filter(([s, e]) => e - s > 0.5);
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, z: a.z - b.z });
const unit = (a: Pt, b: Pt): Pt => {
  const l = dist(a, b) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
};
const right = (t: Pt): Pt => ({ x: -t.z, z: t.x });

/** Distance between segments ab and cd (2D). */
function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cr = (o: Pt, p: Pt, q: Pt) => (p.x - o.x) * (q.z - o.z) - (p.z - o.z) * (q.x - o.x);
  const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToPolyline(a, [c, d]), distToPolyline(b, [c, d]), distToPolyline(c, [a, b]), distToPolyline(d, [a, b]));
}

type Arm = { dir: Pt; hw: number }; // a road leaving a junction node: unit direction away from it, wider kerb distance there
/** hw: the wider half (kerb) of the way, for neighbours; kerb: per-vertex kerb distance per side. */
type Prepared = { r: Road; pts: Pt[]; cum: number[]; hw: number; kerb: { left: number[]; right: number[] }; widths: { left: number[]; right: number[] }; median: MedianInfo[] };
/** Per vertex: the side (+1 right, -1 left, 0 none) where the opposite carriageway of a dual carriageway lies, and its centre distance. */
type MedianInfo = { side: number; d: number };

/**
 * Arc length from the junction node along one arm of a road (travel direction t, `sign` +1 ahead / -1 behind)
 * after which its kerb and sidewalk on side `side` clear the carriageways of every other arm at the node
 * (at least JUNCTION_GAP, at most MAX_JUNCTION_GAP). Arms within 15° of this one (continuations) are ignored.
 */
function armCut(node: Pt, t: Pt, sign: number, side: number, hw: number, outer: number, others: Arm[]): number {
  const u = { x: t.x * sign, z: t.z * sign };
  const n = right(t);
  const rel = others.filter((o) => o.dir.x * u.x + o.dir.z * u.z < Math.cos((15 * Math.PI) / 180));
  for (let a = JUNCTION_GAP; a < MAX_JUNCTION_GAP; a += 0.25) {
    const p0 = { x: node.x + u.x * a + n.x * side * hw, z: node.z + u.z * a + n.z * side * hw };
    const p1 = { x: node.x + u.x * a + n.x * side * outer, z: node.z + u.z * a + n.z * side * outer };
    const clear = rel.every((o) => segSegDist(p0, p1, node, { x: node.x + o.dir.x * 500, z: node.z + o.dir.z * 500 }) >= o.hw + CURB_W);
    if (clear) return a;
  }
  return MAX_JUNCTION_GAP;
}

/** Dual carriageways: two oneway ways of the same name, running opposite (±30°), centre lines closer than hw1 + hw2 + 6 m. */
function medianInfo(r: Road, pts: Pt[], all: Prepared[]): MedianInfo[] {
  const partners = r.oneway && r.name ? all.filter((q) => q.r !== r && q.r.oneway && q.r.name === r.name) : [];
  return pts.map((p, i) => {
    const t = unit(pts[Math.max(0, i - 1)]!, pts[Math.min(pts.length - 1, Math.max(1, i))]!);
    const t2 = i < pts.length - 1 ? unit(p, pts[i + 1]!) : t;
    const tm = { x: t.x + t2.x, z: t.z + t2.z };
    let best: MedianInfo = { side: 0, d: Infinity };
    for (const q of partners) {
      for (let k = 1; k < q.pts.length; k++) {
        const a = q.pts[k - 1]!, b = q.pts[k]!;
        const dq = unit(a, b);
        if (dq.x * tm.x + dq.z * tm.z > -Math.cos((30 * Math.PI) / 180) * Math.hypot(tm.x, tm.z)) continue;
        const d = distToPolyline(p, [a, b]);
        if (d >= best.d || d >= q.hw + r.width / 2 + DUAL_EXTRA) continue;
        const ab = sub(b, a), l2 = ab.x * ab.x + ab.z * ab.z || 1;
        const s = Math.min(1, Math.max(0, ((p.x - a.x) * ab.x + (p.z - a.z) * ab.z) / l2));
        const foot = { x: a.x + ab.x * s, z: a.z + ab.z * s };
        const n = right(tm);
        best = { side: (foot.x - p.x) * n.x + (foot.z - p.z) * n.z >= 0 ? 1 : -1, d };
      }
    }
    return best;
  });
}

function roadSides(pr: Prepared, b: { road: MeshBuilder; sidewalk: MeshBuilder; curb: MeshBuilder; green: MeshBuilder; parking: MeshBuilder }, junc: Map<string, Pt>, arms: Map<string, (Arm & { road: Road })[]>): void {
  const { r, pts, cum } = pr;
  const y = roadY(r);
  addRibbon(b.road, pts, offsetLine(pts, pr.kerb.left.map((k) => -k)), offsetLine(pts, pr.kerb.right), y, y, 0, r.width);
  if (!DRIVABLE.has(r.kind)) return;
  const total = cum[cum.length - 1]!;
  for (const side of [1, -1]) {
    const widths = side > 0 ? pr.widths.right : pr.widths.left;
    const kerb = side > 0 ? pr.kerb.right : pr.kerb.left;
    const cycle = edges(r, side, 'cycle'); // the parking strip runs from the cycle lane (or lanes) to the kerb
    const cuts: [number, number][] = [];
    pts.forEach((p, i) => {
      const key = ptKey(p);
      if (!junc.has(key)) return;
      const others = (arms.get(key) ?? []).filter((a) => a.road !== r);
      const outer = kerb[i]! + widths[i]!;
      const back = i > 0 ? armCut(p, unit(pts[i - 1]!, p), -1, side, kerb[i]!, outer, others) : 0;
      const ahead = i < pts.length - 1 ? armCut(p, unit(p, pts[i + 1]!), 1, side, kerb[i]!, outer, others) : 0;
      cuts.push([cum[i]! - back, cum[i]! + ahead]);
    });
    // dual carriageway: no kerb/sidewalk on the inner side, a green median up to the middle instead
    for (let i = 1; i < pts.length; i++) {
      const m0 = pr.median[i - 1]!, m1 = pr.median[i]!;
      if (m0.side !== side || m1.side !== side) continue;
      cuts.push([cum[i - 1]!, cum[i]!]);
      const seg = [pts[i - 1]!, pts[i]!];
      const k = [kerb[i - 1]!, kerb[i]!];
      const mid = [m0.d / 2, m1.d / 2];
      if (mid[0]! <= k[0]! && mid[1]! <= k[1]!) continue;
      const inner = offsetLine(seg, k.map((v) => side * v));
      const middle = offsetLine(seg, mid.map((m, j) => side * Math.max(k[j]!, m)));
      const [g0, g1] = side > 0 ? [inner, middle] : [middle, inner];
      b.green.strip(lift(g0, GREEN_Y), lift(g1, GREEN_Y), [cum[i - 1]!, cum[i]!], 0, 1);
    }
    for (const [s0, s1] of complement(cuts, total)) {
      const seg = subPolyline(pts, cum, s0, s1);
      if (seg.length < 2) continue;
      const segCum = cumulative(seg).map((c) => c + s0); // arc lengths on the full road
      const k = segCum.map((c) => valueAt(cum, kerb, c));
      const cyc = segCum.map((c) => valueAt(cum, cycle, c));
      const w = segCum.map((c) => valueAt(cum, widths, c) - CURB_W); // paved width behind the kerb stone
      const inner = offsetLine(seg, k.map((v) => side * v));
      const outer = offsetLine(seg, k.map((v) => side * (v + CURB_W)));
      const far = offsetLine(seg, w.map((wi, j) => side * (k[j]! + CURB_W + wi)));
      // right side (+1): strip runs inner→outer; left side: outer→inner, so the normal stays up
      const [c0, c1] = side > 0 ? [inner, outer] : [outer, inner];
      const [s0l, s1l] = side > 0 ? [outer, far] : [far, outer];
      addRibbon(b.curb, seg, c0, c1, CURB_H, CURB_H, 0, CURB_W);
      const park = k.map((v, j) => v - cyc[j]!);
      if (park.some((v) => v > 1e-3)) {
        // parking strip along the kerb (tapering in ramps), v = metres from the kerb
        const lane = lift(offsetLine(seg, cyc.map((v) => side * v)), y + PARK_DY);
        const kerbLine = lift(inner, y + PARK_DY);
        const u = cumulative(seg);
        if (side > 0) b.parking.strip(lane, kerbLine, u, park, 0);
        else b.parking.strip(kerbLine, lane, u, 0, park);
      }
      b.sidewalk.strip(lift(s0l, CURB_H), lift(s1l, CURB_H), cumulative(seg), side > 0 ? 0 : w, side > 0 ? w : 0);
      // vertical face towards the road
      const u = cumulative(seg);
      const lo = lift(inner, y);
      const hi = lift(inner, CURB_H);
      if (side > 0) b.curb.strip(lo, hi, u, 0, CURB_H);
      else b.curb.strip(hi, lo, u, CURB_H, 0);
    }
  }
}

/**
 * Street meshes. Road ribbons run kerb to kerb as the road profile places them (roadprofile.ts: lanes symmetric about
 * the way, cycle lane and strip outwards per side, ramps between ways); kerbs at its edges; sidewalks from the kerb to the
 * building line (`sidewalkWidths`, 2.5 m without buildings), ending before junctions where they would reach into
 * another carriageway; the inner sides of dual carriageways get a green median instead. Parking strips (cross-section)
 * are a surface from the cycle lane (or lanes) to the kerb wherever the kerb runs, tapering in ramps (uv.y = metres from the kerb); `markings` see markings.ts.
 */
export function buildStreetGeometry(f: OsmFeatures, buildings: BuildingMesh[] = []): { road: Mesh; sidewalk: Mesh; curb: Mesh; tram: Mesh; green: Mesh; squares: Mesh; markings: Mesh; parking: Mesh } {
  const road = new MeshBuilder();
  const sidewalk = new MeshBuilder();
  const curb = new MeshBuilder();
  const tram = new MeshBuilder();
  const green = new MeshBuilder();
  const squares = new MeshBuilder();
  const parking = new MeshBuilder();

  const net = f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service');
  const junc = junctions(net.map((r) => dedupe(r.points)));
  const grid = buildingGrid(buildings);
  const juncKeys = new Set(junc.keys());
  const prepared: Prepared[] = [];
  for (const r of f.roads) {
    const pts = dedupe(r.points);
    if (pts.length < 2) continue;
    const kerb = { left: edges(r, -1, 'kerb'), right: edges(r, 1, 'kerb') };
    const widths = DRIVABLE.has(r.kind) ? sidewalkWidths(r, buildings, { grid, junctions: juncKeys }) : { left: [], right: [] };
    prepared.push({ r, pts, cum: cumulative(pts), hw: Math.max(...kerb.left, ...kerb.right), kerb, widths, median: [] });
  }
  for (const p of prepared) p.median = medianInfo(p.r, p.pts, prepared.filter((q) => DRIVABLE.has(q.r.kind)));
  // every arm of a network road at each junction node
  const arms = new Map<string, (Arm & { road: Road })[]>();
  for (const p of prepared) {
    if (!net.includes(p.r)) continue;
    p.pts.forEach((pt, i) => {
      const key = ptKey(pt);
      if (!junc.has(key)) return;
      const list = arms.get(key) ?? [];
      const hw = Math.max(p.kerb.left[i]!, p.kerb.right[i]!);
      if (i > 0) list.push({ dir: unit(pt, p.pts[i - 1]!), hw, road: p.r });
      if (i < p.pts.length - 1) list.push({ dir: unit(pt, p.pts[i + 1]!), hw, road: p.r });
      arms.set(key, list);
    });
  }
  for (const p of prepared) roadSides(p, { road, sidewalk, curb, green, parking }, junc, arms);

  for (const track of f.tramTracks) {
    const pts = dedupe(track);
    if (pts.length < 2) continue;
    for (const side of [-1, 1]) {
      const c = side * GAUGE / 2;
      addRibbon(tram, pts, offsetLine(pts, c - RAIL_W / 2), offsetLine(pts, c + RAIL_W / 2), RAIL_Y, RAIL_Y, 0, RAIL_W);
    }
  }
  for (const g of f.greens) green.polygon(g, GREEN_Y);
  for (const s of f.squares) squares.polygon(s.outline, SQUARE_Y);

  const markings = buildMarkings(f.roads, roadY).mesh;
  return {
    road: road.build(), sidewalk: sidewalk.build(), curb: curb.build(), tram: tram.build(), green: green.build(), squares: squares.build(),
    markings, parking: parking.build(),
  };
}
