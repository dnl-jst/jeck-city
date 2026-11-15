import type { Pt } from './osm.js';

/** Kinds that carry car traffic (kerbs, sidewalks, parking, road graph). `service` is graph-only. */
export const DRIVABLE = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);

/** Stable key for a point; OSM nodes shared between ways map to identical lat/lon, hence identical keys. */
export const ptKey = (p: Pt): string => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;

export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Drops consecutive (near) duplicates. */
export function dedupe(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) if (!out.length || dist(out[out.length - 1]!, p) > 1e-6) out.push(p);
  return out;
}

export function cumulative(points: Pt[]): number[] {
  const s = [0];
  for (let i = 1; i < points.length; i++) s.push(s[i - 1]! + dist(points[i - 1]!, points[i]!));
  return s;
}

/** Point and unit direction at arc length s (clamped to the line). */
export function pointAt(points: Pt[], cum: number[], s: number): { p: Pt; dir: Pt } {
  let i = 1;
  while (i < points.length - 1 && cum[i]! < s) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const len = cum[i]! - cum[i - 1]! || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]!) / len));
  return { p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, dir: { x: (b.x - a.x) / len, z: (b.z - a.z) / len } };
}

/** The part of the polyline between arc lengths s0 and s1. */
export function subPolyline(points: Pt[], cum: number[], s0: number, s1: number): Pt[] {
  const out = [pointAt(points, cum, s0).p];
  for (let i = 1; i < points.length - 1; i++) if (cum[i]! > s0 && cum[i]! < s1) out.push(points[i]!);
  out.push(pointAt(points, cum, s1).p);
  return dedupe(out);
}

export function distToPolyline(p: Pt, points: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
  }
  return best;
}

/**
 * Network nodes where at least 3 way-segments meet (a vertex interior to a way counts 2, an endpoint 1).
 * Returns key -> position. Only the given ways take part.
 */
export function junctions(lines: Pt[][]): Map<string, Pt> {
  const deg = new Map<string, { p: Pt; n: number }>();
  for (const line of lines) {
    line.forEach((p, i) => {
      const e = deg.get(ptKey(p)) ?? { p, n: 0 };
      e.n += i === 0 || i === line.length - 1 ? 1 : 2;
      deg.set(ptKey(p), e);
    });
  }
  const out = new Map<string, Pt>();
  for (const [k, e] of deg) if (e.n >= 3) out.set(k, e.p);
  return out;
}

/** Even-odd point-in-polygon test (ring may or may not repeat its first point). */
export function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Offsets a polyline sideways with mitred corners; positive d is the right-hand side of travel (x east, z south). d may vary per point. */
export function offsetLine(pts: Pt[], d: number | number[]): Pt[] {
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
    const di = typeof d === 'number' ? d : d[i]!;
    return { x: p.x + nx * di * k, z: p.z + nz * di * k };
  });
}
