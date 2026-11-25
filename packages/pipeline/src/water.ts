import { CHUNK_SIZE } from '@nn/shared';
import type { Pt } from './osm.js';
import type { Mesh } from './streets.js';
import type { BuildingRecord } from './buildingstore.js';
import { footprintContains } from './footprint.js';
import type { TerrainFile } from './terrain/file.js';
import { PAGE, SparseRaster } from './terrain/sparse.js';

/**
 * The river surface in DGM1 is the water level (bridges and ships removed), a band that is flat to a few decimetres and
 * several metres below the banks. A grid point is water if it can be reached from the river's centre line over points
 * no higher than the local water level + LEVEL_TOL.
 */
export const LEVEL_TOL = 0.5;
/** Radius (m) around a centre line sample whose median height is the local water level. */
const LEVEL_RADIUS = 15;
/** Centre line sample spacing (m) for the water level. */
const LEVEL_STEP = 10;
/** The river bed: this far below the water level in the middle, sloping down from the shore at BED_SLOPE. */
export const WATER_DEPTH = 3;
const BED_SLOPE = 0.5;
/** The bed right at the shore lies at least this far below the water surface. */
const SHORE_DEPTH = 0.4;
/** The water surface mesh reaches this many grid points beyond the water (hidden under the banks). */
const SURFACE_DILATE = 3;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** The water of a terrain version, on sparse rasters of its size (no array of grid size). */
export type Water = {
  /** Per grid point: 1 = water (fill 0). */
  mask: SparseRaster<Uint8Array>;
  /** Water level (local y) per grid point; NaN (the fill) where the point is neither water nor in its dilated surface. */
  level: SparseRaster<Float32Array>;
  /** Mean water level over all water points (local y), -Infinity without water. */
  meanLevel: number;
  /** Number of water points. */
  area: number;
};

/** Throws unless the water's rasters have the grid's size (`what`: the function asking, for the message). */
function checkSize(what: string, grid: { cols: number; rows: number }, w: Water): void {
  for (const s of [w.mask, w.level])
    if (s.cols !== grid.cols || s.rows !== grid.rows) throw new Error(`${what}: water of ${s.cols} × ${s.rows} on a terrain of ${grid.cols} × ${grid.rows}`);
}

/** Neighbour order of the flood and the dilation: +x, −x, +z, −z. */
const DC = [1, -1, 0, 0] as const;
const DR = [0, 0, 1, -1] as const;

/** A growing FIFO list of cells (c, r), kept as two Uint32Arrays (no flat index: cols·rows may exceed 2^31). */
class Cells {
  c = new Uint32Array(1024);
  r = new Uint32Array(1024);
  length = 0;
  push(c: number, r: number): void {
    if (this.length === this.c.length) {
      const nc = new Uint32Array(this.length * 2), nr = new Uint32Array(this.length * 2);
      nc.set(this.c);
      nr.set(this.r);
      this.c = nc;
      this.r = nr;
    }
    this.c[this.length] = c;
    this.r[this.length++] = r;
  }
}

/**
 * Decoded heights of a terrain file, read page by page (PAGE × PAGE, page-aligned windows) on first use and kept until
 * this object is dropped. The flood's breadth-first front runs along the whole river at once, so an LRU block cache
 * of fixed size would be re-read on every round; only pages the flood touches are ever read.
 */
class HeightPages {
  private readonly pageCols: number;
  private readonly pages: (Float32Array | undefined)[];
  private readonly widths: number[];
  private lastKey = -1;
  private last: Float32Array | null = null;
  private lastW = 0;

  constructor(private readonly t: TerrainFile) {
    this.pageCols = Math.ceil(t.cols / PAGE);
    this.pages = new Array<Float32Array | undefined>(this.pageCols * Math.ceil(t.rows / PAGE));
    this.widths = new Array<number>(this.pages.length).fill(0);
  }

  /** Height of cell (c, r); the caller keeps (c, r) inside the grid. */
  get(c: number, r: number): number {
    const pc = Math.floor(c / PAGE), pr = Math.floor(r / PAGE);
    const key = pr * this.pageCols + pc;
    if (key !== this.lastKey) {
      let p = this.pages[key];
      if (p === undefined) {
        const w = this.t.window(pc * PAGE, pr * PAGE, Math.min(this.t.cols, pc * PAGE + PAGE) - 1, Math.min(this.t.rows, pr * PAGE + PAGE) - 1);
        p = this.pages[key] = w.heights;
        this.widths[key] = w.cols;
      }
      this.lastKey = key;
      this.last = p;
      this.lastW = this.widths[key]!;
    }
    return this.last![(r - pr * PAGE) * this.lastW + (c - pc * PAGE)]!;
  }
}

