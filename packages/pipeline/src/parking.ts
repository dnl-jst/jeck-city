import { TUNING } from '@nn/shared';
import type { BuildingMesh } from './buildings.js';
import type { ParkOrientation } from './crosssection.js';
import { insideAnyFootprint } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, junctions, pointAt, pointInPolygon } from './polyline.js';

const KERB_SPACING = 6; // roads without parking-strip tags: cars along the kerb
const KERB_OCCUPANCY = 0.4;
const STRIP_OCCUPANCY = 0.7;
const STRIP_SPACING: Record<ParkOrientation, number> = { parallel: 5.8, diagonal: 3.2, perpendicular: 2.6 };
const STRIP_ANGLE: Record<ParkOrientation, number> = { parallel: 0, diagonal: Math.PI / 4, perpendicular: Math.PI / 2 };
const CLEARANCE = 10; // from junction nodes and tram stops
const TRACK_CLEARANCE = 3;
const EDGE_INSET = 1; // car centre this far inside the road edge (or the cycle lane) without a strip
const BOUNDARY_CLEARANCE = 3; // car centre at least this far inside the play-area boundary
const CROSSING_MARGIN = 1; // car body this far clear of a crossing carriageway
const MAX_SPOTS = 400;
const PARKABLE = new Set(['residential', 'tertiary']);
const COS15 = Math.cos((15 * Math.PI) / 180);

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

type Spot = { pos: Pt; heading: number };
/** Where cars stand on one side of a road: centre offset from the axis (signed, right of travel > 0), spacing, angle, occupancy. */
type Lane = { side: 1 | -1; off: number; spacing: number; angle: number; occupancy: number };

/**
 * Parking rows of a road. Sides with a parking strip: cars in the middle of the strip, spaced and angled by its
 * orientation, 70 % occupied. Roads without any strip (residential/tertiary only): along the kerb as before, 1 m inside
 * the carriageway edge or the cycle lane, 40 % (oneways: right of travel only).
 */
function parkingLanes(r: Road): Lane[] {
  const c = r.cross;
  const hw = r.width / 2;
  const strips: Lane[] = [];
  for (const side of [1, -1] as const) {
    const park = side > 0 ? c.parkRight : c.parkLeft;
    const o = side > 0 ? c.parkRightOrientation : c.parkLeftOrientation;
    if (park > 0 && o) strips.push({ side, off: side * (hw - park / 2), spacing: STRIP_SPACING[o], angle: STRIP_ANGLE[o], occupancy: STRIP_OCCUPANCY });
  }
  if (strips.length || !PARKABLE.has(r.kind)) return strips;
  return (r.oneway ? [1] as const : [1, -1] as const).map((side) => ({
    side, off: side * (hw - (side > 0 ? c.cycleRight : c.cycleLeft) - EDGE_INSET), spacing: KERB_SPACING, angle: 0, occupancy: KERB_OCCUPANCY,
  }));
}

/**
 * Facing of a car parked on `side` of a way running along `dir`: with that side's traffic (oneways: the travel
 * direction on both sides), turned towards the kerb by `angle` (diagonal 45°, perpendicular 90°).
 * heading = atan2(fx, fz), forward = (sin h, cos h): the yaw about +y for a model whose nose points along +z.
 */
function parkHeading(dir: Pt, side: 1 | -1, oneway: boolean, angle: number): number {
  const t = oneway ? dir : { x: dir.x * side, z: dir.z * side };
  const n = { x: -dir.z * side, z: dir.x * side }; // towards this side's kerb
  return Math.atan2(t.x * Math.cos(angle) + n.x * Math.sin(angle), t.z * Math.cos(angle) + n.z * Math.sin(angle));
}

/**
 * Parked cars in the parking strips of the cross-section (see parkingLanes). Spots lie inside the play-area
 * boundary (≥ 3 m from it, so also on the collision ground, which covers the boundary bbox + 200 m), outside every
 * building footprint, ≥ 10 m from junction nodes and tram stops, ≥ 3 m from tram tracks, and with the car body
 * ≥ 1 m clear of any crossing (non-parallel) carriageway. At most 400: the ones nearest to `focus` when given,
 * else a deterministic random subset.
 */
