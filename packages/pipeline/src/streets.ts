import earcut from 'earcut';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, junctions, ptKey, subPolyline } from './polyline.js';

/** uv: u = metres along the ribbon, v = metres across (polygons: world x/z metres). */
export type Mesh = { positions: Float32Array; indices: Uint32Array; uv: Float32Array };

const ROAD_Y = 0.01;
const CURB_H = 0.12;
const CURB_W = 0.15;
const SIDEWALK_W = 2.5;
const JUNCTION_GAP = 5;
const GAUGE = 1.435;
const RAIL_W = 0.07;
const RAIL_Y = 0.02;
const GREEN_Y = 0.005;
const SQUARE_Y = 0.0095;
const RANK_STEP = 0.0005; // per road class, keeps overlapping ribbons from z-fighting (max 8 * 0.0005 = 0.004)
const RANK: Record<string, number> = {
  footway: 0, path: 0, cycleway: 0, pedestrian: 1, service: 2, living_street: 3, unclassified: 4,
  residential: 5, tertiary: 6, secondary: 7, primary: 8,
};

type V3 = [number, number, number];

class MeshBuilder {
  private pos: number[] = [];
  private idx: number[] = [];
  private uvs: number[] = [];

  /** Quad strip between two 3D lines of equal length; a_i, b_i, a_i+1 is counter-clockwise seen from the face normal. */
  strip(a: V3[], b: V3[], u: number[], v0: number, v1: number): void {
    for (let i = 0; i < a.length; i++) {
      const base = this.pos.length / 3;
      this.pos.push(...a[i]!, ...b[i]!);
      this.uvs.push(u[i]!, v0, u[i]!, v1);
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

/** Offsets a polyline sideways with mitred corners; positive d is the right-hand side of travel (x east, z south). */
function offsetLine(pts: Pt[], d: number): Pt[] {
  const normals = (i: number): Pt => {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  return pts.map((p, i) => {
    const n0 = normals(Math.max(0, i - 1));
    const n1 = normals(Math.min(pts.length - 2, i));
    const sx = n0.x + n1.x;
    const sz = n0.z + n1.z;
    const sl = Math.hypot(sx, sz) || 1;
    const nx = sx / sl;
    const nz = sz / sl;
    const k = 1 / Math.max(0.5, nx * n0.x + nz * n0.z);
    return { x: p.x + nx * d * k, z: p.z + nz * d * k };
  });
}

const lift = (pts: Pt[], y: number): V3[] => pts.map((p) => [p.x, y, p.z]);

/** Pairs of lines → one strip, u measured along the centre line `along`. */
function addRibbon(b: MeshBuilder, along: Pt[], left: Pt[], right: Pt[], yl: number, yr: number, v0: number, v1: number): void {
  b.strip(lift(left, yl), lift(right, yr), cumulative(along), v0, v1);
}

/** Arc-length intervals of a road that are at least JUNCTION_GAP away from every junction vertex. */
function freeIntervals(points: Pt[], cum: number[], junc: Map<string, Pt>): [number, number][] {
  const total = cum[cum.length - 1]!;
  const cuts = points.flatMap((p, i) => (junc.has(ptKey(p)) ? [[cum[i]! - JUNCTION_GAP, cum[i]! + JUNCTION_GAP] as const] : []));
  cuts.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s, e] of cuts) {
    if (s > at) out.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < total) out.push([at, total]);
  return out.filter(([s, e]) => e - s > 0.5);
}

function roadSides(r: Road, b: { road: MeshBuilder; sidewalk: MeshBuilder; curb: MeshBuilder }, junc: Map<string, Pt>): void {
  const pts = dedupe(r.points);
  if (pts.length < 2) return;
  const hw = r.width / 2;
  const y = ROAD_Y + (RANK[r.kind] ?? 0) * RANK_STEP;
  addRibbon(b.road, pts, offsetLine(pts, -hw), offsetLine(pts, hw), y, y, 0, r.width);
  if (!DRIVABLE.has(r.kind)) return;
  const cum = cumulative(pts);
  for (const [s0, s1] of freeIntervals(pts, cum, junc)) {
    const seg = subPolyline(pts, cum, s0, s1);
    if (seg.length < 2) continue;
    for (const side of [1, -1]) {
      const inner = offsetLine(seg, side * hw);
      const outer = offsetLine(seg, side * (hw + CURB_W));
      const far = offsetLine(seg, side * (hw + CURB_W + SIDEWALK_W));
      // right side (+1): strip runs inner→outer; left side: outer→inner, so the normal stays up
      const [c0, c1] = side > 0 ? [inner, outer] : [outer, inner];
      const [s0l, s1l] = side > 0 ? [outer, far] : [far, outer];
      addRibbon(b.curb, seg, c0, c1, CURB_H, CURB_H, 0, CURB_W);
      addRibbon(b.sidewalk, seg, s0l, s1l, CURB_H, CURB_H, 0, SIDEWALK_W);
      // vertical face towards the road
      const u = cumulative(seg);
      const lo = lift(inner, y);
      const hi = lift(inner, CURB_H);
      if (side > 0) b.curb.strip(lo, hi, u, 0, CURB_H);
      else b.curb.strip(hi, lo, u, CURB_H, 0);
    }
  }
}

export function buildStreetGeometry(f: OsmFeatures): { road: Mesh; sidewalk: Mesh; curb: Mesh; tram: Mesh; green: Mesh; squares: Mesh } {
  const road = new MeshBuilder();
  const sidewalk = new MeshBuilder();
  const curb = new MeshBuilder();
  const tram = new MeshBuilder();
  const green = new MeshBuilder();
  const squares = new MeshBuilder();

  const junc = junctions(f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service').map((r) => dedupe(r.points)));
  for (const r of f.roads) roadSides(r, { road, sidewalk, curb }, junc);

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

  return { road: road.build(), sidewalk: sidewalk.build(), curb: curb.build(), tram: tram.build(), green: green.build(), squares: squares.build() };
}
