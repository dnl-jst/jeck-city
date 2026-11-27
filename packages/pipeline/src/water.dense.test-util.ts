// The dense water functions as they were before the pipeline moved to sparse rasters (test only: the reference the
// sparse versions in water.ts are compared against). Copied verbatim; do not change.
import { CHUNK_SIZE, type TerrainGrid } from '@nn/shared';
import type { Pt } from './osm.js';
import type { Mesh } from './streets.js';
import type { BuildingRecord } from './buildingstore.js';
import { footprintContains } from './footprint.js';

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

export type Water = {
  /** Per grid point (TerrainGrid layout): 1 = water. */
  mask: Uint8Array;
  /** Water level (local y) per grid point; NaN where the point is neither water nor in its dilated surface. */
  level: Float32Array;
  /** Mean water level over all water points (local y), -Infinity without water. */
  meanLevel: number;
};

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** Water points of the terrain: flood fill from the river centre lines (see LEVEL_TOL). */
export function findWater(t: TerrainGrid, rivers: Pt[][]): Water {
  const n = t.cols * t.rows;
  const mask = new Uint8Array(n);
  const level = new Float32Array(n).fill(NaN);
  const inGrid = (c: number, r: number) => c >= 0 && r >= 0 && c < t.cols && r < t.rows;
  const queue: number[] = [];
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
            if (dx * dx + dz * dz <= LEVEL_RADIUS * LEVEL_RADIUS && inGrid(c0 + dx, r0 + dz)) hs.push(t.heights[(r0 + dz) * t.cols + c0 + dx]!);
          }
        }
        lvl = hs.length >= 50 ? median(hs) : NaN;
      }
      if (Number.isNaN(lvl) || !inGrid(c0, r0)) return;
      const i0 = r0 * t.cols + c0;
      if (mask[i0] || t.heights[i0]! > lvl + LEVEL_TOL) return;
      mask[i0] = 1;
      level[i0] = lvl;
      queue.push(i0);
    });
  }
  // breadth-first: every point takes the level of the seed it was reached from
  for (let q = 0; q < queue.length; q++) {
    const i0 = queue[q]!;
    const c = i0 % t.cols, r = (i0 - c) / t.cols;
    const lvl = level[i0]!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (!inGrid(c + dc, r + dr)) continue;
      const j = (r + dr) * t.cols + c + dc;
      if (mask[j] || t.heights[j]! > lvl + LEVEL_TOL) continue;
      mask[j] = 1;
      level[j] = lvl;
      queue.push(j);
    }
  }
  let sum = 0;
  for (const i0 of queue) sum += level[i0]!;
  // the surface mesh reaches a little under the banks, at the level of the water it borders on
  let front = queue;
  for (let k = 0; k < SURFACE_DILATE; k++) {
    const next: number[] = [];
    for (const i0 of front) {
      const c = i0 % t.cols, r = (i0 - c) / t.cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (!inGrid(c + dc, r + dr)) continue;
        const j = (r + dr) * t.cols + c + dc;
        if (!Number.isNaN(level[j]!)) continue;
        level[j] = level[i0]!;
        next.push(j);
      }
    }
    front = next;
  }
  return { mask, level, meanLevel: queue.length ? sum / queue.length : -Infinity };
}

/**
 * Lowers the terrain under the water into a river bed: SHORE_DEPTH below the water level at the shore, sloping at
 * BED_SLOPE to WATER_DEPTH. Distance to the shore: chamfer distance (1, √2) to the nearest non-water point.
 * Returns the number of lowered grid points.
 */
export function carveRiverBed(t: TerrainGrid, w: Water): number {
  const { cols, rows } = t;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = w.mask[i] ? Infinity : 0;
  const D = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!d[i]) continue;
      let v = d[i]!;
      if (c > 0) v = Math.min(v, d[i - 1]! + 1);
      if (r > 0) {
        v = Math.min(v, d[i - cols]! + 1);
        if (c > 0) v = Math.min(v, d[i - cols - 1]! + D);
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1]! + D);
      }
      d[i] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!d[i]) continue;
      let v = d[i]!;
      if (c < cols - 1) v = Math.min(v, d[i + 1]! + 1);
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols]! + 1);
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1]! + D);
        if (c > 0) v = Math.min(v, d[i + cols - 1]! + D);
      }
      d[i] = v;
    }
  }
  let n = 0;
  for (let i = 0; i < d.length; i++) {
    if (!w.mask[i]) continue;
    const depth = Math.min(WATER_DEPTH, Math.max(SHORE_DEPTH, d[i]! * BED_SLOPE));
    const bed = w.level[i]! - depth;
    if (bed < t.heights[i]!) {
      t.heights[i] = bed;
      n++;
    }
  }
  return n;
}

/**
 * The water surface: per grid row, one quad per run of points with a level (water and its dilated rim), cut at chunk
 * edges so that every quad lands in the chunk it covers; y = the run's mean level. uv = world x/z.
 */
export function waterSurface(t: TerrainGrid, w: Water): Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const quad = (x0: number, x1: number, z0: number, z1: number, y: number) => {
    const b = pos.length / 3;
    pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
    uv.push(x0, z0, x0, z1, x1, z1, x1, z0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3); // counter-clockwise seen from above
  };
  for (let r = 0; r < t.rows; r++) {
    let c = 0;
    while (c < t.cols) {
      if (Number.isNaN(w.level[r * t.cols + c]!)) { c++; continue; }
      const start = c;
      let sum = 0;
      while (c < t.cols && !Number.isNaN(w.level[r * t.cols + c]!)) sum += w.level[r * t.cols + c++]!;
      // a run of points at 1 m spacing covers [first − ½, last + ½]; split at chunk edges
      const z = t.z0 + r, y = sum / (c - start);
      let x0 = t.x0 + start - 0.5;
      const end = t.x0 + c - 0.5;
      while (x0 < end) {
        const x1 = Math.min(end, Math.floor(x0 / CHUNK_SIZE) * CHUNK_SIZE + CHUNK_SIZE);
        quad(x0, x1, z - 0.5, z + 0.5, y);
        x0 = x1;
      }
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), uv: Float32Array.from(uv) };
}

/**
 * Outlines of the water for the map: the mask on a CELL × CELL m raster (a cell is water if its centre point is),
 * traced along cell edges with the water always on the same side (outer rings and holes wind in opposite directions:
 * a nonzero fill of all rings together leaves the holes open), then simplified (Douglas-Peucker, `tolerance` m).
 */
export function waterOutlines(t: TerrainGrid, w: Water, cell = 4, tolerance = 2): Pt[][] {
  return outlines(t, (gc, gr) => w.mask[gr * t.cols + gc] === 1, cell, tolerance);
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

/**
 * Share of a building's footprint over the water (footprint sampled every `step` m; 0 for a building without water
 * under its bounding box). LoD2 models the Rhine bridges as solid blocks from the water up to the deck.
 */
export function waterShare(t: TerrainGrid, w: Water, b: BuildingRecord, step = 2): number {
  const fp = b.footprint;
  let inside = 0, wet = 0;
  for (let z = fp.minZ + step / 2; z < fp.maxZ; z += step) {
    for (let x = fp.minX + step / 2; x < fp.maxX; x += step) {
      if (!footprintContains(b, x, z)) continue;
      inside++;
      const c = Math.round(x - t.x0), r = Math.round(z - t.z0);
      if (c >= 0 && r >= 0 && c < t.cols && r < t.rows && w.mask[r * t.cols + c]) wet++;
    }
  }
  return inside ? wet / inside : 0;
}

