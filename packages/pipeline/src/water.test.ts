import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_SIZE, decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { centreLine, riverTerrain } from './riverfixture.js';
import { boxRecord } from './fixture.js';
import type { BuildingRecord } from './buildingstore.js';
import type { Pt } from './osm.js';
import { TerrainFile, writeTerrainFile } from './terrain/file.js';
import { PAGE, type SparseRaster } from './terrain/sparse.js';
import { rng } from './terrain/testgrid.js';
import {
  carveRiverBed, carveRiverBedSparse, findWater, findWaterSparse, LEVEL_TOL, WATER_DEPTH, waterOutlines, waterOutlinesSparse,
  waterShare, waterShareSparse, waterSurface, waterSurfaceSparse, type SparseWater, type Water,
} from './water.js';

test('findWater floods the river from its centre line and stops at the banks', () => {
  const t = riverTerrain();
  const w = findWater(t, [centreLine]);
  const at = (x: number, z: number) => w.mask[z * t.cols + x];
  expect(at(200, 150)).toBe(1);
  expect(at(150, 10)).toBe(1);
  expect(at(250, 290)).toBe(1);
  expect(at(140, 150)).toBe(0); // 6 m up the bank
  expect(at(20, 150)).toBe(0); // the low meadow is not connected
  expect(Math.abs(w.meanLevel)).toBeLessThan(LEVEL_TOL);
  // the surface reaches a few metres under the banks
  expect(Number.isNaN(w.level[150 * t.cols + 148]!)).toBe(false);
  expect(Number.isNaN(w.level[150 * t.cols + 140]!)).toBe(true);
});

test('carveRiverBed lowers only the water, deepest in the middle', () => {
  const t = riverTerrain();
  const before = Float32Array.from(t.heights);
  const w = findWater(t, [centreLine]);
  expect(carveRiverBed(t, w)).toBeGreaterThan(0);
  const i = (x: number, z: number) => z * t.cols + x;
  expect(t.heights[i(200, 150)]).toBeCloseTo(w.level[i(200, 150)]! - WATER_DEPTH, 5);
  expect(t.heights[i(151, 150)]!).toBeLessThan(w.level[i(151, 150)]!);
  expect(t.heights[i(151, 150)]!).toBeGreaterThan(t.heights[i(200, 150)]!);
  expect(t.heights[i(140, 150)]).toBe(before[i(140, 150)]);
});

test('waterSurface covers the water with quads cut at chunk edges', () => {
  const t = riverTerrain();
  const w = findWater(t, [centreLine]);
  const m = waterSurface(t, w);
  expect(m.indices.length % 6).toBe(0);
  let area = 0;
  for (let q = 0; q < m.positions.length / 12; q++) {
    const xs = [0, 1, 2, 3].map((k) => m.positions[q * 12 + k * 3]!);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    // no quad crosses a chunk edge
    expect(Math.floor(x0 / CHUNK_SIZE)).toBe(Math.floor((x1 - 1e-6) / CHUNK_SIZE));
    area += x1 - x0;
    // wound counter-clockwise seen from above: normal +y
    const p = (k: number) => [m.positions[m.indices[q * 6 + k]! * 3]!, m.positions[m.indices[q * 6 + k]! * 3 + 2]!];
    const [a, b, c] = [p(0), p(1), p(2)] as [number[], number[], number[]];
    expect((b[1]! - a[1]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[1]! - a[1]!)).toBeGreaterThan(0);
  }
  const water = w.mask.reduce((n, v) => n + v, 0);
  expect(area).toBeGreaterThan(water);
  expect(area).toBeLessThan(water * 1.1);
});

test('waterOutlines traces the water as rings whose signed areas add up to the water area', () => {
  const t = riverTerrain();
  const w = findWater(t, [centreLine]);
  const rings = waterOutlines(t, w);
  expect(rings.length).toBeGreaterThan(0);
  let area = 0;
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!;
    area += (a.x * b.z - b.x * a.z) / 2;
  }
  const water = w.mask.reduce((n, v) => n + v, 0);
  expect(Math.abs(Math.abs(area) - water) / water).toBeLessThan(0.05);
  for (const r of rings) for (const p of r) expect(p.x).toBeGreaterThan(140);
});

