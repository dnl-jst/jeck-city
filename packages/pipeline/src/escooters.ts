import { BIKE_TYPES } from '@nn/shared';
import type { BuildingRecord } from './buildingstore.js';
import { footprintContains } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { placeRand } from './placerand.js';
import { cumulative, dedupe, DRIVABLE, dist, distToPolyline, pointAt, pointInPolygon } from './polyline.js';
import { edgeAt, inRamp, nearestOn, onCarriageway, profileOf } from './roadprofile.js';
import { allSidewalkWidths, buildingGrid, type SidewalkWidths, widthAt } from './sidewalkwidth.js';

export const ESCOOTER_TYPE = BIKE_TYPES.indexOf('escooter');
/** Fleet colours of the (fictional) rental operators: green, turquoise, orange. */
export const FLEET_COLORS = [0x23a455, 0x13a6b4, 0xf06a1c];

export type PlacedScooter = { x: number; z: number; heading: number; type: number; color: number; down: boolean };

/** A candidate spot every this many metres along each side of a drivable road… */
const STEP = 30;
/** …taken with this chance (one group per ~140 m of sidewalk). */
const GROUP_CHANCE = 0.22;
/** Group sizes and their weights: mostly single scooters, now and then a little herd. */
const GROUP_SIZES: [number, number][] = [[1, 0.55], [2, 0.2], [3, 0.15], [4, 0.1]];
/** A group's scooters belong to one fleet with this chance; otherwise each draws its own. */
const SAME_FLEET = 0.8;
/** Knocked over (lying on the left side). */
const DOWN_CHANCE = 0.08;
/** Parked across the kerb (front or back to the road) with this chance, else along it. */
const ACROSS_CHANCE = 0.55;
/** Centre this far behind the kerb (m): along the kerb, and across it (half length 0.58 m + a hand's width). */
const KERB_OFF_ALONG = 0.5;
const KERB_OFF_ACROSS = 0.75;
/** Neighbours in a group stand this far apart along the kerb (m). */
const GAP_ALONG = 1.35;
const GAP_ACROSS = 0.7;
/** Sloppy parking: heading jitter (± rad) and position jitter along the kerb (± m). */
const HEADING_JITTER = 0.35;
const POS_JITTER = 0.25;
/** The sidewalk must be this wide (m): scooter plus room to walk past. */
const MIN_SIDEWALK = 2.2;
/** Half the scooter's length (m): the ends must be clear of buildings and carriageways too. */
const HALF_LENGTH = 0.6;
/** A lying scooter's bar reaches this far to its left side (m). */
const LYING_REACH = 1.05;
const JUNCTION_CLEARANCE = 8;
const STOP_CLEARANCE = 12;
const TRACK_CLEARANCE = 2.5;
const POST_CLEARANCE = 0.9; // lamps and trees
const HOOP_CLEARANCE = 2;
const SPAWN_CLEARANCE = 4;
const BOUNDARY_CLEARANCE = 3;
const COS30 = Math.cos((30 * Math.PI) / 180);

/** What else stands on the sidewalk (scooters keep clear of it). */
export type SidewalkObstacles = { lamps: Pt[]; trees: Pt[]; hoops: Pt[]; keepClear: Pt[] };

const pickSize = (u: number): number => {
  for (const [n, w] of GROUP_SIZES) if ((u -= w) < 0) return n;
  return 1;
};

/**
 * Rental e-scooters standing about on the sidewalks of drivable roads: every 30 m per side a candidate, 22 % of them
 * get a group of 1–4 scooters (mostly one fleet), parked along or across the kerb with sloppy headings; 8 % lie on
 * their side. Each decision is drawn from the candidate's position (placeRand), so scooters stay where they are when
 * the OSM data changes elsewhere. A scooter is skipped on a sidewalk narrower than 2.2 m, in a kerb ramp, within 8 m of
 * a crossing carriageway's kerb, near tram stops (12 m) or tracks (2.5 m), lamps and trees (0.9 m), rack hoops (2 m),
 * the `keepClear` points (4 m: spawn, spawn car and bike), the play-area edge (3 m), or with any part in a building or
 * on a carriageway (a lying one with its bar too; otherwise it stays upright).
 */
