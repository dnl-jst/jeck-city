import { TUNING } from '@nn/shared';
import type { BuildingMesh } from './buildings.js';
import type { ParkOrientation } from './crosssection.js';
import { insideAnyFootprint } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, junctions, pointAt, pointInPolygon } from './polyline.js';
import { edgeAt, inRamp, onCarriageway } from './roadprofile.js';

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
const MAX_SPOTS = 2600;
const PARKABLE = new Set(['residential', 'tertiary']);
const COS15 = Math.cos((15 * Math.PI) / 180);

/** Deterministic PRNG (mulberry32) so a seed always yields the same spots. */
export function rng(seed: number): () => number {
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
type Lane = { side: 1 | -1; off: (s: number) => number; spacing: number; angle: number; occupancy: number };

/**
 * Parking rows of a road. Sides with a parking strip: cars in the middle of the strip, spaced and angled by its
 * orientation, 70 % occupied. Roads without any strip (residential/tertiary only): along the kerb as before, 1 m inside
 * the carriageway edge or the cycle lane, 40 % (oneways: right of travel only).
 */
function parkingLanes(r: Road): Lane[] {
  const c = r.cross;
  const strips: Lane[] = [];
  for (const side of [1, -1] as const) {
    const park = side > 0 ? c.parkRight : c.parkLeft;
    const o = side > 0 ? c.parkRightOrientation : c.parkLeftOrientation;
    if (park > 0 && o) strips.push({ side, off: stripCentre(r, side), spacing: STRIP_SPACING[o], angle: STRIP_ANGLE[o], occupancy: STRIP_OCCUPANCY });
  }
  if (strips.length || !PARKABLE.has(r.kind)) return strips;
  return (r.oneway ? [1] as const : [1, -1] as const).map((side) => ({
    side, off: kerbRow(r, side), spacing: KERB_SPACING, angle: 0, occupancy: KERB_OCCUPANCY,
  }));
}

/** Signed offset of the middle of the parking strip (between cycle lane and kerb) at arc length s. */
const stripCentre = (r: Road, side: 1 | -1) => (s: number) => (side * (edgeAt(r, side, 'cycle', s) + edgeAt(r, side, 'kerb', s))) / 2;
/** Signed offset of a car parked at the kerb without a strip: 1 m inside the edge of the car lanes (beside a cycle lane, never on it). */
const kerbRow = (r: Road, side: 1 | -1) => (s: number) => side * (edgeAt(r, side, 'lane', s) - EDGE_INSET);

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
 * ≥ 1 m clear of any crossing (non-parallel) carriageway, and not in a kerb ramp between ways (roadprofile.ts).
 * At most 2600, a deterministic random subset beyond that.
 */
export function parkedCarSpots(f: OsmFeatures, seed: number, buildings: BuildingMesh[]): Spot[] {
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
      if (distToPolyline(pos, [a, b]) >= o.width + reach) continue; // far from this segment whatever the side
      const l = dist(a, b) || 1;
      if (Math.abs(((b.x - a.x) * dir.x + (b.z - a.z) * dir.z) / l) >= COS15) continue; // parallel
      if (onCarriageway(o, pos, reach)) return false;
    }
    return true;
  });
  const halfLength = TUNING.vehicle.length / 2;
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
        if (inRamp(r, s - halfLength, s + halfLength)) continue; // the kerb moves there
        const { p, dir } = pointAt(pts, cum, s);
        const off = lane.off(s);
        const pos = { x: p.x - dir.z * off, z: p.z + dir.x * off };
        if (blockers.some((b) => dist(b, pos) < CLEARANCE)) continue;
        if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) continue;
        if (!inPlayArea(pos) || insideAnyFootprint(pos, buildings)) continue;
        if (!clearOfCrossings(pos, dir, r)) continue;
        spots.push({ pos, heading: parkHeading(dir, lane.side, r.oneway, lane.angle) });
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