test('waterShare: a block across the river is mostly over the water, a house on the bank not at all', () => {
  const t = riverTerrain();
  const w = findWater(t, [centreLine]);
  expect(waterShare(t, w, boxRecord('bridge', 140, 140, 260, 160, 10))).toBeGreaterThan(0.8);
  expect(waterShare(t, w, boxRecord('house', 60, 60, 80, 80, 10))).toBe(0);
});

// ---- the sparse versions against the dense ones (same decoded terrain) ----

let dir: string;
const opened: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-water-'));
});
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The terrain as a file and as the dense grid the file decodes to. */
function fileOf(t: TerrainGrid): { file: TerrainFile; dense: TerrainGrid } {
  const file = writeTerrainFile(join(dir, `t${opened.length}.bin`), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  opened.push(file);
  return { file, dense: decodeTerrain(encodeTerrain(t)) };
}

/** A dense copy of a sparse raster (test only): pages copied, the fill elsewhere. */
function dense<A extends Float32Array | Uint8Array>(s: SparseRaster<A>, make: (n: number) => A, fill: number): A {
  const out = make(s.cols * s.rows);
  out.fill(fill);
  for (const [pc, pr, p] of s.pages())
    for (let y = 0; y < PAGE && pr * PAGE + y < s.rows; y++) {
      const n = Math.min(PAGE, s.cols - pc * PAGE);
      out.set(p.subarray(y * PAGE, y * PAGE + n), (pr * PAGE + y) * s.cols + pc * PAGE);
    }
  return out;
}
const f32 = (n: number) => new Float32Array(n), u8 = (n: number) => new Uint8Array(n);
/** Number of cells whose bit patterns differ. */
function bitDiff(a: Float32Array | Uint8Array, b: Float32Array | Uint8Array): number {
  const x = a instanceof Float32Array ? new Uint32Array(a.buffer, a.byteOffset, a.length) : a;
  const y = b instanceof Float32Array ? new Uint32Array(b.buffer, b.byteOffset, b.length) : b;
  expect(x.length).toBe(y.length);
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
  return n;
}

/** Finds water both ways and checks mask, level (bit for bit) and meanLevel; returns both. */
function sameWater(t: TerrainGrid, rivers: Pt[][]) {
  const { file, dense: grid } = fileOf(t);
  const d = findWater(grid, rivers);
  const s = findWaterSparse(file, rivers);
  expect(bitDiff(dense(s.mask, u8, 0), d.mask)).toBe(0);
  expect(bitDiff(dense(s.level, f32, NaN), d.level)).toBe(0);
  expect(Object.is(s.meanLevel, d.meanLevel)).toBe(true);
  expect(s.area).toBe(d.mask.reduce((n, v) => n + v, 0));
  return { file, dense: grid, d, s };
}

/** carveRiverBed both ways: the sparse edits applied to the decoded heights give the dense result bit for bit. */
function sameBed(file: TerrainFile, grid: TerrainGrid, d: Water, s: SparseWater) {
  const after = Float32Array.from(grid.heights);
  const n = carveRiverBed(grid, d);
  const e = carveRiverBedSparse(file, s);
  expect(e.lowered).toBe(n);
  const m = dense(e.edited, u8, 0), v = dense(e.edits, f32, 0), mask = dense(s.mask, u8, 0);
  let edited = 0, outside = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    edited++;
    if (!mask[i]) outside++;
    after[i] = v[i]!;
  }
  expect(bitDiff(after, grid.heights)).toBe(0);
  expect(outside).toBe(0);
  expect(edited).toBe(n);
  return { n, e };
}

