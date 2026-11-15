import type { WorldManifest } from '@nn/shared';
import type { BuildingMesh } from './buildings.js';
import { FLAG_BACKDROP } from './chunks.js';
import { footprintDistance } from './footprint.js';
import type { OsmFeatures, Pt } from './osm.js';
import { distToPolyline, pointInPolygon } from './polyline.js';

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
 * Shops inside the boundary, label = OSM shop type (placeholder until Task 11). buildingId: the
 * non-backdrop building whose footprint contains the point, else the nearest one within 15 m.
 */
export function assignShops(shops: OsmFeatures['shops'], boundary: Pt[], buildings: BuildingMesh[]): WorldManifest['shops'] {
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
    const shop: WorldManifest['shops'][number] = { x: s.pos.x, z: s.pos.z, label: s.type, type: s.type };
    if (best) shop.buildingId = best.id;
    out.push(shop);
  }
  return out;
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
