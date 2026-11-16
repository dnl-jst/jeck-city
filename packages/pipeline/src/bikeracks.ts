import type { BuildingMesh } from './buildings.js';
import { insideAnyFootprint } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { carContourDistance, rng } from './parking.js';
import { DRIVABLE, distToPolyline, pointInPolygon } from './polyline.js';
import { edgeAt, nearestOn } from './roadprofile.js';

/**
 * One straight row of bike rack hoops. heading = the direction bikes stand in at the hoops (facing the nearest road),
 * forward = (sin h, cos h); the row runs across it. inStrip: the row stands in a road's parking strip.
 */
export type RackRow = { hoops: Pt[]; heading: number; kind: 0 | 1; inStrip: boolean };
export type PlacedBike = { x: number; z: number; heading: number; type: number; color: number };

const HOOP_SPACING = 1;
const MAX_HOOPS_PER_ROW = 12;
const ROW_SPACING = 2;
/** A rack aligns with the nearest drivable road within this distance (m). */
const ROAD_REACH = 40;
/** Racks that land in a driving lane move onto the sidewalk, this far beyond the kerb. */
const SIDEWALK_INSET = 0.8;
/** A parking strip narrower than this does not count as one. */
const MIN_STRIP = 0.5;
const TRACK_CLEARANCE = 3;
const BOUNDARY_CLEARANCE = 1;

/** Hoop plus a parked bike reach this far along the heading from the hoop centre (m). */
const BIKE_REACH = 0.95;
/** A rack too close to a wall moves towards the road in these steps, at most MAX_WALL_SHIFT (m). */
const WALL_SHIFT_STEP = 0.25;
const MAX_WALL_SHIFT = 2.5;

/** The hoop position (shifted towards the road if needed) whose hoop and bikes are outside every footprint, or null. */
function clearOfBuildings(h: Pt, toRoad: Pt, buildings: BuildingMesh[]): Pt | null {
  for (let shift = 0; shift <= MAX_WALL_SHIFT + 1e-9; shift += WALL_SHIFT_STEP) {
    const p = { x: h.x + toRoad.x * shift, z: h.z + toRoad.z * shift };
    const ends = [p, { x: p.x + toRoad.x * BIKE_REACH, z: p.z + toRoad.z * BIKE_REACH }, { x: p.x - toRoad.x * BIKE_REACH, z: p.z - toRoad.z * BIKE_REACH }];
    if (!ends.some((e) => insideAnyFootprint(e, buildings))) return p;
  }
  return null;
}

/** Bike slots: this far either side of a hoop, along the row (clear of the hoop with the 0.15 m half-wide parked box). */
const SLOT_OFFSET = 0.25;
/** Cargo bikes stand parallel to the row this far behind it (away from the road). */
const CARGO_BEHIND = 1.6;
/** Minimum hoops between two cargo bikes of one row (they are ~2.5 m long). */
const CARGO_GAP = 3;
/** Per hoop: chance of a cargo bike (when allowed); otherwise per slot: chance of a bike. ~50 % of slots in total. */
const CARGO_CHANCE = 0.14;
const SLOT_CHANCE = 0.45;
/** Non-cargo type weights: dutch, road, mtb (spec 45 / 15 / 20 of all bikes). */
const TYPE_WEIGHTS: [number, number][] = [[0, 0.45], [1, 0.15], [2, 0.2]];
/** Frame colours (sRGB hex). */
const COLORS = [0x1d1d1f, 0xf2f0ea, 0x7a1f1f, 0x23436b, 0x2f5d3a, 0x9a9da3, 0xc9a227, 0x5b3a6e, 0xd76b2a, 0x8fb8c9];

const unit = (x: number, z: number): Pt => {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
};

/** Longest-distance pair direction of an outline (its main axis), or null for a point-like one. */
function mainAxis(outline: Pt[]): Pt | null {
  let best: Pt | null = null, bestD = 3;
  for (let i = 0; i < outline.length; i++) for (let j = i + 1; j < outline.length; j++) {
    const d = Math.hypot(outline[j]!.x - outline[i]!.x, outline[j]!.z - outline[i]!.z);
    if (d > bestD) [best, bestD] = [unit(outline[j]!.x - outline[i]!.x, outline[j]!.z - outline[i]!.z), d];
  }
  return best;
}