function sameRest(dense: TerrainGrid, d: Water, s: SparseWater, buildings: BuildingRecord[]) {
  const ms = waterSurfaceSparse(dense, s), md = waterSurface(dense, d);
  expect(ms.positions).toEqual(md.positions);
  expect(ms.indices).toEqual(md.indices);
  expect(ms.uv).toEqual(md.uv);
  expect(waterOutlinesSparse(dense, s)).toEqual(waterOutlines(dense, d));
  expect(waterOutlinesSparse(dense, s, 3, 1)).toEqual(waterOutlines(dense, d, 3, 1));
  for (const b of buildings) {
    expect(waterShareSparse(dense, s, b)).toBe(waterShare(dense, d, b));
    expect(waterShareSparse(dense, s, b, 1)).toBe(waterShare(dense, d, b, 1));
  }
}

/** Flat basins at `floor` (±0.2 noise) between smooth hills; heights in cell order from seed. */
function basinTerrain(cols: number, rows: number, seed: number, x0 = 0, z0 = 0): TerrainGrid {
  const rand = rng(seed);
  const a = 20 + 60 * rand(), b = 20 + 60 * rand(), pa = 7 * rand(), pb = 7 * rand(), floor = 2 * rand() - 1;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = Math.max(floor, 8 * Math.sin(c / a + pa) * Math.cos(r / b + pb)) + 0.4 * rand() - 0.2;
  return { x0, z0, cols, rows, datum: 40, heights };
}

