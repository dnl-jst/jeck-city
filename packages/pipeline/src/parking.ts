import type { BuildingMesh } from './buildings.js';
import { insideAnyFootprint } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, junctions, pointAt, pointInPolygon } from './polyline.js';

const SPACING = 6;
const OCCUPANCY = 0.4;
const CLEARANCE = 10;
const TRACK_CLEARANCE = 3;
const EDGE_INSET = 1; // car centre this far inside the road edge
const BOUNDARY_CLEARANCE = 3; // car centre at least this far inside the play-area boundary
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
 * Spots lie inside the play-area boundary (≥ 3 m from it, so also on the collision ground, which covers the
 * boundary bbox + 200 m) and outside every building footprint.
 */
export function parkedCarSpots(f: OsmFeatures, seed: number, buildings: BuildingMesh[]): { pos: Pt; heading: number }[] {
  const rand = rng(seed);
  const roads = f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service');
  const junc = [...junctions(roads.map((r) => dedupe(r.points))).values()];
  const blockers = [...junc, ...f.tramStops.map((s) => s.pos)];
  const ring = [...f.boundary, f.boundary[0]!]; // closed, for the distance to its last edge
  const inPlayArea = (p: Pt) => pointInPolygon(p, f.boundary) && distToPolyline(p, ring) >= BOUNDARY_CLEARANCE;
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
        if (!inPlayArea(pos) || insideAnyFootprint(pos, buildings)) continue;
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

const SPAWN_ROAD = 'Neusser Straße';
const SPAWN_CAR_KERB = 1.1; // car centre this far from the kerb, on the carriageway
const SPAWN_CAR_AHEAD = 1.2; // metres in front of the player: with the lateral offset this stays within the 3 m enter radius
const CAR_CLEAR_ALONG = 6;
const CAR_CLEAR_ACROSS = 2.5;

type Spot = { pos: Pt; heading: number };

/**
 * The car next to the spawn: on the spawn's side of Neusser Straße, parked along the right-hand kerb (facing the
 * way traffic goes on that side), its centre 1.1 m from the kerb (road width / 2 - 1.1 from the centre line)
 * and 1.2 m ahead of the player (north). Throws when the spot is outside the play area, on the tracks or in a building.
 */
export function spawnCarSpot(f: OsmFeatures, spawn: Pt, buildings: BuildingMesh[]): Spot {
  let best: { p: Pt; dir: Pt; road: Road; d: number } | undefined;
  for (const r of f.roads) {
    if (r.name !== SPAWN_ROAD) continue;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!, b = r.points[i]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-12) continue;
      const t = Math.min(1, Math.max(0, ((spawn.x - a.x) * dx + (spawn.z - a.z) * dz) / l2));
      const p = { x: a.x + t * dx, z: a.z + t * dz };
      const d = dist(p, spawn);
      if (!best || d < best.d) best = { p, dir: { x: dx / Math.sqrt(l2), z: dz / Math.sqrt(l2) }, road: r, d };
    }
  }
  if (!best) throw new Error(`spawnCarSpot: no road named ${SPAWN_ROAD}`);
  // the side of the road the spawn is on, as a sign relative to the way direction (right of dir = (-dir.z, dir.x))
  const side = (spawn.x - best.p.x) * -best.dir.z + (spawn.z - best.p.z) * best.dir.x >= 0 ? 1 : -1;
  const fwd = { x: side * best.dir.x, z: side * best.dir.z }; // right-hand traffic: this side's travel direction
  const north = best.dir.z > 0 ? { x: -best.dir.x, z: -best.dir.z } : best.dir; // the player (spawn) faces north
  const off = side * (best.road.width / 2 - SPAWN_CAR_KERB);
  const pos = {
    x: best.p.x - best.dir.z * off + north.x * SPAWN_CAR_AHEAD,
    z: best.p.z + best.dir.x * off + north.z * SPAWN_CAR_AHEAD,
  };
  const ring = [...f.boundary, f.boundary[0]!];
  if (!pointInPolygon(pos, f.boundary) || distToPolyline(pos, ring) < BOUNDARY_CLEARANCE) throw new Error('spawnCarSpot: outside the play area');
  if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) throw new Error('spawnCarSpot: on the tracks');
  if (insideAnyFootprint(pos, buildings)) throw new Error('spawnCarSpot: inside a building');
  return { pos, heading: Math.atan2(fwd.x, fwd.z) };
}

/** `spot` first, followed by those `spots` that do not overlap it (< 6 m along or < 2.5 m across its axis). */
export function withSpawnCar(spot: Spot, spots: Spot[]): Spot[] {
  const fx = Math.sin(spot.heading), fz = Math.cos(spot.heading);
  const overlaps = (s: Spot) => {
    const dx = s.pos.x - spot.pos.x, dz = s.pos.z - spot.pos.z;
    return Math.abs(dx * fx + dz * fz) < CAR_CLEAR_ALONG && Math.abs(dx * fz - dz * fx) < CAR_CLEAR_ACROSS;
  };
  return [spot, ...spots.filter((s) => !overlaps(s))];
}
