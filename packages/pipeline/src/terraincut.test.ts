import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import { commitVersion, TerrainFile, writeTerrainFile } from './terrain/file.js';
import { SparseRaster } from './terrain/sparse.js';
import { randomGrid, rng } from './terrain/testgrid.js';
import { CUT_MARGIN, FILL_SLOPE, noEdits, terrainCutEdits, terrainFillEdits, type Edits } from './terraincut.js';
import { applyTerrainCuts, applyTerrainFills } from './terraincut.dense.test-util.js';

let dir: string;
const opened: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-cut-'));
});
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The grid as a terrain file (quantised as terrain.bin), and the dense grid that file decodes to. */
function fileOf(t: TerrainGrid): { file: TerrainFile; dense: TerrainGrid } {
  const file = writeTerrainFile(join(dir, `t${opened.length}.bin`), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  opened.push(file);
  return { file, dense: decodeTerrain(encodeTerrain(t)) };
}
let commits = 0;
function commit(prev: TerrainFile, e: Edits): TerrainFile {
  const f = commitVersion(prev, e.edits, e.edited, join(dir, `c${commits++}.bin`));
  opened.push(f);
  return f;
}
const bytes = (f: TerrainFile) => readFileSync(f.path);
const encoded = (t: TerrainGrid) => Buffer.from(encodeTerrain(t));
/** The decoded heights with the edits applied (test only: a dense copy). */
function applied(file: TerrainFile, e: Edits): TerrainGrid {
  const b = bytes(file);
  const t = decodeTerrain(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) if (e.edited.get(c, r)) t.heights[r * t.cols + c] = e.edits.get(c, r);
  return t;
}

const flat = (h: number): TerrainGrid => ({ x0: 0, z0: 0, cols: 12, rows: 12, datum: 0, heights: new Float32Array(144).fill(h) });
const at = (t: TerrainGrid, x: number, z: number) => t.heights[z * t.cols + x]!;
// a 4 m × 4 m cut (x 4..8, z 4..8) as two triangles; a ramp falling from y 1.0 at x 4 to y 0.2 at x 8
const ramp = Float32Array.from([4, 1.0, 4, 8, 0.2, 4, 8, 0.2, 8, 4, 1.0, 4, 8, 0.2, 8, 4, 1.0, 8]);

test('terrain under a cut ends just below it; within 1 m outside it takes the nearest edge; beyond it is untouched', () => {
  const { file } = fileOf(flat(2.0));
  const e = noEdits(file.cols, file.rows);
  const n = terrainCutEdits(file, e, ramp);
  const t = applied(file, e);
  expect(at(t, 4, 6)).toBeCloseTo(1.0 - CUT_MARGIN, 5);
  expect(at(t, 6, 6)).toBeCloseTo(0.6 - CUT_MARGIN, 5);
  expect(at(t, 8, 6)).toBeCloseTo(0.2 - CUT_MARGIN, 5);
  expect(at(t, 9, 6)).toBeCloseTo(0.2 - CUT_MARGIN, 5); // 1 m east of the low edge
  expect(at(t, 3, 6)).toBeCloseTo(1.0 - CUT_MARGIN, 5); // 1 m west of the high edge
  expect(at(t, 10, 6)).toBe(2.0);
  expect(at(t, 6, 2)).toBe(2.0);
  expect(n).toBe(7 * 7 - 4); // x 3..9 × z 3..9 without the four corners (√2 m from the cut)
});

test('a cut never raises the terrain', () => {
  const { file } = fileOf(flat(0.0));
  const e = noEdits(file.cols, file.rows);
  expect(terrainCutEdits(file, e, ramp)).toBe(0);
  expect([...e.edited.pages()]).toEqual([]);
});

test('a fill raises the terrain to its surface, with a skirt sloping down outside; never lowers, keeps flagged points', () => {
  const big = (h: number): TerrainGrid => ({ x0: 0, z0: 0, cols: 40, rows: 40, datum: 0, heights: new Float32Array(1600).fill(h) });
  // a level 4 m × 4 m fill at y 3 (x 10..14, z 10..14)
  const pad = Float32Array.from([10, 3, 10, 14, 3, 10, 14, 3, 14, 10, 3, 10, 14, 3, 14, 10, 3, 14]);
  const { file } = fileOf(big(0));
  const keep = new SparseRaster(40, 40, (n) => new Uint8Array(n), 0);
  keep.set(13, 12, 1);
  const e = terrainFillEdits(file, pad, keep);
  expect(e.raised).toBeGreaterThan(0);
  const t = applied(file, e);
  expect(at(t, 12, 12)).toBeCloseTo(3, 5);
  expect(at(t, 13, 12)).toBe(0); // kept
  expect(at(t, 16, 12)).toBeCloseTo(3 - 2 * FILL_SLOPE, 5); // 2 m outside
  expect(at(t, 30, 12)).toBe(0); // beyond the skirt
  const high = fileOf(big(5)).file;
  expect(terrainFillEdits(high, pad, new SparseRaster(40, 40, (n) => new Uint8Array(n), 0)).raised).toBe(0);
});

/** n random triangles over the grid (some reaching beyond it), y around `y0` ± `dy`; a few duplicated at another height. */
function randomTris(t: TerrainGrid, n: number, seed: number, y0: number, dy: number, size = 30): Float32Array {
  const rand = rng(seed);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const cx = t.x0 - 10 + rand() * (t.cols + 20), cz = t.z0 - 10 + rand() * (t.rows + 20);
    const tri: number[] = [];
    for (let v = 0; v < 3; v++) tri.push(cx + (rand() - 0.5) * size, y0 + (rand() - 0.5) * 2 * dy, cz + (rand() - 0.5) * size);
    out.push(...tri);
    // the same triangle again, lower or higher: covered points tie in distance (0), the lowest (or highest) wins
    if (k % 4 === 0) out.push(...tri.map((v, i) => (i % 3 === 1 ? v + (rand() - 0.5) * 20 : v)));
  }
  return Float32Array.from(out);
}