describe('the water on sparse rasters equals the dense version', () => {
  it('findWater: mask, level (bit for bit, NaN where none) and meanLevel equal the dense version on the river fixture', () => {
    const { s } = sameWater(riverTerrain(), [centreLine]);
    expect(s.area).toBeGreaterThan(0);
  });

  it('findWater: … on a river that crosses page borders and reaches the grid edge', () => {
    // a 40 m wide channel at y = 0 along a diagonal from the grid's west edge across both page borders to its south edge
    const cols = 600, rows = 520, x0 = -300, z0 = 1000;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const dist = Math.abs(c - r * 1.1) / Math.hypot(1, 1.1);
        heights[r * cols + c] = dist < 20 ? 0.15 * Math.sin(c * 0.7 + r * 1.3) : Math.min(5, (dist - 20) * 0.5);
      }
    const { s, file, dense, d } = sameWater({ x0, z0, cols, rows, datum: 40, heights }, [[{ x: x0 - 20, z: z0 - 18 }, { x: x0 + 600, z: z0 + 545 }]]);
    expect(s.mask.get(0, 0)).toBe(1);
    expect(s.mask.get(570, 519)).toBe(1);
    expect(s.mask.has(300, 280)).toBe(true);
    expect(s.mask.has(550, 5)).toBe(false); // no page without water
    sameBed(file, dense, d, s);
    sameRest(dense, d, s, [boxRecord('a', x0 + 240, z0 + 220, x0 + 290, z0 + 270, 10)]);
  });

  it('findWater: two rivers with different levels meeting — the same points take the same level', () => {
    // a basin at y = 0 in the west, one at y = 1.2 in the east, joined by a channel that rises from 0 to 1.2
    const cols = 500, rows = 300;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const inChannel = r > 130 && r < 170;
        const y = c < 200 ? 0 : c > 300 ? 1.2 : ((c - 200) / 100) * 1.2;
        heights[r * cols + c] = (c < 200 || c > 300) && r > 40 && r < 260 ? y + 0.1 * Math.sin(c + r) : inChannel ? y : 8;
      }
    const t: TerrainGrid = { x0: 0, z0: 0, cols, rows, datum: 40, heights };
    const { s, file, dense, d } = sameWater(t, [[{ x: 100, z: 50 }, { x: 100, z: 250 }], [{ x: 400, z: 250 }, { x: 400, z: 50 }]]);
    expect(Math.abs(s.level.get(100, 150))).toBeLessThan(0.2);
    expect(Math.abs(s.level.get(400, 150) - 1.2)).toBeLessThan(0.2);
    sameBed(file, dense, d, s);
    sameRest(dense, d, s, []);
  });

  it('carveRiverBed: the edits equal the heights the dense version changes, and `lowered` equals its count', () => {
    const { file, dense, d, s } = sameWater(riverTerrain(), [centreLine]);
    const { n } = sameBed(file, dense, d, s);
    expect(n).toBeGreaterThan(0);
  });

  it('carveRiverBed: a lake wider than one page (distance > 256 cells from the shore)', () => {
    const cols = 1200, rows = 1100, cx = 600, cy = 560;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const rad = Math.hypot(c - cx, r - cy);
        heights[r * cols + c] = rad < 530 ? 0.1 * Math.sin(c * 0.3) * Math.cos(r * 0.2) : 4;
      }
    const { file, dense, d, s } = sameWater({ x0: 0, z0: 0, cols, rows, datum: 40, heights }, [[{ x: 100, z: 560 }, { x: 1100, z: 560 }]]);
    const { e } = sameBed(file, dense, d, s);
    // in the middle the bed lies WATER_DEPTH below the water: the distance there exceeds a page
    expect(e.edits.get(cx, cy)).toBeCloseTo(s.level.get(cx, cy) - WATER_DEPTH, 5);
  });

  it('waterSurface / waterOutlines / waterShare equal the dense versions', () => {
    const { dense, d, s } = sameWater(riverTerrain(), [centreLine]);
    sameRest(dense, d, s, [boxRecord('bridge', 140, 140, 260, 160, 10), boxRecord('house', 60, 60, 80, 80, 10), boxRecord('bank', 245, 10, 262, 30, 5)]);
  });

  it('no water: empty rasters, meanLevel -Infinity, area 0, no edits', () => {
    for (const rivers of [[], [[{ x: 20, z: -100 }, { x: 20, z: -40 }]]]) {
      const { file, dense, d, s } = sameWater(riverTerrain(), rivers);
      expect(s.meanLevel).toBe(-Infinity);
      expect(s.area).toBe(0);
      expect([...s.mask.pages()]).toEqual([]);
      expect([...s.level.pages()]).toEqual([]);
      const { e } = sameBed(file, dense, d, s);
      expect(e.lowered).toBe(0);
      expect([...e.edits.pages()]).toEqual([]);
      expect([...e.edited.pages()]).toEqual([]);
      expect(waterSurfaceSparse(dense, s).positions.length).toBe(0);
      expect(waterOutlinesSparse(dense, s)).toEqual([]);
    }
  });

  it('property test: 40 random terrains with random river lines, 600 × 520 cells', () => {
    let wet = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(1000 + seed);
      const x0 = Math.round(rand() * 2000 - 1000) + (seed % 3 === 0 ? 0.5 : 0), z0 = Math.round(rand() * 2000 - 1000);
      const t = basinTerrain(600, 520, seed, x0, z0);
      const rivers: Pt[][] = [];
      for (let k = 1 + Math.floor(rand() * 3); k > 0; k--) {
        const line: Pt[] = [];
        for (let m = 2 + Math.floor(rand() * 4); m > 0; m--) line.push({ x: x0 - 50 + rand() * 700, z: z0 - 50 + rand() * 620 });
        rivers.push(line);
      }
      const { file, dense, d, s } = sameWater(t, rivers);
      wet += s.area > 0 ? 1 : 0;
      sameBed(file, dense, d, s);
      const fp = () => {
        const bx = x0 + rand() * 560, bz = z0 + rand() * 480;
        return boxRecord(`b${seed}`, bx, bz, bx + 5 + rand() * 40, bz + 5 + rand() * 40, 10);
      };
      sameRest(dense, d, s, [fp(), fp(), fp()]);
    }
    expect(wet).toBeGreaterThan(30);
  }, 60_000); // about 7 s: the dense and the sparse flood of 40 terrains, most of them largely under water
});