function nearestRoad(roads: Road[], p: Pt): { road: Road; n: ReturnType<typeof nearestOn> } | null {
  let best: { road: Road; n: ReturnType<typeof nearestOn> } | null = null;
  for (const road of roads) {
    if (!DRIVABLE.has(road.kind) || road.points.length < 2) continue;
    const n = nearestOn(road, p);
    if (n.dist <= ROAD_REACH && (!best || n.dist < best.n.dist)) best = { road, n };
  }
  return best;
}

/**
 * Rows of hoops for every OSM bike parking (stands → kind 0, wall loops/bollards → kind 1, the rest skipped):
 * ceil(capacity / 2) hoops 1 m apart, at most 12 per row (more → parallel rows 2 m further from the road), the row
 * along the nearest drivable road (an area: along its main axis), bikes facing the road. In a parking strip the row
 * stays; in a driving lane it moves onto the sidewalk. Hoops in buildings, near tram tracks or outside the play area go.
 */
export function layoutRacks(f: OsmFeatures, buildings: BuildingMesh[]): RackRow[] {
  const rows: RackRow[] = [];
  const ring = [...f.boundary, f.boundary[0]!];
  for (const p of f.bikeParking) {
    if (p.kind === 'other') continue;
    let centre = p.pos;
    let dir: Pt = { x: 1, z: 0 };
    let toRoad: Pt = { x: 0, z: 1 };
    let inStrip = false;
    const near = nearestRoad(f.roads, centre);
    if (near) {
      const { road, n } = near;
      const side = n.d >= 0 ? 1 : -1;
      const right = { x: -n.dir.z, z: n.dir.x };
      dir = n.dir;
      toRoad = { x: -side * right.x, z: -side * right.z };
      const cycle = edgeAt(road, side, 'cycle', n.s), kerb = edgeAt(road, side, 'kerb', n.s);
      const off = Math.abs(n.d);
      if (off < kerb) {
        if (off >= cycle && kerb - cycle >= MIN_STRIP) inStrip = true;
        else {
          const foot = { x: centre.x - right.x * n.d, z: centre.z - right.z * n.d };
          const d = side * (kerb + SIDEWALK_INSET);
          centre = { x: foot.x + right.x * d, z: foot.z + right.z * d };
        }
      }
    }
    const axis = p.outline ? mainAxis(p.outline) : null;
    if (axis) {
      dir = axis;
      // bikes stand across the axis, towards the road side
      const a = { x: -axis.z, z: axis.x };
      toRoad = a.x * toRoad.x + a.z * toRoad.z >= 0 ? a : { x: -a.x, z: -a.z };
    }
    const heading = Math.atan2(toRoad.x, toRoad.z);
    const total = Math.ceil(p.capacity / 2);
    for (let r = 0; r * MAX_HOOPS_PER_ROW < total; r++) {
      const m = Math.min(MAX_HOOPS_PER_ROW, total - r * MAX_HOOPS_PER_ROW);
      const back = r * ROW_SPACING;
      const hoops: Pt[] = [];
      for (let k = 0; k < m; k++) {
        const t = (k - (m - 1) / 2) * HOOP_SPACING;
        const at = { x: centre.x + dir.x * t - toRoad.x * back, z: centre.z + dir.z * t - toRoad.z * back };
        // hoop and the bikes in it reach ±BIKE_REACH along the heading: move towards the road until clear of walls
        const h = clearOfBuildings(at, toRoad, buildings);
        if (!h) continue;
        if (f.tramTracks.some((tr) => distToPolyline(h, tr) < TRACK_CLEARANCE)) continue;
        if (!pointInPolygon(h, f.boundary) || distToPolyline(h, ring) < BOUNDARY_CLEARANCE) continue;
        hoops.push(h);
      }
      if (hoops.length) rows.push({ hoops, heading, kind: p.kind === 'wall' ? 1 : 0, inStrip: inStrip && r === 0 });
    }
  }
  return rows;
}

