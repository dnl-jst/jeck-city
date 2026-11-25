import type { BuildingMesh } from './buildings.js';
import type { Pt } from './osm.js';

export type Footprint = { minX: number; minZ: number; maxX: number; maxZ: number; tris: number[] };
/** Anything that carries its footprint (a BuildingRecord). */
type Footprinted = { footprint: Footprint };

/** Roof triangles projected onto x/z (LoD2 roofs cover the footprint, flat x,z triples) plus their bbox. */
export function footprintOf(b: BuildingMesh): Footprint {
  const fp: Footprint = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity, tris: [] };
  const p = b.positions;
  for (let v = 0; v < b.kind.length; v += 3) {
    if (b.kind[v] !== 1) continue;
    for (let k = 0; k < 3; k++) {
      const x = p[(v + k) * 3]!, z = p[(v + k) * 3 + 2]!;
      fp.tris.push(x, z);
      fp.minX = Math.min(fp.minX, x); fp.maxX = Math.max(fp.maxX, x);
      fp.minZ = Math.min(fp.minZ, z); fp.maxZ = Math.max(fp.maxZ, z);
    }
  }
  return fp;
}

function inTri(t: number[], i: number, x: number, z: number): boolean {
  const [ax, az, bx, bz, cx, cz] = [t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!];
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Whether (x, z) lies under the building's roof, i.e. inside its footprint. */
export function footprintContains(b: Footprinted, x: number, z: number): boolean {
  const fp = b.footprint;
  if (x < fp.minX || x > fp.maxX || z < fp.minZ || z > fp.maxZ) return false;
  for (let i = 0; i < fp.tris.length; i += 6) if (inTri(fp.tris, i, x, z)) return true;
  return false;
}

export const insideAnyFootprint = (p: Pt, buildings: readonly Footprinted[]): boolean => buildings.some((b) => footprintContains(b, p.x, p.z));

/** Horizontal distance from (x, z) to the footprint: 0 inside, else to the nearest roof-triangle edge. */
export function footprintDistance(b: Footprinted, x: number, z: number): number {
  if (footprintContains(b, x, z)) return 0;
  const t = b.footprint.tris;
  let best = Infinity;
  for (let i = 0; i < t.length; i += 6) {
    for (let k = 0; k < 3; k++) {
      const ax = t[i + k * 2]!, az = t[i + k * 2 + 1]!;
      const bx = t[i + ((k + 1) % 3) * 2]!, bz = t[i + ((k + 1) % 3) * 2 + 1]!;
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      const u = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + u * dx), z - (az + u * dz)));
    }
  }
  return best;
}