export function parkedCarSpots(f: OsmFeatures, seed: number, buildings: BuildingMesh[], focus?: Pt): Spot[] {
  const rand = rng(seed);
  const roads = f.roads.filter((r) => DRIVABLE.has(r.kind) || r.kind === 'service');
  const junc = [...junctions(roads.map((r) => dedupe(r.points))).values()];
  const blockers = [...junc, ...f.tramStops.map((s) => s.pos)];
  const ring = [...f.boundary, f.boundary[0]!]; // closed, for the distance to its last edge
  const inPlayArea = (p: Pt) => pointInPolygon(p, f.boundary) && distToPolyline(p, ring) >= BOUNDARY_CLEARANCE;
  const reach = TUNING.vehicle.length / 2 + CROSSING_MARGIN;
  /** Car body clear of every other carriageway that is not (near) parallel to `dir` there. */
  const clearOfCrossings = (pos: Pt, dir: Pt, self: Road) => roads.every((o) => {
    if (o === self || !DRIVABLE.has(o.kind)) return true;
    for (let i = 1; i < o.points.length; i++) {
      const a = o.points[i - 1]!, b = o.points[i]!;
      if (distToPolyline(pos, [a, b]) >= o.width / 2 + reach) continue;
      const l = dist(a, b) || 1;
      if (Math.abs(((b.x - a.x) * dir.x + (b.z - a.z) * dir.z) / l) < COS15) return false;
    }
    return true;
  });
  const spots: Spot[] = [];

  for (const r of f.roads) {
    const lanes = parkingLanes(r);
    if (!lanes.length) continue;
    const pts = dedupe(r.points);
    if (pts.length < 2) continue;
    const cum = cumulative(pts);
    const total = cum[cum.length - 1]!;
    for (const lane of lanes) {
      for (let s = lane.spacing / 2; s < total; s += lane.spacing) {
        const occupied = rand() < lane.occupancy; // drawn for every candidate so the stream stays stable
        if (!occupied) continue;
        const { p, dir } = pointAt(pts, cum, s);
        const pos = { x: p.x - dir.z * lane.off, z: p.z + dir.x * lane.off };
        if (blockers.some((b) => dist(b, pos) < CLEARANCE)) continue;
        if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) continue;
        if (!inPlayArea(pos) || insideAnyFootprint(pos, buildings)) continue;
        if (!clearOfCrossings(pos, dir, r)) continue;
        spots.push({ pos, heading: parkHeading(dir, lane.side, r.oneway, lane.angle) });
      }
    }
  }
  if (spots.length <= MAX_SPOTS) return spots;
  const keep = spots.map((_, i) => i);
  if (focus) {
    // the cars nearest to the focus (spawn), so the strips around the player are filled at their occupancy
    const d = spots.map((s) => dist(s.pos, focus));
    keep.sort((a, b) => d[a]! - d[b]! || a - b);
  } else {
    // deterministic random subset
    for (let i = keep.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [keep[i], keep[j]] = [keep[j]!, keep[i]!];
    }
  }
  return keep.slice(0, MAX_SPOTS).sort((a, b) => a - b).map((i) => spots[i]!); // original order kept
}

const SPAWN_ROAD = 'Neusser Straße';
const SPAWN_CAR_AHEAD = 1.2; // metres in front of the player, along the spawn heading
const ENTER_REACH = 2.7; // car centre at most this far from the spawn (enter radius 3 m)
const PLAYER_CLEARANCE = 0.8; // car body at least this far from the spawn point
const CAR_HALF_WIDTH = 0.9;
const CAR_CLEAR_ALONG = 6;
const CAR_CLEAR_ACROSS = 2.5;

/** Distance from p to the outline of a car (oriented box 1.8 m × vehicle length) standing at `car`. */
export function carContourDistance(car: Spot, p: Pt): number {
  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  const dx = p.x - car.pos.x, dz = p.z - car.pos.z;
  const along = Math.max(0, Math.abs(dx * fx + dz * fz) - TUNING.vehicle.length / 2);
  const across = Math.max(0, Math.abs(dx * fz - dz * fx) - CAR_HALF_WIDTH);
  return Math.hypot(along, across);
}

/**
 * The car next to the spawn: on the spawn's side of Neusser Straße, in the middle of the parking strip there (or
 * 1 m inside the kerb / cycle lane without a strip), oriented like the other cars of that side, 1.2 m ahead of
 * the player along the spawn heading. Throws when the spot is out of reach (> 2.7 m) or crowds the player (body
 * < 0.8 m away), outside the play area, on the tracks or in a building.
 */
export function spawnCarSpot(f: OsmFeatures, spawn: Pt & { heading: number }, buildings: BuildingMesh[]): Spot {
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
  const { p, dir, road } = best;
  // the side of the road the spawn is on, as a sign relative to the way direction (right of dir = (-dir.z, dir.x))
  const side = (spawn.x - p.x) * -dir.z + (spawn.z - p.z) * dir.x >= 0 ? 1 : -1;
  const c = road.cross;
  const park = side > 0 ? c.parkRight : c.parkLeft;
  const o = (side > 0 ? c.parkRightOrientation : c.parkLeftOrientation) ?? 'parallel';
  const inset = park > 0 ? park / 2 : (side > 0 ? c.cycleRight : c.cycleLeft) + EDGE_INSET;
  const off = side * (road.width / 2 - inset);
  const ahead = { x: Math.sin(spawn.heading), z: Math.cos(spawn.heading) };
  const along = (ahead.x * dir.x + ahead.z * dir.z >= 0 ? 1 : -1) * SPAWN_CAR_AHEAD; // ahead, measured along the road
  const pos = { x: p.x - dir.z * off + dir.x * along, z: p.z + dir.x * off + dir.z * along };
  const spot = { pos, heading: parkHeading(dir, side, road.oneway, park > 0 ? STRIP_ANGLE[o] : 0) };
  const reach = dist(pos, spawn), body = carContourDistance(spot, spawn);
  if (reach > ENTER_REACH) throw new Error(`spawnCarSpot: car ${reach.toFixed(2)} m from the spawn (> ${ENTER_REACH})`);
  if (body < PLAYER_CLEARANCE) throw new Error(`spawnCarSpot: car body ${body.toFixed(2)} m from the spawn (< ${PLAYER_CLEARANCE})`);
  const ring = [...f.boundary, f.boundary[0]!];
  if (!pointInPolygon(pos, f.boundary) || distToPolyline(pos, ring) < BOUNDARY_CLEARANCE) throw new Error('spawnCarSpot: outside the play area');
  if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) throw new Error('spawnCarSpot: on the tracks');
  if (insideAnyFootprint(pos, buildings)) throw new Error('spawnCarSpot: inside a building');
  return spot;
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
