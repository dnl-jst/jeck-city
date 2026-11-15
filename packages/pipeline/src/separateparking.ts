import type { SeparateParking, SeparateSides } from './crosssection.js';
import type { Pt } from './osm.js';
import { cumulative, distToPolyline } from './polyline.js';

/** A separately mapped on-street parking area (amenity=parking, parking=street_side|lane|layby). */
export type ParkingArea = { ring: Pt[]; orientation?: string };

const MAX_DIST = 8; // centroid or nearest edge this close to the way
const MIN_OVERLAP = 10; // metres along the way
const DEPTH_MIN = 1.8;
const DEPTH_MAX = 5.5;
const SAMPLE_STEP = 2;

/** Arc length, signed lateral offset (+ right of travel) and the segment's unit direction for the nearest point. */
function project(way: Pt[], cum: number[], p: Pt): { s: number; off: number; foot: Pt; dir: Pt } {
  let best = { s: 0, off: 0, foot: way[0]!, dir: { x: 1, z: 0 }, d: Infinity };
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1]!, b = way[i]!;
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    if (l < 1e-9) continue;
    const t = Math.min(l, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l));
    const foot = { x: a.x + (dx / l) * t, z: a.z + (dz / l) * t };
    const d = Math.hypot(p.x - foot.x, p.z - foot.z);
    if (d < best.d) {
      const dir = { x: dx / l, z: dz / l };
      // right of travel = (-dir.z, dir.x) (x east, z south)
      best = { s: cum[i - 1]! + t, off: (p.x - foot.x) * -dir.z + (p.z - foot.z) * dir.x, foot, dir, d };
    }
  }
  return best;
}

/** Depth of the polygon along the line p + t·n: max − min of the edge crossings, undefined with fewer than two. */
function depthAcross(ring: Pt[], p: Pt, n: Pt): number | undefined {
  const ts: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const ex = b.x - a.x, ez = b.z - a.z;
    const den = n.x * ez - n.z * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = a.x - p.x, wz = a.z - p.z;
    const u = (wx * n.z - wz * n.x) / den;
    if (u >= 0 && u <= 1) ts.push((wx * ez - wz * ex) / den);
  }
  return ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : undefined;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

/**
 * Parking areas running alongside the way (points in way order): per side, the area with the longest overlap
 * (≥ 10 m) whose centroid or nearest vertex is within 8 m of the way. Width = median perpendicular depth sampled
 * every 2 m (clamped 1.8–5.5 m; omitted when it cannot be measured), orientation from the area's tag.
 */
export function separateParkingSides(way: Pt[], areas: ParkingArea[]): SeparateSides {
  const cum = cumulative(way);
  const total = cum[cum.length - 1]!;
  const out: SeparateSides = {};
  const overlapOf: { left: number; right: number } = { left: 0, right: 0 };
  const xs = way.map((p) => p.x), zs = way.map((p) => p.z);
  const [x0, x1, z0, z1] = [Math.min(...xs) - MAX_DIST - 50, Math.max(...xs) + MAX_DIST + 50, Math.min(...zs) - MAX_DIST - 50, Math.max(...zs) + MAX_DIST + 50];
  for (const a of areas) {
    const ring = a.ring.length > 1 && a.ring[0]!.x === a.ring[a.ring.length - 1]!.x && a.ring[0]!.z === a.ring[a.ring.length - 1]!.z ? a.ring.slice(0, -1) : a.ring;
    if (ring.length < 3 || !ring.some((p) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1)) continue;
    const c = { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, z: ring.reduce((s, p) => s + p.z, 0) / ring.length };
    const near = Math.min(distToPolyline(c, way), ...ring.map((p) => distToPolyline(p, way)));
    if (near > MAX_DIST) continue;
    const pc = project(way, cum, c);
    const side = pc.off >= 0 ? 'right' : 'left';
    const ss = ring.map((p) => project(way, cum, p).s);
    const s0 = Math.max(0, Math.min(...ss)), s1 = Math.min(total, Math.max(...ss));
    const overlap = s1 - s0;
    if (overlap < MIN_OVERLAP || overlap <= overlapOf[side]) continue;
    overlapOf[side] = overlap;
    const depths: number[] = [];
    for (let s = s0 + SAMPLE_STEP / 2; s < s1; s += SAMPLE_STEP) {
      let i = 1;
      while (i < way.length - 1 && cum[i]! < s) i++;
      const A = way[i - 1]!, B = way[i]!, l = Math.hypot(B.x - A.x, B.z - A.z) || 1;
      const t = Math.min(1, Math.max(0, (s - cum[i - 1]!) / l));
      const p = { x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t };
      const d = depthAcross(ring, p, { x: -(B.z - A.z) / l, z: (B.x - A.x) / l });
      if (d !== undefined) depths.push(d);
    }
    const sep: SeparateParking = {};
    if (depths.length >= 3) sep.width = Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, median(depths)));
    if (a.orientation) sep.orientation = a.orientation;
    out[side] = sep;
  }
  return out;
}