/**
 * Water points of the terrain: flood fill from the river centre lines (see LEVEL_TOL), breadth-first, every point
 * taking the level of the point it was reached from; then the level is spread SURFACE_DILATE points under the banks.
 */
export function findWater(t: TerrainFile, rivers: Pt[][]): Water {
  const { cols, rows } = t;
  const mask = new SparseRaster(cols, rows, (n) => new Uint8Array(n), 0);
  const level = new SparseRaster(cols, rows, (n) => new Float32Array(n), NaN);
  const h = new HeightPages(t);
  const inGrid = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  const queue = new Cells();
  for (const line of rivers) {
    // 1 m samples along the line are the seeds; every LEVEL_STEP-th one measures the level the next ones take
    const pts: Pt[] = [];
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!, b = line[i]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)));
      for (let k = 0; k < steps; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps });
    }
    let lvl = NaN;
    pts.forEach((p, k) => {
      const c0 = Math.round(p.x - t.x0), r0 = Math.round(p.z - t.z0);
      if (k % LEVEL_STEP === 0) {
        const hs: number[] = [];
        for (let dz = -LEVEL_RADIUS; dz <= LEVEL_RADIUS; dz++) {
          for (let dx = -LEVEL_RADIUS; dx <= LEVEL_RADIUS; dx++) {
            if (dx * dx + dz * dz <= LEVEL_RADIUS * LEVEL_RADIUS && inGrid(c0 + dx, r0 + dz)) hs.push(h.get(c0 + dx, r0 + dz));
          }
        }
        lvl = hs.length >= 50 ? median(hs) : NaN;
      }
      if (Number.isNaN(lvl) || !inGrid(c0, r0)) return;
      if (mask.get(c0, r0) || h.get(c0, r0) > lvl + LEVEL_TOL) return;
      mask.set(c0, r0, 1);
      level.set(c0, r0, lvl);
      queue.push(c0, r0);
    });
  }
  // breadth-first in queue order: every point takes the level of the point it was reached from
  for (let q = 0; q < queue.length; q++) {
    const c = queue.c[q]!, r = queue.r[q]!;
    const lvl = level.get(c, r);
    for (let k = 0; k < 4; k++) {
      const cc = c + DC[k]!, rr = r + DR[k]!;
      if (!inGrid(cc, rr)) continue;
      if (mask.get(cc, rr) || h.get(cc, rr) > lvl + LEVEL_TOL) continue;
      mask.set(cc, rr, 1);
      level.set(cc, rr, lvl);
      queue.push(cc, rr);
    }
  }
  let sum = 0;
  for (let q = 0; q < queue.length; q++) sum += level.get(queue.c[q]!, queue.r[q]!);
  // the surface mesh reaches a little under the banks, at the level of the water it borders on
  let front = queue;
  for (let k = 0; k < SURFACE_DILATE; k++) {
    const next = new Cells();
    for (let q = 0; q < front.length; q++) {
      const c = front.c[q]!, r = front.r[q]!;
      for (let n = 0; n < 4; n++) {
        const cc = c + DC[n]!, rr = r + DR[n]!;
        if (!inGrid(cc, rr)) continue;
        if (!Number.isNaN(level.get(cc, rr))) continue;
        level.set(cc, rr, level.get(c, r));
        next.push(cc, rr);
      }
    }
    front = next;
  }
  return { mask, level, meanLevel: queue.length ? sum / queue.length : -Infinity, area: queue.length };
}

/**
 * The river bed under the water: SHORE_DEPTH below the water level at the shore, sloping at BED_SLOPE to WATER_DEPTH
 * (distance to the shore: chamfer distance (1, √2) to the nearest non-water point; the grid's edge is not shore).
 * Returns the bed as edits (Float32 heights where `edited` is 1) for commitVersion, where it lies below the terrain,
 * and the number of those lowered points. The chamfer sweeps visit the water cells in row-major order forwards, then
 * backwards; non-water cells have distance 0 and are skipped, so only pages with water are visited.
 */
