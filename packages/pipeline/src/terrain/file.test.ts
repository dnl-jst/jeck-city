import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { commitVersion, DEFAULT_MAX_WINDOW_CELLS, TerrainFile, writeTerrainFile } from './file.js';
import { SparseRaster } from './sparse.js';
import { randomGrid, rng } from './testgrid.test-util.js';

const bytesOf = (path: string) => new Uint8Array(readFileSync(path));
const u8 = (b: ArrayBuffer) => new Uint8Array(b);

let dir: string;
const open: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-terrain-'));
});
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});
const keep = (f: TerrainFile) => (open.push(f), f);

function writeGrid(t: TerrainGrid, name = 'a.bin'): TerrainFile {
  return keep(writeTerrainFile(join(dir, name), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols))));
}
function fileFromBytes(b: ArrayBuffer, name: string, blocks?: number): TerrainFile {
  const path = join(dir, name);
  writeFileSync(path, u8(b));
  return keep(TerrainFile.open(path, blocks === undefined ? undefined : { blocks }));
}

describe('TerrainFile', () => {
  const grid = randomGrid(300, 270, 1);

  it('a file written by writeTerrainFile is byte-identical to encodeTerrain of the same grid', () => {
    const f = writeGrid(grid);
    expect(bytesOf(f.path)).toEqual(u8(encodeTerrain(grid)));
    expect([f.x0, f.z0, f.cols, f.rows, f.datum]).toEqual([grid.x0, grid.z0, grid.cols, grid.rows, grid.datum]);
    expect(f.base).toBe(new DataView(encodeTerrain(grid)).getFloat64(36, true));
    // the rows callback is called twice per row, in order
    const calls: number[] = [];
    keep(writeTerrainFile(join(dir, 'b.bin'), grid, (r, out) => (calls.push(r), out.set(grid.heights.subarray(r * 300, (r + 1) * 300)))));
    expect(calls).toEqual([...Array.from({ length: 270 }, (_, r) => r), ...Array.from({ length: 270 }, (_, r) => r)]);
    // an empty grid, like encodeTerrain
    const empty: TerrainGrid = { x0: 1, z0: 2, cols: 0, rows: 0, datum: 3, heights: new Float32Array(0) };
    const e = keep(writeTerrainFile(join(dir, 'e.bin'), empty, () => {}));
    expect(bytesOf(e.path)).toEqual(u8(encodeTerrain(empty)));
  });

  it('writeTerrainFile refuses what encodeTerrain refuses, and leaves nothing behind', () => {
    const bad = { ...grid, heights: grid.heights.slice() };
    bad.heights[5000] = NaN;
    expect(() => encodeTerrain(bad)).toThrow('terrain: non-finite height');
    expect(() => writeGrid(bad, 'nan.bin')).toThrow('terrain: non-finite height');
    const wide = { ...grid, heights: grid.heights.slice() };
    wide.heights[7000] = 2000;
    expect(() => encodeTerrain(wide)).toThrow('terrain: height span exceeds 655.35 m');
    expect(() => writeGrid(wide, 'wide.bin')).toThrow('terrain: height span exceeds 655.35 m');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('get, window and windowAt return exactly decodeTerrain(bytes).heights for every cell', () => {
    const bytes = encodeTerrain(grid);
    const ref = decodeTerrain(bytes);
    const f = fileFromBytes(bytes, 'g.bin');
    for (let r = 0; r < ref.rows; r++)
      for (let c = 0; c < ref.cols; c++) if (f.get(c, r) !== ref.heights[r * ref.cols + c]) throw new Error(`get(${c}, ${r})`);
    const w = f.window(0, 0, ref.cols - 1, ref.rows - 1);
    expect(w).toEqual(ref);
    const part = f.window(250, 100, 280, 263);
    expect([part.x0, part.z0, part.cols, part.rows, part.datum]).toEqual([ref.x0 + 250, ref.z0 + 100, 31, 164, ref.datum]);
    for (let r = 0; r < part.rows; r++)
      for (let c = 0; c < part.cols; c++) expect(part.heights[r * part.cols + c]).toBe(ref.heights[(r + 100) * ref.cols + c + 250]);
    // windowAt: the cells under the rect plus the margin (cells c with x0 + c in [floor(minX), floor(maxX) + 1])
    const wa = f.windowAt({ minX: ref.x0 + 10.5, minZ: ref.z0 + 20, maxX: ref.x0 + 40.2, maxZ: ref.z0 + 60 }, 2);
    expect([wa.x0, wa.z0, wa.cols, wa.rows]).toEqual([ref.x0 + 8, ref.z0 + 18, 43 - 8 + 1, 63 - 18 + 1]);
    for (let r = 0; r < wa.rows; r++)
      for (let c = 0; c < wa.cols; c++) expect(wa.heights[r * wa.cols + c]).toBe(ref.heights[(r + 18) * ref.cols + c + 8]);
  });

  it('window clips at the grid and keeps x0/z0 integer-aligned', () => {
    const f = writeGrid(grid);
    const ref = decodeTerrain(encodeTerrain(grid));
    const w = f.window(-50, -3, 20, 10);
    expect([w.x0, w.z0, w.cols, w.rows]).toEqual([grid.x0, grid.z0, 21, 11]);
    const e = f.window(290, 260, 1000, 1000);
    expect([e.x0, e.z0, e.cols, e.rows]).toEqual([grid.x0 + 290, grid.z0 + 260, 10, 10]);
    expect(e.heights[99]).toBe(ref.heights[ref.heights.length - 1]);
    const wa = f.windowAt({ minX: -1e6, minZ: -1e6, maxX: 1e6, maxZ: 1e6 }, 5);
    expect(wa).toEqual(ref);
    const near = f.windowAt({ minX: grid.x0 + 3.7, minZ: grid.z0 + 4.2, maxX: grid.x0 + 3.9, maxZ: grid.z0 + 4.3 }, 0);
    expect([near.x0 - grid.x0, near.z0 - grid.z0, near.cols, near.rows]).toEqual([3, 4, 2, 2]);
    expect(() => f.window(400, 0, 500, 10)).toThrow(/outside/);
    expect(() => f.window(0.5, 0, 10, 10)).toThrow(/integer/);
  });

  it('a window larger than maxWindowCells is refused with its size; windowBounds gives the clipped cells without reading', () => {
    const f = writeGrid(grid);
    expect(f.maxWindowCells).toBe(DEFAULT_MAX_WINDOW_CELLS);
    expect(DEFAULT_MAX_WINDOW_CELLS).toBe(4_000_000);
    const small = keep(TerrainFile.open(f.path, { maxWindowCells: 100 * 50 }));
    expect(small.window(0, 0, 99, 49).cols).toBe(100); // exactly at the limit
    expect(() => small.window(0, 0, 100, 49)).toThrow(/window of 101 × 50 = 5050 cells exceeds the limit of 5000 cells/);
    expect(() => small.windowAt({ minX: -1e6, minZ: -1e6, maxX: 1e6, maxZ: 1e6 }, 0)).toThrow(/300 × 270 = 81000 cells exceeds/);
    // the bounds windowAt would read, clipped to the grid
    expect(small.windowBounds({ minX: -1e6, minZ: -1e6, maxX: 1e6, maxZ: 1e6 }, 0)).toEqual({ c0: 0, r0: 0, c1: 299, r1: 269 });
    expect(small.windowBounds({ minX: grid.x0 + 3.7, minZ: grid.z0 + 4.2, maxX: grid.x0 + 3.9, maxZ: grid.z0 + 4.3 }, 1)).toEqual({ c0: 2, r0: 3, c1: 5, r1: 6 });
    expect(() => TerrainFile.open(f.path, { maxWindowCells: 0 })).toThrow(/bad maxWindowCells/);
    // the next version keeps the limit
    expect(commitVersion(small, null, null, join(dir, 'next.bin')).maxWindowCells).toBe(5000);
  });

  it('min, max and borderMin equal the reductions over the decoded grid', () => {
    const f = writeGrid(grid);
    const ref = decodeTerrain(encodeTerrain(grid));
    let min = Infinity, max = -Infinity, border = Infinity;
    for (const h of ref.heights) { min = Math.min(min, h); max = Math.max(max, h); }
    const h = (c: number, r: number) => ref.heights[r * ref.cols + c]!;
    for (let c = 0; c < ref.cols; c++) border = Math.min(border, h(c, 0), h(c, ref.rows - 1));
    for (let r = 0; r < ref.rows; r++) border = Math.min(border, h(0, r), h(ref.cols - 1, r));
    expect(f.min()).toBe(min);
    expect(f.max()).toBe(max);
    expect(f.borderMin()).toBe(border);
    expect(f.borderMin()).toBeGreaterThan(min); // the test grid's minimum is inside
    expect(f.contentHash()).toBe(createHash('sha256').update(bytesOf(f.path)).digest('hex'));
  });

  it('commitVersion without edits is byte-identical to encodeTerrain(decodeTerrain(prev))', () => {
    const f = writeGrid(grid);
    const next = keep(commitVersion(f, null, null, join(dir, 'next.bin')));
    expect(bytesOf(next.path)).toEqual(u8(encodeTerrain(decodeTerrain(encodeTerrain(grid)))));
  });

  it('commitVersion with edits equals: decode, assign the edited Float32 values, encodeTerrain — also when an edit lowers the global minimum', () => {
    const f = writeGrid(grid);
    for (const lowest of [false, true]) {
      const edits = new SparseRaster(grid.cols, grid.rows, (n) => new Float32Array(n), NaN);
      const mask = new SparseRaster(grid.cols, grid.rows, (n) => new Uint8Array(n), 0);
      const ref = decodeTerrain(encodeTerrain(grid));
      const rand = rng(lowest ? 3 : 2);
      const edit = (c: number, r: number, v: number) => {
        edits.set(c, r, v);
        mask.set(c, r, 1);
        ref.heights[r * ref.cols + c] = v;
      };
      for (let i = 0; i < 2000; i++) edit(Math.floor(rand() * grid.cols), Math.floor(rand() * grid.rows), 50 + 0.123456 * i);
      for (const [c, r] of [[255, 255], [256, 256], [299, 269], [0, 0]] as const) edit(c, r, 77.777);
      if (lowest) edit(17, 260, -60.4321);
      // an edits value without its mask bit is not an edit
      edits.set(1, 1, 99);
      const next = keep(commitVersion(f, edits, mask, join(dir, `next-${lowest}.bin`)));
      expect(bytesOf(next.path)).toEqual(u8(encodeTerrain(ref)));
      if (lowest) expect(next.base).toBe(Math.floor(Math.fround(-60.4321) * 100) / 100);
    }
  });

  it('commitVersion refuses edits without a mask and a mask without edits', () => {
    const f = writeGrid(grid);
    const edits = new SparseRaster(grid.cols, grid.rows, (n) => new Float32Array(n), NaN);
    const mask = new SparseRaster(grid.cols, grid.rows, (n) => new Uint8Array(n), 0);
    expect(() => commitVersion(f, edits, null, join(dir, 'x.bin'))).toThrow();
    expect(() => commitVersion(f, null, mask, join(dir, 'x.bin'))).toThrow();
    const small = new SparseRaster(10, 10, (n) => new Uint8Array(n), 0);
    expect(() => commitVersion(f, edits, small, join(dir, 'x.bin'))).toThrow(/size/);
  });

  it('reads work with a cache of 1 block (every access evicts)', () => {
    const bytes = encodeTerrain(grid);
    const ref = decodeTerrain(bytes);
    const f = fileFromBytes(bytes, 'one.bin', 1);
    const rand = rng(9);
    for (let i = 0; i < 5000; i++) {
      const c = Math.floor(rand() * ref.cols), r = Math.floor(rand() * ref.rows);
      expect(f.get(c, r)).toBe(ref.heights[r * ref.cols + c]);
    }
    // alternate between the four blocks
    for (let i = 0; i < 200; i++) {
      const c = i % 2 ? 10 : 290, r = i % 3 ? 20 : 265;
      expect(f.get(c, r)).toBe(ref.heights[r * ref.cols + c]);
    }
  });

  it('a truncated file or a wrong magic is refused on open with the path in the message', () => {
    const bytes = u8(encodeTerrain(grid));
    const short = join(dir, 'short.bin');
    writeFileSync(short, bytes.subarray(0, bytes.length - 1));
    expect(() => TerrainFile.open(short)).toThrow(short);
    const tiny = join(dir, 'tiny.bin');
    writeFileSync(tiny, bytes.subarray(0, 20));
    expect(() => TerrainFile.open(tiny)).toThrow(tiny);
    const magic = join(dir, 'magic.bin');
    const wrong = bytes.slice();
    wrong[3] = 0x32; // 'NNT2'
    writeFileSync(magic, wrong);
    expect(() => TerrainFile.open(magic)).toThrow(magic);
    expect(() => TerrainFile.open(magic)).toThrow(/magic/);
    expect(() => TerrainFile.open(join(dir, 'missing.bin'))).toThrow(join(dir, 'missing.bin'));
  });

  it('commitVersion writes atomically: no file at the target path if it throws midway', () => {
    const f = writeGrid(grid);
    const edits = new SparseRaster(grid.cols, grid.rows, (n) => new Float32Array(n), NaN);
    const mask = new SparseRaster(grid.cols, grid.rows, (n) => new Uint8Array(n), 0);
    // passes the minimum pass, fails while writing (span) in the last row
    edits.set(150, 269, 1000);
    mask.set(150, 269, 1);
    const target = join(dir, 'next.bin');
    expect(() => commitVersion(f, edits, mask, target)).toThrow('terrain: height span exceeds 655.35 m');
    expect(readdirSync(dir)).toEqual(['a.bin']);
    // an existing file at the target stays as it was
    writeFileSync(target, 'old');
    expect(() => commitVersion(f, edits, mask, target)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('old');
    edits.set(150, 269, NaN);
    expect(() => commitVersion(f, edits, mask, target)).toThrow('terrain: non-finite height');
    expect(readdirSync(dir).sort()).toEqual(['a.bin', 'next.bin']);
  });

  it('close releases the file; reads after close are refused', () => {
    const f = TerrainFile.open(writeGrid(grid).path);
    f.close();
    expect(() => f.get(0, 0)).toThrow(/closed/);
    f.close(); // idempotent
  });
});
