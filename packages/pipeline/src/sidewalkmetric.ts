import type { BuildingRecord } from './buildingstore.js';
import type { Mesh } from './streets.js';

/** Grid spacing of the fit metric (m): sample points are the cell centres of a world-aligned grid. */
export const FIT_CELL = 0.5;
/** A sidewalk sample counts as overshoot when it and the samples this far away in x and z all lie in footprints (m). */
const DEEP = 1;
/** Undershoot: open ground between a sidewalk and a facade at most this far beyond it (8 m from the kerb − 1.5 m). */
const GAP_MAX = 6.5;

const SIDEWALK = 1, SURFACE = 2, BUILDING = 4, GAP = 8;

/**
 * How well the sidewalks meet the building line, on a 0.5 m grid sample: `area` of the sidewalk, `overshoot` the
 * sidewalk area at least 1 m deep inside building footprints, `undershoot` the open ground (no street surface, no
 * footprint) between a sidewalk's edge and a facade at most 6.5 m beyond it, walked along x and z from the edge.
 * `surfaces`: the other street meshes (road, curb, parking, …), which end such a walk.
 */
export function sidewalkFit(sidewalk: Mesh, surfaces: Mesh[], buildings: readonly BuildingRecord[]): { area: number; overshoot: number; undershoot: number } {
  const pos = sidewalk.positions;
  if (!sidewalk.indices.length) return { area: 0, overshoot: 0, undershoot: 0 };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]!); maxX = Math.max(maxX, pos[i]!);
    minZ = Math.min(minZ, pos[i + 2]!); maxZ = Math.max(maxZ, pos[i + 2]!);
  }
  const pad = GAP_MAX + DEEP + 2;
  const x0 = Math.floor((minX - pad) / FIT_CELL), z0 = Math.floor((minZ - pad) / FIT_CELL);
  const nx = Math.ceil((maxX + pad) / FIT_CELL) - x0 + 1, nz = Math.ceil((maxZ + pad) / FIT_CELL) - z0 + 1;
  const grid = new Uint8Array(nx * nz);

  /** Sets `bit` on every cell whose centre lies in the triangle (a, b, c) (x/z). */
  const raster = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, bit: number) => {
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) / FIT_CELL - 0.5) - x0), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) / FIT_CELL - 0.5) - x0);
    const k0 = Math.max(0, Math.ceil(Math.min(az, bz, cz) / FIT_CELL - 0.5) - z0), k1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz) / FIT_CELL - 0.5) - z0);
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < 1e-12) return;
    for (let i = i0; i <= i1; i++) {
      const x = (i + x0 + 0.5) * FIT_CELL;
      for (let k = k0; k <= k1; k++) {
        const z = (k + z0 + 0.5) * FIT_CELL;
        const d1 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
        const d2 = (cx - bx) * (z - bz) - (cz - bz) * (x - bx);
        const d3 = (ax - cx) * (z - cz) - (az - cz) * (x - cx);
        if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) grid[i * nz + k]! |= bit;
      }
    }
  };
  const rasterMesh = (m: Mesh, bit: number) => {
    const p = m.positions, ix = m.indices;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]! * 3, b = ix[t + 1]! * 3, c = ix[t + 2]! * 3;
      raster(p[a]!, p[a + 2]!, p[b]!, p[b + 2]!, p[c]!, p[c + 2]!, bit);
    }
  };
  rasterMesh(sidewalk, SIDEWALK);
  for (const m of surfaces) rasterMesh(m, SURFACE);
  for (const b of buildings) {
    const fp = b.footprint;
    if (fp.maxX < minX - pad || fp.minX > maxX + pad || fp.maxZ < minZ - pad || fp.minZ > maxZ + pad) continue;
    const t = fp.tris;
    for (let i = 0; i < t.length; i += 6) raster(t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!, BUILDING);
  }

  const at = (i: number, k: number) => (i >= 0 && i < nx && k >= 0 && k < nz ? grid[i * nz + k]! : 0);
  const deep = Math.round(DEEP / FIT_CELL), steps = Math.round(GAP_MAX / FIT_CELL);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  let side = 0, over = 0, under = 0;
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < nz; k++) {
      const v = grid[i * nz + k]!;
      if (!(v & SIDEWALK)) continue;
      side++;
      if (v & BUILDING && dirs.every(([dx, dz]) => at(i + dx * deep, k + dz * deep) & BUILDING)) over++;
      // from the sidewalk's edge, walk out over open ground; a facade within reach makes that walk a gap
      for (const [dx, dz] of dirs) {
        let n = 1;
        while (n <= steps && !(at(i + dx * n, k + dz * n) & (SIDEWALK | SURFACE | BUILDING))) n++;
        if (n === 1 || n > steps || !(at(i + dx * n, k + dz * n) & BUILDING)) continue;
        for (let m = 1; m < n; m++) {
          const c = (i + dx * m) * nz + k + dz * m;
          if (!(grid[c]! & GAP)) { grid[c]! |= GAP; under++; }
        }
      }
    }
  }
  const a = FIT_CELL * FIT_CELL;
  return { area: side * a, overshoot: over * a, undershoot: under * a };
}