export function carveRiverBed(t: TerrainFile, w: Water): { edits: SparseRaster<Float32Array>; edited: SparseRaster<Uint8Array>; lowered: number } {
  const { cols, rows } = t;
  checkSize('carveRiverBed', t, w);
  const pageCols = Math.ceil(cols / PAGE), pageRows = Math.ceil(rows / PAGE);
  // distance pages exactly where the mask has pages; a missing page reads 0 (no water)
  const dist: DistPages = new Array<Float32Array | undefined>(pageCols * pageRows);
  for (const [pc, pr, m] of w.mask.pages()) {
    const p = new Float32Array(PAGE * PAGE);
    for (let i = 0; i < p.length; i++) if (m[i]) p[i] = Infinity;
    dist[pr * pageCols + pc] = p;
  }
  chamferForward(dist, pageCols, cols, rows);
  chamferBackward(dist, pageCols, cols, rows);
  const edits = new SparseRaster(cols, rows, (n) => new Float32Array(n), 0);
  const edited = new SparseRaster(cols, rows, (n) => new Uint8Array(n), 0);
  let lowered = 0;
  for (const [pc, pr, m] of w.mask.pages()) {
    const p = dist[pr * pageCols + pc]!;
    const lv = w.level.page(pc, pr)!; // every water point has a level
    const c0 = pc * PAGE, r0 = pr * PAGE;
    const win = t.window(c0, r0, Math.min(cols, c0 + PAGE) - 1, Math.min(rows, r0 + PAGE) - 1);
    let e: Float32Array | undefined, em: Uint8Array | undefined;
    for (let y = 0; y < win.rows; y++)
      for (let x = 0; x < win.cols; x++) {
        const i = y * PAGE + x;
        if (!m[i]) continue;
        const depth = Math.min(WATER_DEPTH, Math.max(SHORE_DEPTH, p[i]! * BED_SLOPE));
        const bed = lv[i]! - depth;
        if (bed < win.heights[y * win.cols + x]!) {
          if (!e || !em) {
            // the first edit in this page allocates it
            edits.set(c0 + x, r0 + y, bed);
            edited.set(c0 + x, r0 + y, 1);
            e = edits.page(pc, pr)!;
            em = edited.page(pc, pr)!;
          }
          e[i] = bed;
          em[i] = 1;
          lowered++;
        }
      }
  }
  return { edits, edited, lowered };
}

/** Distance pages by page index (pr * pageCols + pc); a missing page reads 0. */
type DistPages = (Float32Array | undefined)[];

function distAt(dist: DistPages, pageCols: number, c: number, r: number): number {
  const p = dist[Math.floor(r / PAGE) * pageCols + Math.floor(c / PAGE)];
  return p === undefined ? 0 : p[(r % PAGE) * PAGE + (c % PAGE)]!;
}

/** The forward chamfer sweep of carveRiverBed (row-major), over the water cells only. */
function chamferForward(dist: DistPages, pageCols: number, cols: number, rows: number): void {
  const D = Math.SQRT2;
  const at = (c: number, r: number) => distAt(dist, pageCols, c, r);
  for (let r = 0; r < rows; r++) {
    const pr = Math.floor(r / PAGE), off = (r % PAGE) * PAGE;
    for (let pc = 0; pc < pageCols; pc++) {
      const p = dist[pr * pageCols + pc];
      if (p === undefined) continue;
      const cEnd = Math.min(cols, pc * PAGE + PAGE);
      for (let c = pc * PAGE; c < cEnd; c++) {
        const i = off + (c - pc * PAGE);
        if (!p[i]) continue;
        let v = p[i]!;
        const x = c - pc * PAGE;
        if (x > 0 && x < PAGE - 1 && off > 0 && c < cols - 1) {
          // all neighbours in this page (the dense guards c > 0, r > 0, c < cols − 1 hold)
          v = Math.min(v, p[i - 1]! + 1);
          v = Math.min(v, p[i - PAGE]! + 1);
          v = Math.min(v, p[i - PAGE - 1]! + D);
          v = Math.min(v, p[i - PAGE + 1]! + D);
        } else {
          if (c > 0) v = Math.min(v, at(c - 1, r) + 1);
          if (r > 0) {
            v = Math.min(v, at(c, r - 1) + 1);
            if (c > 0) v = Math.min(v, at(c - 1, r - 1) + D);
            if (c < cols - 1) v = Math.min(v, at(c + 1, r - 1) + D);
          }
        }
        p[i] = v;
      }
    }
  }
}

