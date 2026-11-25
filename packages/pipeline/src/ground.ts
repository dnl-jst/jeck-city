import { CHUNK_SIZE, TERRAIN_DIAGONAL, type TerrainGrid } from '@nn/shared';
import type { Mesh } from './streets.js';
import { type TerrainFile, windowInfo } from './terrain/file.js';
import type { GridFrame } from './terrain/height.js';

export type GroundMesh = Mesh & { normals: Float32Array };

/** Tolerance for grid points that lie on a chunk edge up to float error. */
const EPS = 1e-6;
/** Cells a chunk window reaches beyond the chunk square (the ground's normals need one). */
export const CHUNK_MARGIN = 2;

/**
 * The window of `file` a chunk is built from: the chunk square plus CHUNK_MARGIN cells on every side, clipped to the
 * grid (throws when the square lies wholly outside it). groundMesh needs it; draping uses it as its fast path.
 */
export function chunkWindow(file: TerrainFile, ix: number, iz: number): TerrainGrid {
  const x = ix * CHUNK_SIZE, z = iz * CHUNK_SIZE;
  return file.windowAt({ minX: x, minZ: z, maxX: x + CHUNK_SIZE, maxZ: z + CHUNK_SIZE }, CHUNK_MARGIN);
}

/** The grid columns/rows chunk (ix, iz) covers (inclusive); null when it overlaps the grid in less than one cell. */
export function groundSpan(t: GridFrame, ix: number, iz: number): { c0: number; c1: number; r0: number; r1: number } | null {
  const x = ix * CHUNK_SIZE, z = iz * CHUNK_SIZE;
  const c0 = Math.max(0, Math.ceil(x - t.x0 - EPS)), c1 = Math.min(t.cols - 1, Math.floor(x + CHUNK_SIZE - t.x0 + EPS));
  const r0 = Math.max(0, Math.ceil(z - t.z0 - EPS)), r1 = Math.min(t.rows - 1, Math.floor(z + CHUNK_SIZE - t.z0 + EPS));
  return c1 <= c0 || r1 <= r0 ? null : { c0, c1, r0, r1 };
}

/**
 * Terrain surface of chunk (ix, iz): every grid point in [ix·200, ix·200+200] × [iz·200, iz·200+200] ∩ grid
 * (edge rows/columns are shared with the neighbour chunk, so there are no gaps), two triangles per 1 m cell
 * split along TERRAIN_DIAGONAL, wound counter-clockwise seen from above. uv = world x/z (metres); normals by
 * central differences over the whole grid (one-sided at its border), so they match across chunk edges.
 * null when the chunk overlaps the grid in less than one cell.
 * `t` is the whole grid or a window made by TerrainFile (chunkWindow): then span, positions and the clamping of the
 * normals' neighbours are taken in the whole grid's cells, and only the heights come from the window, which must
 * hold the span plus one cell around it (where the grid has cells).
 */
export function groundMesh(t: TerrainGrid, ix: number, iz: number): GroundMesh | null {
  const win = windowInfo(t);
  const g: GridFrame = win ? win.file : t;
  const span = groundSpan(g, ix, iz);
  if (!span) return null;
  const { c0, c1, r0, r1 } = span;
  // cell (c, r) of the whole grid is at (c − oc, r − or) in t
  const oc = win ? win.c0 : 0, or = win ? win.r0 : 0;
  if (win && (Math.max(c0 - 1, 0) < win.c0 || Math.min(c1 + 1, g.cols - 1) > win.c1 || Math.max(r0 - 1, 0) < win.r0 || Math.min(r1 + 1, g.rows - 1) > win.r1))
    throw new Error(`groundMesh: the window [${win.c0}, ${win.c1}] × [${win.r0}, ${win.r1}] does not hold chunk ${ix}_${iz} and a cell around it`);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  const H = (r: number, c: number) => t.heights[(r - or) * t.cols + (c - oc)]!;
  const positions = new Float32Array(w * h * 3), normals = new Float32Array(w * h * 3), uv = new Float32Array(w * h * 2);
  for (let j = 0; j < h; j++) {
    const r = r0 + j, rm = Math.max(r - 1, 0), rp = Math.min(r + 1, g.rows - 1);
    for (let i = 0; i < w; i++) {
      const c = c0 + i, cm = Math.max(c - 1, 0), cp = Math.min(c + 1, g.cols - 1);
      const v = j * w + i, px = g.x0 + c, pz = g.z0 + r;
      positions[v * 3] = px;
      positions[v * 3 + 1] = H(r, c);
      positions[v * 3 + 2] = pz;
      uv[v * 2] = px;
      uv[v * 2 + 1] = pz;
      const gx = cp > cm ? (H(r, cp) - H(r, cm)) / (cp - cm) : 0;
      const gz = rp > rm ? (H(rp, c) - H(rm, c)) / (rp - rm) : 0;
      const len = Math.hypot(gx, 1, gz);
      normals[v * 3] = -gx / len;
      normals[v * 3 + 1] = 1 / len;
      normals[v * 3 + 2] = -gz / len;
    }
  }
  const indices = new Uint32Array((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const v00 = j * w + i, v10 = v00 + 1, v01 = v00 + w, v11 = v01 + 1;
      if (TERRAIN_DIAGONAL === 'x0z0-x1z1') {
        indices[k++] = v00; indices[k++] = v11; indices[k++] = v10;
        indices[k++] = v00; indices[k++] = v01; indices[k++] = v11;
      } else {
        indices[k++] = v00; indices[k++] = v01; indices[k++] = v10;
        indices[k++] = v10; indices[k++] = v01; indices[k++] = v11;
      }
    }
  }
  return { positions, indices, uv, normals };
}