/**
 * Bikes in the racks, deterministic for a seed: per hoop either a cargo bike (Long John or trike, parallel to the row
 * 1.6 m behind it, at least 3 hoops from the row's previous one) or up to two bikes in the slots either side of the
 * hoop; ~50 % of the slots are taken, types per spec (dutch 45 %, mtb 20 %, road 15 %, Long John 10 %, trike 10 %).
 * `buildings`: cargo bikes whose spot lies in one are left out.
 */
export function fillRacks(rows: RackRow[], seed: number, buildings: BuildingMesh[] = []): PlacedBike[] {
  const rand = rng(seed);
  const out: PlacedBike[] = [];
  const color = () => COLORS[Math.floor(rand() * COLORS.length)]!;
  const pick = (): number => {
    let r = rand() * TYPE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    for (const [t, w] of TYPE_WEIGHTS) if ((r -= w) < 0) return t;
    return 0;
  };
  for (const row of rows) {
    const fx = Math.sin(row.heading), fz = Math.cos(row.heading);
    const ax = fz, az = -fx; // along the row
    let lastCargo = -Infinity;
    row.hoops.forEach((h, k) => {
      if (k - lastCargo >= CARGO_GAP && rand() < CARGO_CHANCE) {
        const pos = { x: h.x - fx * CARGO_BEHIND, z: h.z - fz * CARGO_BEHIND };
        const type = rand() < 0.5 ? 3 : 4;
        const heading = Math.atan2(ax, az) + (rand() < 0.5 ? 0 : Math.PI);
        // the whole cargo bike (±1.3 m along the row, ±0.45 m across) must be outside every building
        const corners = [-1, 1].flatMap((a) => [-1, 1].map((b) => ({ x: pos.x + ax * 1.3 * a - fx * 0.45 * b, z: pos.z + az * 1.3 * a - fz * 0.45 * b })));
        if (![pos, ...corners].some((c) => insideAnyFootprint(c, buildings))) {
          out.push({ ...pos, heading: Math.atan2(Math.sin(heading), Math.cos(heading)), type, color: color() });
          lastCargo = k;
          return;
        }
      }
      for (const s of [-1, 1]) {
        if (rand() >= SLOT_CHANCE) continue;
        out.push({ x: h.x + ax * SLOT_OFFSET * s, z: h.z + az * SLOT_OFFSET * s, heading: row.heading, type: pick(), color: color() });
      }
    });
  }
  return out;
}

/** Parking spots (cars) without those within `clearance` of a rack hoop. */
export function dropCarsAtRacks<S extends { pos: Pt }>(spots: S[], rows: RackRow[], clearance = 3): S[] {
  const hoops = rows.flatMap((r) => r.hoops);
  return spots.filter((s) => !hoops.some((h) => Math.hypot(h.x - s.pos.x, h.z - s.pos.z) < clearance));
}

const SPAWN_BIKE_BEHIND = [2.2, 1.8, 2.6];
const SPAWN_CAR_CLEARANCE = 1;

/**
 * The Long John at the spawn: parallel to the spawn heading, ~2.2 m from the player on the side away from the spawn
 * car, on the sidewalk the player stands on. Throws if no spot clears buildings, the car and the play-area edge.
 */
export function spawnBikeSpot(f: OsmFeatures, spawn: Pt & { heading: number }, car: { pos: Pt; heading: number }, buildings: BuildingMesh[]): { x: number; z: number; heading: number } {
  const fx = Math.sin(spawn.heading), fz = Math.cos(spawn.heading);
  const away = (car.pos.x - spawn.x) * fx + (car.pos.z - spawn.z) * fz >= 0 ? -1 : 1;
  for (const d of SPAWN_BIKE_BEHIND) {
    const p = { x: spawn.x + away * fx * d, z: spawn.z + away * fz * d };
    if (insideAnyFootprint(p, buildings)) continue;
    if (carContourDistance(car, p) < SPAWN_CAR_CLEARANCE) continue;
    if (f.boundary.length && !pointInPolygon(p, f.boundary)) continue;
    return { ...p, heading: spawn.heading };
  }
  throw new Error('spawnBikeSpot: no free spot next to the spawn');
}