/** The backward chamfer sweep of carveRiverBed (reverse row-major), over the water cells only. */
function chamferBackward(dist: DistPages, pageCols: number, cols: number, rows: number): void {
  const D = Math.SQRT2;
  const at = (c: number, r: number) => distAt(dist, pageCols, c, r);
  for (let r = rows - 1; r >= 0; r--) {
    const pr = Math.floor(r / PAGE), off = (r % PAGE) * PAGE;
    for (let pc = pageCols - 1; pc >= 0; pc--) {
      const p = dist[pr * pageCols + pc];
      if (p === undefined) continue;
      const cEnd = Math.min(cols, pc * PAGE + PAGE);
      for (let c = cEnd - 1; c >= pc * PAGE; c--) {
        const i = off + (c - pc * PAGE);
        if (!p[i]) continue;
        let v = p[i]!;
        const x = c - pc * PAGE;
        if (x > 0 && x < PAGE - 1 && off < (PAGE - 1) * PAGE && c < cols - 1 && r < rows - 1) {
          // all neighbours in this page (the dense guards c < cols − 1, r < rows − 1, c > 0 hold)
          v = Math.min(v, p[i + 1]! + 1);
          v = Math.min(v, p[i + PAGE]! + 1);
          v = Math.min(v, p[i + PAGE + 1]! + D);
          v = Math.min(v, p[i + PAGE - 1]! + D);
        } else {
          if (c < cols - 1) v = Math.min(v, at(c + 1, r) + 1);
          if (r < rows - 1) {
            v = Math.min(v, at(c, r + 1) + 1);
            if (c < cols - 1) v = Math.min(v, at(c + 1, r + 1) + D);
            if (c > 0) v = Math.min(v, at(c - 1, r + 1) + D);
          }
        }
        p[i] = v;
      }
    }
  }
}

/**
 * The water surface: per grid row, one quad per run of points with a level (water and its dilated rim), cut at chunk
 * edges so that every quad lands in the chunk it covers; y = the run's mean level. uv = world x/z. Rows of pages
 * without a level are skipped.
 */