describe('cuts and fills as sparse edits equal the dense functions', () => {
  it('the cut targets are stored as Float32 like the dense version: a target just below the terrain in float64 but equal in Float32 changes nothing', () => {
    // flat at 1.01 (decoded Float32(1.01)); a level triangle at the Float32 y whose y − CUT_MARGIN lies, in float64,
    // just below that height, yet rounds to it as a Float32 – a Float64 store would lower every point under the cut
    const { file, dense } = fileOf(flat(1.01));
    const h = dense.heights[0]!, y = 1.059999942779541;
    expect(Math.fround(y)).toBe(y);
    expect(y - CUT_MARGIN).toBeLessThan(h);
    expect(Math.fround(y - CUT_MARGIN)).toBe(h);
    const tri = Float32Array.from([4, y, 4, 8, y, 4, 4, y, 8]);
    expect(applyTerrainCuts(dense, tri)).toBe(0);
    const e = noEdits(file.cols, file.rows);
    expect(terrainCutEdits(file, e, tri)).toBe(0);
    expect(bytes(commit(file, e)).equals(encoded(dense))).toBe(true);
  });

  it('terrainCutEdits + commitVersion gives the bytes of: applyTerrainCuts on the decoded grid, then encodeTerrain', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { file, dense } = fileOf(randomGrid(180 + 13 * seed, 150 + 7 * seed, seed, seed % 2 ? -1234.5 : 300, 567));
      const tris = randomTris(dense, 25, seed, 120, 60);
      const e = noEdits(file.cols, file.rows);
      const n = terrainCutEdits(file, e, tris);
      expect(n).toBe(applyTerrainCuts(dense, tris));
      expect(n).toBeGreaterThan(0);
      expect(bytes(commit(file, e)).equals(encoded(dense))).toBe(true);
    }
  });

  it('two overlapping models: same result and same counts as two dense calls in that order', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { file, dense } = fileOf(randomGrid(200, 170, 50 + seed));
      // model B overlaps A and reaches both lower and higher
      const a = randomTris(dense, 20, 100 + seed, 120, 50, 60), b = randomTris(dense, 20, 200 + seed, 110, 70, 60);
      const e = noEdits(file.cols, file.rows);
      const na = terrainCutEdits(file, e, a), nb = terrainCutEdits(file, e, b);
      expect(na).toBe(applyTerrainCuts(dense, a));
      expect(nb).toBe(applyTerrainCuts(dense, b));
      expect(nb).toBeGreaterThan(0);
      expect(bytes(commit(file, e)).equals(encoded(dense))).toBe(true);
    }
  });

  it('terrainFillEdits + commitVersion equals applyTerrainFills(…, keep) + encodeTerrain, with a keep mask', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { file, dense } = fileOf(randomGrid(190, 160, 300 + seed, -55.5, -20));
      const tris = randomTris(dense, 15, 400 + seed, 140, 60);
      const rand = rng(500 + seed);
      const keep = new SparseRaster(file.cols, file.rows, (n) => new Uint8Array(n), 0);
      const keepDense = new Uint8Array(file.cols * file.rows);
      for (let r = 0; r < file.rows; r++)
        for (let c = 0; c < file.cols; c++)
          if (Math.hypot(c - 90, r - 80) < 50 && rand() < 0.8) {
            keep.set(c, r, 1);
            keepDense[r * file.cols + c] = 1;
          }
      const e = terrainFillEdits(file, tris, keep);
      expect(e.raised).toBe(applyTerrainFills(dense, tris, keepDense));
      expect(e.raised).toBeGreaterThan(0);
      expect(bytes(commit(file, e)).equals(encoded(dense))).toBe(true);
    }
  });

  it('cuts reaching over the grid edge and over page borders', () => {
    // 300 × 270 cells: page borders at column and row 256; the triangles straddle them and every edge of the grid
    const { file, dense } = fileOf(randomGrid(300, 270, 7, 1000, -2000));
    const T = (pts: [number, number, number][]) => pts.flatMap(([c, y, r]) => [1000 + c, y, -2000 + r]);
    const cut = Float32Array.from([
      ...T([[250, 60, 240], [262, 90, 250], [252, 75, 262]]), // over both page borders
      ...T([[-5, 50, 100], [3, 50, 110], [-5, 50, 120]]), // over the west edge
      ...T([[290, 40, 265], [305, 40, 268], [295, 40, 275]]), // over the south-east corner
      ...T([[100, 30, -3], [140, 30, -3], [120, 30, 4]]), // over the north edge
      ...T([[255.5, 20, 100], [256.5, 20, 100], [256, 20, 140]]), // along the page border
    ]);
    const e = noEdits(file.cols, file.rows);
    const n = terrainCutEdits(file, e, cut);
    expect(n).toBe(applyTerrainCuts(dense, cut));
    expect(e.edited.get(0, 110)).toBe(1);
    expect(e.edited.get(299, 269)).toBe(1);
    expect(e.edited.get(256, 256)).toBe(1);
    expect(e.edited.get(255, 120) + e.edited.get(256, 120)).toBe(2);
    const { file: f2, dense: d2 } = fileOf(randomGrid(300, 270, 7, 1000, -2000));
    const fill = Float32Array.from(cut.map((v, i) => (i % 3 === 1 ? v + 250 : v)));
    const keep = new SparseRaster(f2.cols, f2.rows, (k) => new Uint8Array(k), 0);
    const ef = terrainFillEdits(f2, fill, keep);
    expect(ef.raised).toBe(applyTerrainFills(d2, fill));
    expect(bytes(commit(file, e)).equals(encoded(dense))).toBe(true);
    expect(bytes(commit(f2, ef)).equals(encoded(d2))).toBe(true);
  });

  it('refuses edits or a keep mask of another size', () => {
    const { file } = fileOf(flat(1));
    expect(() => terrainCutEdits(file, noEdits(13, 12), ramp)).toThrow(/12 × 12/);
    expect(() => terrainFillEdits(file, ramp, new SparseRaster(12, 11, (n) => new Uint8Array(n), 0))).toThrow(/12 × 12/);
  });
});
