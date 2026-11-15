import type { BuildingMesh } from './buildings.js';
import { footprintContains, footprintDistance, footprintOf } from './footprint.js';
import type { Pt, Road } from './osm.js';
import { edgeAt, edges } from './roadprofile.js';
import { cumulative, dedupe, pointAt, ptKey } from './polyline.js';

export const SIDEWALK_MIN = 1.5;
export const SIDEWALK_MAX = 8;
export const SIDEWALK_DEFAULT = 2.5;
const NEAR = 10; // a building closer than this to the kerb defines the building line
const CELL = 50;

/** Uniform grid over building footprint bboxes, for the "buildings near a point" query. */
export type BuildingGrid = { near(p: Pt, r: number): BuildingMesh[] };

export function buildingGrid(buildings: BuildingMesh[]): BuildingGrid {
  const cells = new Map<string, BuildingMesh[]>();
  for (const b of buildings) {
    const fp = footprintOf(b);
    if (!fp.tris.length) continue;
    for (let i = Math.floor(fp.minX / CELL); i <= Math.floor(fp.maxX / CELL); i++) {
      for (let k = Math.floor(fp.minZ / CELL); k <= Math.floor(fp.maxZ / CELL); k++) {
        const key = `${i},${k}`;
        const list = cells.get(key);
        if (list) list.push(b);
        else cells.set(key, [b]);
      }
    }
  }
  return {
    near(p, r) {
      const out = new Set<BuildingMesh>();
      for (let i = Math.floor((p.x - r) / CELL); i <= Math.floor((p.x + r) / CELL); i++) {
        for (let k = Math.floor((p.z - r) / CELL); k <= Math.floor((p.z + r) / CELL); k++) {
          for (const b of cells.get(`${i},${k}`) ?? []) {
            const fp = footprintOf(b);
            if (p.x >= fp.minX - r && p.x <= fp.maxX + r && p.z >= fp.minZ - r && p.z <= fp.maxZ + r) out.add(b);
          }
        }
      }
      return [...out];
    },
  };
}

/** Distance along the ray p + t·d (d unit) to the first footprint edge of b, 0 if p is inside; Infinity if none. */
function rayToFootprint(b: BuildingMesh, p: Pt, d: Pt): number {
  if (footprintContains(b, p.x, p.z)) return 0;
  const t = footprintOf(b).tris;
  let best = Infinity;
  for (let i = 0; i < t.length; i += 6) {
    for (let k = 0; k < 3; k++) {
      const ax = t[i + k * 2]!, az = t[i + k * 2 + 1]!;
      const ex = t[i + ((k + 1) % 3) * 2]! - ax, ez = t[i + ((k + 1) % 3) * 2 + 1]! - az;
      const den = d.x * ez - d.z * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = ax - p.x, wz = az - p.z;
      const s = (wx * ez - wz * ex) / den; // along the ray
      const u = (wx * d.z - wz * d.x) / den; // along the edge
      if (s >= 0 && u >= 0 && u <= 1) best = Math.min(best, s);
    }
  }
  return best;
}

/** Unit normals at the vertices (mitre direction, right of travel), as offsetLine uses them. */
function vertexNormals(pts: Pt[]): Pt[] {
  const seg = (i: number): Pt => {
    const a = pts[i]!, b = pts[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  return pts.map((_, i) => {
    const n0 = seg(Math.max(0, i - 1)), n1 = seg(Math.min(pts.length - 2, i));
    const sx = n0.x + n1.x, sz = n0.z + n1.z;
    const l = Math.hypot(sx, sz) || 1;
    return { x: sx / l, z: sz / l };
  });
}

const median3 = (v: number[]): number[] =>
  v.map((x, i) => [v[Math.max(0, i - 1)]!, x, v[Math.min(v.length - 1, i + 1)]!].sort((a, b) => a - b)[1]!);

/**
 * Values at the flagged vertices replaced by the nearest unflagged one (by index; the smaller of two equally near).
 * Returns null when every vertex is flagged.
 */
function fromNeighbours(v: number[], flagged: boolean[]): number[] | null {
  if (flagged.every(Boolean)) return null;
  const ok = (j: number) => j >= 0 && j < v.length && !flagged[j];
  return v.map((x, i) => {
    if (!flagged[i]) return x;
    for (let k = 1; ; k++) {
      if (ok(i - k) && ok(i + k)) return Math.min(v[i - k]!, v[i + k]!);
      if (ok(i - k)) return v[i - k]!;
      if (ok(i + k)) return v[i + k]!;
    }
  });
}

/**
 * Sidewalk width per vertex of dedupe(road.points), left and right of travel: distance from the kerb (that side's
 * edge of the road profile) to the nearest facade straight out from the road, clamped to [1.5, 8] m; 2.5 m where no building lies
 * within 10 m of the kerb. The way's endpoints and its junction vertices (`opts.junctions`, ptKeys) take the value
 * of the nearest other vertex, since their ray runs into the side street; a way with no other vertex samples its
 * middle. Then smoothed with a median over 3 vertices.
 */
export function sidewalkWidths(road: Road, buildings: BuildingMesh[], opts: { grid?: BuildingGrid; junctions?: ReadonlySet<string> } = {}): { left: number[]; right: number[] } {
  const grid = opts.grid ?? buildingGrid(buildings);
  const pts = dedupe(road.points);
  const normals = vertexNormals(pts);
  const kerbs = { left: edges(road, -1, 'kerb'), right: edges(road, 1, 'kerb') };
  const flagged = pts.map((p, i) => i === 0 || i === pts.length - 1 || (opts.junctions?.has(ptKey(p)) ?? false));
  const width = (p: Pt, n: Pt, s: 1 | -1, hw: number): number => {
    const d = { x: n.x * s, z: n.z * s };
    const kerb = { x: p.x + d.x * hw, z: p.z + d.z * hw };
    const cand = grid.near(kerb, NEAR);
    if (!cand.some((b) => footprintDistance(b, kerb.x, kerb.z) < NEAR)) return SIDEWALK_DEFAULT;
    const hit = Math.min(...cand.map((b) => rayToFootprint(b, kerb, d)));
    return Math.min(SIDEWALK_MAX, Math.max(SIDEWALK_MIN, hit));
  };
  const side = (s: 1 | -1) => {
    const k = s > 0 ? kerbs.right : kerbs.left;
    const raw = pts.map((p, i) => width(p, normals[i]!, s, k[i]!));
    const filled = fromNeighbours(raw, flagged);
    if (filled) return median3(filled);
    const cum = cumulative(pts);
    const mid = pointAt(pts, cum, cum[cum.length - 1]! / 2);
    const v = width(mid.p, { x: -mid.dir.z, z: mid.dir.x }, s, edgeAt(road, s, 'kerb', cum[cum.length - 1]! / 2));
    return pts.map(() => v);
  };
  return { left: side(-1), right: side(1) };
}
