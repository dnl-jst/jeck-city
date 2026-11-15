import type { OsmFeatures, Pt } from './osm.js';
import { cumulative, dedupe, dist, distToPolyline, junctions, pointAt } from './polyline.js';

const SPACING = 6;
const OCCUPANCY = 0.4;
const CLEARANCE = 10;
const TRACK_CLEARANCE = 3;
const EDGE_INSET = 1; // car centre this far inside the road edge
const MAX_SPOTS = 300;
const PARKABLE = new Set(['residential', 'tertiary']);

/** Deterministic PRNG (mulberry32) so a seed always yields the same spots. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parked cars along the right-hand kerb (two-way roads: both sides, oneway: right of travel only).
 * heading = atan2(dx, dz) of the direction the car faces (local x east, z south), i.e. forward = (sin h, cos h),
 * which is the yaw about +y for a model whose nose points along +z. A car parked on the right side faces
 * the way of the road; on the opposite side of a two-way road it faces against it.
 */
export function parkedCarSpots(f: OsmFeatures, seed: number): { pos: Pt; heading: number }[] {
  const rand = rng(seed);
  const roads = f.roads.filter((r) => PARKABLE.has(r.kind) || r.kind === 'service' || r.kind === 'unclassified' || r.kind === 'living_street');
  const junc = [...junctions(roads.map((r) => dedupe(r.points))).values()];
  const blockers = [...junc, ...f.tramStops.map((s) => s.pos)];
  const spots: { pos: Pt; heading: number }[] = [];

  for (const r of f.roads) {
    if (!PARKABLE.has(r.kind)) continue;
    const pts = dedupe(r.points);
    if (pts.length < 2) continue;
    const cum = cumulative(pts);
    const total = cum[cum.length - 1]!;
    for (let s = SPACING / 2; s < total; s += SPACING) {
      const { p, dir } = pointAt(pts, cum, s);
      for (const side of r.oneway ? [1] : [1, -1]) {
        const off = side * (r.width / 2 - EDGE_INSET);
        const pos = { x: p.x - dir.z * off, z: p.z + dir.x * off };
        const occupied = rand() < OCCUPANCY; // drawn for every candidate so the stream stays stable
        if (!occupied) continue;
        if (blockers.some((b) => dist(b, pos) < CLEARANCE)) continue;
        if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) continue;
        spots.push({ pos, heading: Math.atan2(side * dir.x, side * dir.z) });
      }
    }
  }
  if (spots.length <= MAX_SPOTS) return spots;
  // deterministic random subset, original order kept
  const keep = spots.map((_, i) => i);
  for (let i = keep.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [keep[i], keep[j]] = [keep[j]!, keep[i]!];
  }
  return keep.slice(0, MAX_SPOTS).sort((a, b) => a - b).map((i) => spots[i]!);
}
