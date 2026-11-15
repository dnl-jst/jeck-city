import { SIGN_Y, type WorldManifest } from '@nn/shared';
import type { BuildingMesh } from './buildings.js';
import { FLAG_BACKDROP } from './chunks.js';
import { footprintDistance } from './footprint.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { DRIVABLE, distToPolyline, pointInPolygon } from './polyline.js';

export const BACKDROP_DISTANCE = 150;
const SHOP_BUILDING_DISTANCE = 15;

/** Centroid inside the boundary: kept as is; outside but ≤ 150 m away: flags |= 2 (backdrop); farther: dropped. */
export function classifyBuildings(buildings: BuildingMesh[], boundary: Pt[]): BuildingMesh[] {
  const out: BuildingMesh[] = [];
  for (const b of buildings) {
    if (pointInPolygon(b.centroid, boundary)) out.push(b);
    else if (distToPolyline(b.centroid, boundary) <= BACKDROP_DISTANCE) out.push({ ...b, flags: b.flags | FLAG_BACKDROP });
  }
  return out;
}

/**
 * Shops inside the boundary. label: the given one (shop names, Task 11), else the OSM type. buildingId: the
 * non-backdrop building whose footprint contains the point, else the nearest one within 15 m. sign: with
 * `roads`, where the sign board goes on that building (see shopSign).
 */
export function assignShops(
  shops: (OsmFeatures['shops'][number] & { label?: string })[], boundary: Pt[], buildings: BuildingMesh[], roads: Road[] = [],
): WorldManifest['shops'] {
  const candidates = buildings.filter((b) => (b.flags & FLAG_BACKDROP) === 0);
  const out: WorldManifest['shops'] = [];
  for (const s of shops) {
    if (!pointInPolygon(s.pos, boundary)) continue;
    let best: BuildingMesh | undefined;
    let bestD = SHOP_BUILDING_DISTANCE;
    for (const b of candidates) {
      // cheap reject before the exact footprint distance
      if (Math.abs(b.centroid.x - s.pos.x) > 200 || Math.abs(b.centroid.z - s.pos.z) > 200) continue;
      const d = footprintDistance(b, s.pos.x, s.pos.z);
      if (d <= bestD) [best, bestD] = [b, d];
      if (d === 0) break;
    }
    const shop: WorldManifest['shops'][number] = { x: s.pos.x, z: s.pos.z, label: s.label ?? s.type, type: s.type };
    if (best) {
      shop.buildingId = best.id;
      const sign = roads.length ? shopSign(best, s.pos, roads) : undefined;
      if (sign) shop.sign = sign;
    }
    out.push(shop);
  }
  return out;
}

export type ShopSign = NonNullable<WorldManifest['shops'][number]['sign']>;

const SIGN_MAX_WIDTH = 6;
/** Gap between wall and sign board (m), so the board never z-fights the facade. */
const SIGN_OFFSET = 0.06;
/** A wall faces a street if a road centreline lies in front of it within this distance (m). */
const SIGN_ROAD_REACH = 40;

type Wall = { nx: number; nz: number; d: number; s0: number; s1: number };

/** Vertical wall planes of a building: triangles merged by plane, as an interval along the wall tangent (−nz, nx). */
function wallsOf(b: BuildingMesh): Wall[] {
  const walls: Wall[] = [];
  const p = b.positions, n = b.normals;
  for (let v = 0; v < b.kind.length; v += 3) {
    if (b.kind[v] !== 0) continue;
    let nx = n[v * 3]!, nz = n[v * 3 + 2]!;
    const l = Math.hypot(nx, nz);
    if (l < 0.9) continue; // not vertical
    nx /= l; nz /= l;
    let d = 0, s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = p[(v + k) * 3]!, z = p[(v + k) * 3 + 2]!;
      d += (x * nx + z * nz) / 3;
      const s = -x * nz + z * nx;
      s0 = Math.min(s0, s); s1 = Math.max(s1, s);
    }
    const same = walls.find((w) => w.nx * nx + w.nz * nz > 0.999 && Math.abs(w.d - d) < 0.05 && s0 <= w.s1 + 0.1 && s1 >= w.s0 - 0.1);
    if (same) { same.s0 = Math.min(same.s0, s0); same.s1 = Math.max(same.s1, s1); } else walls.push({ nx, nz, d, s0, s1 });
  }
  return walls;
}

/** Distance from p to the nearest road point lying in front of the wall normal (> 1 m ahead); Infinity if none. */
function roadInFront(p: Pt, nx: number, nz: number, roads: Road[]): number {
  let best = Infinity;
  for (const r of roads) {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i]!, b = r.points[i + 1]!;
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const u = l2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
      const qx = a.x + u * dx - p.x, qz = a.z + u * dz - p.z;
      if (qx * nx + qz * nz > 1) best = Math.min(best, Math.hypot(qx, qz));
    }
  }
  return best;
}

/**
 * Sign board for a shop: on the building wall that faces a street (drivable or pedestrian road in front
 * within 40 m) and lies nearest the shop point. x/z = board centre just in front of the wall, y = LoD2 base + SIGN_Y, heading =
 * outward wall normal (forward = (sin h, cos h)), width ≤ 6 m and fitting the wall. undefined without such a wall.
 */
export function shopSign(b: BuildingMesh, shop: Pt, roads: Road[]): ShopSign | undefined {
  const near = roads.filter((r) => (DRIVABLE.has(r.kind) || r.kind === 'pedestrian')
    && r.points.some((q) => Math.abs(q.x - b.centroid.x) < 150 && Math.abs(q.z - b.centroid.z) < 150));
  let best: { w: Wall; s: number; score: number } | undefined;
  for (const w of wallsOf(b)) {
    if (w.s1 - w.s0 < 2) continue;
    const sm = (w.s0 + w.s1) / 2;
    const mid = { x: w.nx * w.d - w.nz * sm, z: w.nz * w.d + w.nx * sm };
    const road = roadInFront(mid, w.nx, w.nz, near);
    if (road > SIGN_ROAD_REACH) continue;
    const sp = -shop.x * w.nz + shop.z * w.nx;
    const s = Math.min(w.s1, Math.max(w.s0, sp));
    const score = Math.hypot(shop.x * w.nx + shop.z * w.nz - w.d, sp - s) + 0.5 * road;
    if (!best || score < best.score) best = { w, s: sp, score };
  }
  if (!best) return undefined;
  const { w } = best;
  const width = Math.min(SIGN_MAX_WIDTH, w.s1 - w.s0 - 0.4);
  const s = Math.min(w.s1 - width / 2 - 0.2, Math.max(w.s0 + width / 2 + 0.2, best.s));
  const d = w.d + SIGN_OFFSET;
  return { x: w.nx * d - w.nz * s, y: b.base + SIGN_Y, z: w.nz * d + w.nx * s, heading: Math.atan2(w.nx, w.nz), width };
}

/** Everyday car colours: white, black, silver, grey, dark blue, red, VW-ish blue, beige. */
export const PARKED_PALETTE = [0xf2f2ee, 0x161616, 0xb9bdc1, 0x6a6d71, 0x1d2a45, 0xa51c1f, 0x2d5f8f, 0xd6c6a2];

/** 32-bit integer mix (murmur3 finalizer) of seed and index. */
function mix(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function parkedCars(spots: { pos: Pt; heading: number }[], seed: number): WorldManifest['parked'] {
  return spots.map((s, i) => ({ x: s.pos.x, z: s.pos.z, heading: s.heading, color: PARKED_PALETTE[mix(seed, i) % PARKED_PALETTE.length]! }));
}
