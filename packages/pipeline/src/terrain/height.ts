import { heightAt as sharedHeightAt, type TerrainGrid } from '@nn/shared';
import { BLOCK, TerrainFile, windowInfo, type WindowInfo } from './file.js';

/** Where heights come from: a grid (the whole world, or a window of a TerrainFile) or point queries on a file. */
export type Heights = TerrainGrid | TerrainSampler;

/** The lattice of a terrain: origin and size of the WHOLE grid (a TerrainFile and a whole TerrainGrid are frames). */
export type GridFrame = { x0: number; z0: number; cols: number; rows: number; datum: number };

/**
 * The whole grid's frame behind `h`: the file of a sampler or of a window made by TerrainFile, else the grid itself.
 * Lattice arithmetic on positions (cell of a point, grid lines) must use this, never a window's own x0/z0: x − x0
 * rounds differently for a different origin.
 */
export function gridFrame(h: Heights): GridFrame {
  if (h instanceof TerrainSampler) return h.file;
  return windowInfo(h)?.file ?? h;
}

/** Point queries on a TerrainFile through its block cache; `fast`, a window of the same file, is tried first. */
export class TerrainSampler {
  /** @internal */
  readonly fastInfo: WindowInfo | null;

  constructor(readonly file: TerrainFile, fast?: TerrainGrid) {
    const info = fast ? windowInfo(fast) : undefined;
    if (fast && (!info || info.file !== file)) throw new Error(`terrain sampler: the fast window is not a window of ${file.path}`);
    this.fastInfo = info ?? null;
  }
}

/**
 * Same value as @nn/shared heightAt on the whole decoded grid – for a grid, a window or a sampler.
 * A plain TerrainGrid goes to @nn/shared heightAt as it is (it clamps to that grid). A window returned by
 * TerrainFile.window/windowAt and a sampler give the whole grid's value at any position, inside or outside the
 * window: the position is clamped and the cell chosen relative to the whole grid, then the cell is interpolated by
 * @nn/shared heightAt on the window or the cache block that holds it, in cell-index coordinates. (Calling @nn/shared
 * heightAt on a window in world coordinates could differ in the last bit: x − window.x0 rounds differently from
 * x − grid.x0.) Both subtractions u − c0 below are exact, so the interpolation sees the same fractions.
 */
export function heightAt(h: Heights, x: number, z: number): number {
  if (h instanceof TerrainSampler) return fileHeight(h.file, h.fastInfo, x, z);
  const info = windowInfo(h);
  return info ? fileHeight(info.file, info, x, z) : sharedHeightAt(h, x, z);
}

function fileHeight(file: TerrainFile, fast: WindowInfo | null, x: number, z: number): number {
  const { cols, rows } = file;
  // clamping and cell choice exactly as @nn/shared heightAt does them on the whole grid
  const u = Math.min(Math.max(x - file.x0, 0), cols - 1);
  const v = Math.min(Math.max(z - file.z0, 0), rows - 1);
  if (!(u >= 0 && v >= 0)) return NaN; // a NaN position or an empty grid, where @nn/shared gives NaN too
  const c = Math.min(Math.floor(u), Math.max(cols - 2, 0));
  const r = Math.min(Math.floor(v), Math.max(rows - 2, 0));
  if (fast && c >= fast.c0 && r >= fast.r0 && Math.min(c + 1, cols - 1) <= fast.c1 && Math.min(r + 1, rows - 1) <= fast.r1)
    return sharedHeightAt(fast.view, u, v);
  // block (c / 256, r / 256) holds cells c..c+1 and r..r+1 (it shares a row and column with its neighbours)
  return sharedHeightAt(file.block(Math.floor(c / BLOCK), Math.floor(r / BLOCK)), u, v);
}
