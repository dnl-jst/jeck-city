import { wgs84ToLocal } from '@nn/shared';
import type { BuildingRecord } from './buildingstore.js';
import { insideAnyFootprint } from './footprint.js';
import type { Pt } from './osm.js';
import { pointInPolygon } from './polyline.js';

/** The spawn: on the Domplatte, about 30 m in front of the cathedral's west portal… */
export const SPAWN_AT = wgs84ToLocal(50.94131, 6.95665);
/** …looking east at the middle of the west facade (between the towers). */
export const SPAWN_LOOK_AT = wgs84ToLocal(50.94131, 6.95707);

/**
 * The spawn at `at`, looking at `lookAt`. heading = atan2(dx, dz), i.e. forward = (sin h, cos h). y is left to the
 * caller (the walkable surface there, see topSurface). Throws if the spot lies inside a building or outside the play area.
 */
export function placeSpawn(at: Pt, lookAt: Pt, boundary: Pt[], buildings: readonly BuildingRecord[]): { x: number; z: number; heading: number } {
  if (insideAnyFootprint(at, buildings)) throw new Error(`placeSpawn: (${at.x.toFixed(1)}, ${at.z.toFixed(1)}) lies inside a building`);
  if (boundary.length && !pointInPolygon(at, boundary)) throw new Error(`placeSpawn: (${at.x.toFixed(1)}, ${at.z.toFixed(1)}) lies outside the play area`);
  return { x: at.x, z: at.z, heading: Math.atan2(lookAt.x - at.x, lookAt.z - at.z) };
}

/**
 * Highest non-vertical triangle of `mesh` (xyz vertices, triangle indices) above (x, z) that lies at most `maxAbove` m
 * above `ground` (so roofs and bridges overhead are ignored); `ground` if none is higher.
 */
export function topSurface(mesh: { vertices: ArrayLike<number>; indices: ArrayLike<number> }, x: number, z: number, ground: number, maxAbove = 1): number {
  const v = mesh.vertices, idx = mesh.indices;
  let top = ground;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3, b = idx[i + 1]! * 3, e = idx[i + 2]! * 3;
    const cr = (p: number, q: number) => (v[q]! - v[p]!) * (z - v[p + 2]!) - (v[q + 2]! - v[p + 2]!) * (x - v[p]!);
    const s1 = cr(a, b), s2 = cr(b, e), s3 = cr(e, a);
    if (!((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0))) continue;
    const sum = s1 + s2 + s3;
    if (Math.abs(sum) < 1e-9) continue; // vertical
    // barycentric height: s2 weighs a, s3 weighs b, s1 weighs e
    const y = (s2 * v[a + 1]! + s3 * v[b + 1]! + s1 * v[e + 1]!) / sum;
    if (y > top && y <= ground + maxAbove) top = y;
  }
  return top;
}