export function waterSurface(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water): Mesh {
  checkSize('waterSurface', grid, w);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (x0: number, x1: number, z0: number, z1: number, y: number) => {
    const b = pos.length / 3;
    pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
    uv.push(x0, z0, x0, z1, x1, z1, x1, z0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3); // counter-clockwise seen from above
  };
  const run = (r: number, start: number, end: number, sum: number) => {
    // a run of points at 1 m spacing covers [first − ½, last + ½]; split at chunk edges
    const z = grid.z0 + r, y = sum / (end - start);
    let x0 = grid.x0 + start - 0.5;
    const xEnd = grid.x0 + end - 0.5;
    while (x0 < xEnd) {
      const x1 = Math.min(xEnd, Math.floor(x0 / CHUNK_SIZE) * CHUNK_SIZE + CHUNK_SIZE);
      quad(x0, x1, z - 0.5, z + 0.5, y);
      x0 = x1;
    }
  };
  const { level } = w;
  for (let pr = 0; pr < level.pageRows; pr++) {
    let any = false;
    for (let pc = 0; pc < level.pageCols && !any; pc++) any = level.page(pc, pr) !== undefined;
    if (!any) continue;
    const rEnd = Math.min(grid.rows, pr * PAGE + PAGE);
    for (let r = pr * PAGE; r < rEnd; r++) {
      const off = (r % PAGE) * PAGE;
      let start = -1, sum = 0;
      for (let pc = 0; pc < level.pageCols; pc++) {
        const p = level.page(pc, pr);
        const c0 = pc * PAGE, cEnd = Math.min(grid.cols, c0 + PAGE);
        if (p === undefined) {
          if (start >= 0) run(r, start, c0, sum);
          start = -1;
          continue;
        }
        for (let c = c0; c < cEnd; c++) {
          const v = p[off + c - c0]!;
          if (Number.isNaN(v)) {
            if (start >= 0) run(r, start, c, sum);
            start = -1;
          } else {
            if (start < 0) {
              start = c;
              sum = 0;
            }
            sum += v;
          }
        }
      }
      if (start >= 0) run(r, start, grid.cols, sum);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from(uv) };
}

/**
 * Outlines of the water for the map: the mask on a CELL × CELL m raster (a cell is water if its centre point is),
 * traced along cell edges with the water always on the same side (outer rings and holes wind in opposite directions:
 * a nonzero fill of all rings together leaves the holes open), then simplified (Douglas-Peucker, `tolerance` m).
 */
export function waterOutlines(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water, cell = 4, tolerance = 2): Pt[][] {
  checkSize('waterOutlines', grid, w);
  return outlines(grid, (gc, gr) => w.mask.get(gc, gr) === 1, cell, tolerance);
}

/**
 * Share of a building's footprint over the water (footprint sampled every `step` m; 0 for a building without water
 * under its bounding box). LoD2 models the Rhine bridges as solid blocks from the water up to the deck.
 */
export function waterShare(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water, b: BuildingRecord, step = 2): number {
  checkSize('waterShare', grid, w);
  const fp = b.footprint;
  let inside = 0, wet = 0;
  for (let z = fp.minZ + step / 2; z < fp.maxZ; z += step) {
    for (let x = fp.minX + step / 2; x < fp.maxX; x += step) {
      if (!footprintContains(b, x, z)) continue;
      inside++;
      const c = Math.round(x - grid.x0), r = Math.round(z - grid.z0);
      if (c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && w.mask.get(c, r)) wet++;
    }
  }
  return inside ? wet / inside : 0;
}

/** waterOutlines for any mask: `isWater(c, r)` tells whether grid point (c, r) is water. */
function outlines(t: { x0: number; z0: number; cols: number; rows: number }, isWater: (c: number, r: number) => boolean, cell: number,
  tolerance: number): Pt[][] {
  const cols = Math.ceil(t.cols / cell), rows = Math.ceil(t.rows / cell);
  const wet = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return false;
    const gc = Math.min(t.cols - 1, c * cell + (cell >> 1)), gr = Math.min(t.rows - 1, r * cell + (cell >> 1));
    return isWater(gc, gr);
  };
  // directed boundary edges between raster corners (corner (i, j) at x0 + i·cell − ½, z0 + j·cell − ½)
  const next = new Map<number, number[]>();
  const key = (i: number, j: number) => j * (cols + 1) + i;
  const edge = (a: number, b: number) => next.set(a, [...(next.get(a) ?? []), b]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!wet(c, r)) continue;
      // seen from above (x right, z down the screen) water on the left of each edge
      if (!wet(c, r - 1)) edge(key(c + 1, r), key(c, r)); // north edge, westwards
      if (!wet(c - 1, r)) edge(key(c, r), key(c, r + 1)); // west edge, southwards
      if (!wet(c, r + 1)) edge(key(c, r + 1), key(c + 1, r + 1)); // south edge, eastwards
      if (!wet(c + 1, r)) edge(key(c + 1, r + 1), key(c + 1, r)); // east edge, northwards
    }
  }
  const rings: Pt[][] = [];
  const pt = (k: number): Pt => ({ x: t.x0 + (k % (cols + 1)) * cell - 0.5, z: t.z0 + Math.floor(k / (cols + 1)) * cell - 0.5 });
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const ring: Pt[] = [pt(start)];
      let at = start;
      for (;;) {
        const outs = next.get(at)!;
        const to = outs.pop()!;
        if (!outs.length) next.delete(at);
        if (to === start) break;
        ring.push(pt(to));
        at = to;
        if (!next.has(at)) break; // broken ring (cannot happen for a closed mask)
      }
      if (ring.length >= 4) rings.push(simplifyRing(ring, tolerance));
    }
  }
  return rings.filter((r) => r.length >= 3);
}

function simplifyRing(ring: Pt[], tol: number): Pt[] {
  // split at the point farthest from the first, simplify both halves
  let far = 0, fd = -1;
  ring.forEach((p, i) => {
    const d = Math.hypot(p.x - ring[0]!.x, p.z - ring[0]!.z);
    if (d > fd) { fd = d; far = i; }
  });
  const a = dp(ring.slice(0, far + 1), tol), b = dp([...ring.slice(far), ring[0]!], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 2) return pts;
  const a = pts[0]!, b = pts[pts.length - 1]!;
  const ex = b.x - a.x, ez = b.z - a.z, len = Math.hypot(ex, ez) || 1;
  let idx = 0, md = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i]!.x - a.x) * ez - (pts[i]!.z - a.z) * ex) / len;
    if (d > md) { md = d; idx = i; }
  }
  if (md <= tol) return [a, b];
  return [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)];
}