export function placeScooters(
  f: OsmFeatures, buildings: readonly BuildingRecord[], seed: number, obstacles: SidewalkObstacles,
  widths: Map<Road, SidewalkWidths> = allSidewalkWidths(f.roads, buildings),
): PlacedScooter[] {
  const net = f.roads.filter((r) => (DRIVABLE.has(r.kind) || r.kind === 'service') && dedupe(r.points).length >= 2).map((r) => {
    const pts = dedupe(r.points);
    const p = profileOf(r);
    const pad = Math.max(...p.left.map((e) => e.kerb), ...p.right.map((e) => e.kerb)) + JUNCTION_CLEARANCE;
    return { r, box: { minX: Math.min(...pts.map((q) => q.x)) - pad, maxX: Math.max(...pts.map((q) => q.x)) + pad, minZ: Math.min(...pts.map((q) => q.z)) - pad, maxZ: Math.max(...pts.map((q) => q.z)) + pad } };
  });
  type Box = (typeof net)[number]['box'];
  const inBox = (q: Pt, b: Box) => q.x >= b.minX && q.x <= b.maxX && q.z >= b.minZ && q.z <= b.maxZ;
  const grid = buildingGrid(buildings);
  const ring = [...f.boundary, f.boundary[0]!];
  const inBuilding = (q: Pt) => grid.near(q, 0).some((b) => footprintContains(b, q.x, q.z));
  const onAnyCarriageway = (q: Pt) => net.some(({ r, box }) => inBox(q, box) && onCarriageway(r, q));
  const nearCrossing = (pos: Pt, dir: Pt, self: Road) => net.some(({ r: o, box }) => {
    if (o === self || !inBox(pos, box)) return false;
    const n = nearestOn(o, pos);
    if (Math.abs(n.dir.x * dir.x + n.dir.z * dir.z) >= COS30) return false;
    return onCarriageway(o, pos, JUNCTION_CLEARANCE);
  });
  const posts = [...obstacles.lamps, ...obstacles.trees];
  const out: PlacedScooter[] = [];
  const free = (pos: Pt, heading: number): boolean => {
    if (!pointInPolygon(pos, f.boundary) || distToPolyline(pos, ring) < BOUNDARY_CLEARANCE) return false;
    if (obstacles.keepClear.some((k) => dist(k, pos) < SPAWN_CLEARANCE)) return false;
    if (f.tramStops.some((t) => dist(t.pos, pos) < STOP_CLEARANCE)) return false;
    if (f.tramTracks.some((t) => distToPolyline(pos, t) < TRACK_CLEARANCE)) return false;
    if (posts.some((l) => dist(l, pos) < POST_CLEARANCE)) return false;
    if (obstacles.hoops.some((h) => dist(h, pos) < HOOP_CLEARANCE)) return false;
    if (out.some((o) => dist(o, pos) < 0.5)) return false;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const ends = [pos, { x: pos.x + fx * HALF_LENGTH, z: pos.z + fz * HALF_LENGTH }, { x: pos.x - fx * HALF_LENGTH, z: pos.z - fz * HALF_LENGTH }];
    return !ends.some((e) => inBuilding(e) || onAnyCarriageway(e));
  };

  for (const { r } of net) {
    if (!DRIVABLE.has(r.kind)) continue;
    const pts = dedupe(r.points);
    const cum = cumulative(pts);
    const total = cum[cum.length - 1]!;
    const sw = widths.get(r);
    if (!sw) throw new Error(`placeScooters: no sidewalk widths for way ${r.id}`);
    for (const side of [1, -1] as const) {
      for (let s = STEP / 2; s < total; s += STEP) {
        const at = pointAt(pts, cum, s);
        const key = { x: at.p.x - at.dir.z * side * 3, z: at.p.z + at.dir.x * side * 3 }; // the candidate, keyed per side
        if (placeRand(seed, key) >= GROUP_CHANCE) continue;
        const n = pickSize(placeRand(seed, key, 1));
        const across = placeRand(seed, key, 2) < ACROSS_CHANCE;
        const flip = placeRand(seed, key, 3) < 0.5; // which way they face
        const fleet = Math.floor(placeRand(seed, key, 4) * FLEET_COLORS.length);
        const gap = across ? GAP_ACROSS : GAP_ALONG;
        for (let k = 0; k < n; k++) {
          const u = (u0: number) => placeRand(seed, key, 10 + k * 8 + u0);
          const sk = s + (k - (n - 1) / 2) * gap + (u(0) - 0.5) * 2 * POS_JITTER;
          if (sk < 0 || sk > total) continue;
          if (widthAt(sw, side, sk) < MIN_SIDEWALK) continue;
          if (inRamp(r, sk - 1, sk + 1)) continue;
          const { p, dir } = pointAt(pts, cum, sk);
          const off = side * (edgeAt(r, side, 'kerb', sk) + (across ? KERB_OFF_ACROSS : KERB_OFF_ALONG));
          const pos = { x: p.x - dir.z * off, z: p.z + dir.x * off };
          if (nearCrossing(pos, dir, r)) continue;
          // along: with or against the way; across: the outward normal of this side (away from the road) or towards it
          const out0 = { x: -dir.z * side, z: dir.x * side };
          const base = across ? Math.atan2(out0.x, out0.z) : Math.atan2(dir.x, dir.z);
          let heading = base + (flip ? Math.PI : 0) + (u(1) - 0.5) * 2 * HEADING_JITTER;
          heading = Math.atan2(Math.sin(heading), Math.cos(heading));
          if (!free(pos, heading)) continue;
          // lying on its left side: the bar reaches out to the left, (cos h, −sin h)
          let down = u(2) < DOWN_CHANCE;
          if (down) {
            const bar = { x: pos.x + Math.cos(heading) * LYING_REACH, z: pos.z - Math.sin(heading) * LYING_REACH };
            if (inBuilding(bar) || onAnyCarriageway(bar)) down = false;
          }
          const color = u(3) < SAME_FLEET ? FLEET_COLORS[fleet]! : FLEET_COLORS[Math.floor(u(4) * FLEET_COLORS.length)]!;
          out.push({ x: pos.x, z: pos.z, heading, type: ESCOOTER_TYPE, color, down });
        }
      }
    }
  }
  return out;
}
