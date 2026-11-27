import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { TerrainGrid } from '@nn/shared';
import type { SparseRaster } from './sparse.js';
import { PAGE } from './sparse.js';

// The layout of terrain.bin (see encodeTerrain/decodeTerrain in @nn/shared): 'NNT1', uint32 cols, rows, float64 x0,
// z0, datum, base (little-endian), then cols·rows uint16 = centimetres above `base`, row-major.
const MAGIC = 'NNT1';
const HEADER = 44;
const MAX_CM = 65535;

/** Side of a cache block in cells; a block also holds the first row and column of its neighbours (≤ 257 × 257). */
export const BLOCK = 256;
const DEFAULT_BLOCKS = 64;
/**
 * The largest window (in cells) a TerrainFile hands out unless opened with another limit: 4 million cells (16 MB of
 * Float32). The pipeline's windows are far smaller (a chunk ≈ 204², a water or edit page 256², a LoD2 tile's
 * buildings ≈ 1100²); a window of the whole grid is a programming error and must not allocate silently.
 */
export const DEFAULT_MAX_WINDOW_CELLS = 4_000_000;
/** Rows per read in the streaming passes: about 2 MB. */
const chunkRows = (cols: number) => Math.max(1, Math.floor((2 << 20) / Math.max(1, 2 * cols)));

/** decoded[cm] = Float32(base + cm / 100), the same double arithmetic as decodeTerrain. */
function decodeTable(base: number): Float32Array {
  const t = new Float32Array(MAX_CM + 1);
  for (let cm = 0; cm <= MAX_CM; cm++) t[cm] = base + cm / 100;
  return t;
}

/** What `window` records about a window it returned, for the exact height lookup in height.ts. */
export type WindowInfo = {
  file: TerrainFile;
  /** The window's cells [c0, c1] × [r0, r1] in the file's grid. */
  c0: number; r0: number; c1: number; r1: number;
  /** The same heights in cell-index coordinates (x0 = c0, z0 = r0). */
  view: TerrainGrid;
};
const windows = new WeakMap<TerrainGrid, WindowInfo>();

/** The record of a grid returned by TerrainFile.window/windowAt, or undefined for any other grid. */
export function windowInfo(t: TerrainGrid): WindowInfo | undefined {
  return windows.get(t);
}

/** One terrain version on disk, in terrain.bin's layout (NNT1), read with positional reads through a block cache. */
export class TerrainFile {
  readonly cols: number;
  readonly rows: number;
  readonly x0: number;
  readonly z0: number;
  readonly datum: number;
  readonly base: number;
  /** Blocks per row and column of blocks. */
  readonly blockCols: number;
  readonly blockRows: number;
  private fd: number | null;
  private readonly decoded: Float32Array;
  /** Cached blocks (cell-index coordinates) by br * blockCols + bc, least recently used first. */
  private readonly cache = new Map<number, TerrainGrid>();
  private lastKey = -1;
  private last: TerrainGrid | null = null;
  private stats: { min: number; max: number; borderMin: number } | null = null;
  private hash: string | null = null;
  private rowBytes: Uint8Array | null = null;

  private constructor(readonly path: string, fd: number, header: DataView, readonly blockCapacity: number, readonly maxWindowCells: number) {
    this.fd = fd;
    this.cols = header.getUint32(4, true);
    this.rows = header.getUint32(8, true);
    this.x0 = header.getFloat64(12, true);
    this.z0 = header.getFloat64(20, true);
    this.datum = header.getFloat64(28, true);
    this.base = header.getFloat64(36, true);
    this.blockCols = Math.ceil(this.cols / BLOCK);
    this.blockRows = Math.ceil(this.rows / BLOCK);
    this.decoded = decodeTable(this.base);
  }

  /**
   * Opens the file and checks its header and length; reads nothing else. Default 64 cached blocks (≈ 17 MB) and
   * windows of at most DEFAULT_MAX_WINDOW_CELLS cells.
   */
  static open(path: string, o?: { blocks?: number; maxWindowCells?: number }): TerrainFile {
    const blocks = o?.blocks ?? DEFAULT_BLOCKS;
    if (!Number.isInteger(blocks) || blocks < 1) throw new Error(`terrain file ${path}: bad block count ${blocks}`);
    const maxWindowCells = o?.maxWindowCells ?? DEFAULT_MAX_WINDOW_CELLS;
    if (!Number.isInteger(maxWindowCells) || maxWindowCells < 1) throw new Error(`terrain file ${path}: bad maxWindowCells ${maxWindowCells}`);
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (err) {
      throw new Error(`terrain file ${path}: ${(err as Error).message}`);
    }
    try {
      const size = fstatSync(fd).size;
      if (size < HEADER) throw new Error(`terrain file ${path}: truncated (${size} bytes, the header alone has ${HEADER})`);
      const head = new Uint8Array(HEADER);
      readFully(fd, head, 0, path);
      const magic = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
      if (magic !== MAGIC) throw new Error(`terrain file ${path}: bad magic ${JSON.stringify(magic)}, expected ${JSON.stringify(MAGIC)}`);
      const view = new DataView(head.buffer);
      const cols = view.getUint32(4, true), rows = view.getUint32(8, true);
      const expected = HEADER + 2 * cols * rows;
      if (size !== expected)
        throw new Error(`terrain file ${path}: ${size < expected ? 'truncated' : 'too long'} (${size} bytes, expected ${expected} for ${cols} × ${rows})`);
      return new TerrainFile(path, fd, view, blocks, maxWindowCells);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  private open(): number {
    if (this.fd === null) throw new Error(`terrain file ${this.path}: closed`);
    return this.fd;
  }

  /** Reads the cm values of cells [c0, c0 + n) of row r into bytes[0, 2n). */
  private readCells(r: number, c0: number, n: number, bytes: Uint8Array): void {
    readFully(this.open(), bytes.subarray(0, 2 * n), HEADER + 2 * (r * this.cols + c0), this.path);
  }

  /** Decoded heights of row r into out (cols values), read straight from the file (not through the cache). */
  row(r: number, out: Float32Array): void {
    if (!(r >= 0 && r < this.rows && Number.isInteger(r)) || out.length < this.cols) throw new RangeError(`terrain file ${this.path}: bad row ${r}`);
    const bytes = (this.rowBytes ??= new Uint8Array(2 * this.cols));
    this.readCells(r, 0, this.cols, bytes);
    const dec = this.decoded;
    for (let c = 0; c < this.cols; c++) out[c] = dec[bytes[2 * c]! | (bytes[2 * c + 1]! << 8)]!;
  }

  /** Decoded height of cell (c, r), as decodeTerrain gives it. */
  get(c: number, r: number): number {
    if (!(c >= 0 && c < this.cols && r >= 0 && r < this.rows && Number.isInteger(c) && Number.isInteger(r)))
      throw new RangeError(`terrain file ${this.path}: cell (${c}, ${r}) outside ${this.cols} × ${this.rows}`);
    const b = this.block(Math.floor(c / BLOCK), Math.floor(r / BLOCK));
    return b.heights[(r - b.z0) * b.cols + (c - b.x0)]!;
  }

  /**
   * Block (bc, br): cells [bc·256, bc·256 + 256] × [br·256, br·256 + 256] clipped to the grid, as a TerrainGrid in
   * cell-index coordinates (x0 = first column, z0 = first row). Do not modify it. The last used block is returned
   * without a table lookup.
   */
  block(bc: number, br: number): TerrainGrid {
    if (!(bc >= 0 && bc < this.blockCols && br >= 0 && br < this.blockRows)) throw new RangeError(`terrain file ${this.path}: block (${bc}, ${br}) outside`);
    const key = br * this.blockCols + bc;
    if (key === this.lastKey && this.last) return this.last;
    let b = this.cache.get(key);
    if (b) {
      this.cache.delete(key);
      this.cache.set(key, b);
    } else {
      b = this.readBlock(bc, br);
      if (this.cache.size >= this.blockCapacity) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, b);
    }
    this.lastKey = key;
    this.last = b;
    return b;
  }

  private readBlock(bc: number, br: number): TerrainGrid {
    const c0 = bc * BLOCK, r0 = br * BLOCK;
    const w = Math.min(BLOCK + 1, this.cols - c0), h = Math.min(BLOCK + 1, this.rows - r0);
    return { x0: c0, z0: r0, cols: w, rows: h, datum: this.datum, heights: this.readRect(c0, r0, w, h) };
  }

  /** Decoded heights of the w × h cells from (c0, r0), row-major. */
  private readRect(c0: number, r0: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    const bytes = new Uint8Array(2 * w);
    const dec = this.decoded;
    for (let y = 0; y < h; y++) {
      this.readCells(r0 + y, c0, w, bytes);
      const o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = dec[bytes[2 * x]! | (bytes[2 * x + 1]! << 8)]!;
    }
    return out;
  }

  /**
   * A real TerrainGrid for cells [c0, c1] × [r0, r1] (clipped to the grid), decoded exactly: x0 = file x0 + c0,
   * z0 = file z0 + r0, datum copied, heights a fresh Float32Array. heightAt in height.ts knows the window and gives
   * the whole grid's value for it, inside and outside the window. A window of more than maxWindowCells cells (after
   * clipping) is refused.
   */
  window(c0: number, r0: number, c1: number, r1: number): TerrainGrid {
    if (![c0, r0, c1, r1].every(Number.isInteger)) throw new Error(`terrain file ${this.path}: window bounds must be integers (${c0}, ${r0}, ${c1}, ${r1})`);
    const a = Math.max(c0, 0), b = Math.max(r0, 0), e = Math.min(c1, this.cols - 1), f = Math.min(r1, this.rows - 1);
    if (a > e || b > f) throw new Error(`terrain file ${this.path}: window [${c0}, ${c1}] × [${r0}, ${r1}] outside the ${this.cols} × ${this.rows} grid`);
    const w = e - a + 1, h = f - b + 1;
    if (w * h > this.maxWindowCells)
      throw new Error(`terrain file ${this.path}: window of ${w} × ${h} = ${w * h} cells exceeds the limit of ${this.maxWindowCells} cells (cells [${a}, ${e}] × [${b}, ${f}])`);
    const heights = this.readRect(a, b, w, h);
    const grid: TerrainGrid = { x0: this.x0 + a, z0: this.z0 + b, cols: w, rows: h, datum: this.datum, heights };
    windows.set(grid, { file: this, c0: a, r0: b, c1: e, r1: f, view: { x0: a, z0: b, cols: w, rows: h, datum: this.datum, heights } });
    return grid;
  }

  /**
   * The window over every cell a point of `rect` interpolates from (floor(min) to floor(max) + 1 relative to the
   * grid's origin), widened by `marginCells` on each side; clipped to the grid.
   */
  windowAt(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, marginCells: number): TerrainGrid {
    const { c0, r0, c1, r1 } = this.unclipped(rect, marginCells);
    return this.window(c0, r0, c1, r1);
  }

  /** The cells windowAt(rect, marginCells) would read, clipped to the grid (nothing is read); empty: c0 > c1 or r0 > r1. */
  windowBounds(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, marginCells: number): { c0: number; r0: number; c1: number; r1: number } {
    const u = this.unclipped(rect, marginCells);
    return { c0: Math.max(u.c0, 0), r0: Math.max(u.r0, 0), c1: Math.min(u.c1, this.cols - 1), r1: Math.min(u.r1, this.rows - 1) };
  }

  private unclipped(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, marginCells: number): { c0: number; r0: number; c1: number; r1: number } {
    if (!Number.isInteger(marginCells) || marginCells < 0) throw new Error(`terrain file ${this.path}: bad margin ${marginCells}`);
    const lo = (v: number, o: number) => Math.max(Math.floor(v - o) - marginCells, -1);
    const hi = (v: number, o: number) => Math.min(Math.floor(v - o) + 1 + marginCells, 2 ** 32);
    return { c0: lo(rect.minX, this.x0), r0: lo(rect.minZ, this.z0), c1: hi(rect.maxX, this.x0), r1: hi(rect.maxZ, this.z0) };
  }

  /** Calls fn for consecutive chunks of whole rows: rows [r0, r0 + n), their cm values as bytes. */
  private forEachRows(fn: (r0: number, n: number, bytes: Uint8Array) => void): void {
    const step = chunkRows(this.cols);
    const bytes = new Uint8Array(2 * this.cols * Math.min(step, this.rows));
    for (let r0 = 0; r0 < this.rows; r0 += step) {
      const n = Math.min(step, this.rows - r0);
      const part = bytes.subarray(0, 2 * this.cols * n);
      readFully(this.open(), part, HEADER + 2 * r0 * this.cols, this.path);
      fn(r0, n, part);
    }
  }

  /** min, max and borderMin in one streaming pass over the file. */
  private reductions(): { min: number; max: number; borderMin: number } {
    if (this.stats) return this.stats;
    const { cols, rows } = this;
    let lo = Infinity, hi = -Infinity, border = Infinity;
    this.forEachRows((r0, n, bytes) => {
      for (let y = 0; y < n; y++) {
        const r = r0 + y, o = 2 * y * cols;
        const edgeRow = r === 0 || r === rows - 1;
        for (let c = 0; c < cols; c++) {
          const cm = bytes[o + 2 * c]! | (bytes[o + 2 * c + 1]! << 8);
          if (cm < lo) lo = cm;
          if (cm > hi) hi = cm;
          if ((edgeRow || c === 0 || c === cols - 1) && cm < border) border = cm;
        }
      }
    });
    // decoding is monotone in cm, so the decoded extremes are the extremes of the decoded grid
    const dec = (cm: number, none: number) => (Number.isFinite(cm) ? this.decoded[cm]! : none);
    this.stats = { min: dec(lo, Infinity), max: dec(hi, -Infinity), borderMin: dec(border, Infinity) };
    return this.stats;
  }

  /** Lowest decoded height (Infinity for an empty grid). */
  min(): number {
    return this.reductions().min;
  }

  /** Highest decoded height (-Infinity for an empty grid). */
  max(): number {
    return this.reductions().max;
  }

  /** Lowest decoded height along the outer rows and columns of the grid. */
  borderMin(): number {
    return this.reductions().borderMin;
  }

  /** SHA-256 (hex) of the file's bytes. */
  contentHash(): string {
    if (this.hash) return this.hash;
    const fd = this.open();
    const size = HEADER + 2 * this.cols * this.rows;
    const h = createHash('sha256');
    const buf = new Uint8Array(Math.min(size, 4 << 20));
    for (let pos = 0; pos < size; pos += buf.length) {
      const part = buf.subarray(0, Math.min(buf.length, size - pos));
      readFully(fd, part, pos, this.path);
      h.update(part);
    }
    this.hash = h.digest('hex');
    return this.hash;
  }

  /** Releases the file descriptor and the cache; later reads throw. */
  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
    this.cache.clear();
    this.last = null;
    this.lastKey = -1;
  }
}

function readFully(fd: number, into: Uint8Array, position: number, path: string): void {
  let done = 0;
  while (done < into.length) {
    const n = readSync(fd, into, done, into.length - done, position + done);
    if (n === 0) throw new Error(`terrain file ${path}: unexpected end of file at byte ${position + done}`);
    done += n;
  }
}

type Header = { x0: number; z0: number; cols: number; rows: number; datum: number };

/**
 * Writes `path` atomically (a temporary file in the same folder, renamed at the end; removed if anything throws) in
 * two streaming passes: the first finds the global minimum (and refuses non-finite heights like encodeTerrain), the
 * second quantises relative to base = floor(min·100)/100 and writes. `row(r, out)` fills out (cols Float32 values)
 * with row r; it is called for every row in order, once per pass, and must give the same values both times.
 */
function writeTwoPass(path: string, h: Header, row: (r: number, out: Float32Array) => void): void {
  const { cols, rows } = h;
  if (!(Number.isInteger(cols) && Number.isInteger(rows) && cols >= 0 && rows >= 0 && cols <= 0xffffffff && rows <= 0xffffffff))
    throw new Error(`terrain file ${path}: bad size ${cols} × ${rows}`);
  const out = new Float32Array(cols);
  let min = Infinity;
  for (let r = 0; r < rows; r++) {
    row(r, out);
    for (let c = 0; c < cols; c++) {
      const v = out[c]!;
      if (!Number.isFinite(v)) throw new Error('terrain: non-finite height');
      if (v < min) min = v;
    }
  }
  const base = cols * rows ? Math.floor(min * 100) / 100 : 0;

  const head = new DataView(new ArrayBuffer(HEADER));
  for (let i = 0; i < 4; i++) head.setUint8(i, MAGIC.charCodeAt(i));
  head.setUint32(4, cols, true);
  head.setUint32(8, rows, true);
  head.setFloat64(12, h.x0, true);
  head.setFloat64(20, h.z0, true);
  head.setFloat64(28, h.datum, true);
  head.setFloat64(36, base, true);

  atomicWrite(path, (write) => {
    write(new Uint8Array(head.buffer));
    const bytes = new Uint8Array(2 * cols);
    for (let r = 0; r < rows; r++) {
      row(r, out);
      for (let c = 0; c < cols; c++) {
        const cm = Math.round((out[c]! - base) * 100);
        if (!(cm >= 0 && cm <= MAX_CM)) {
          if (cm > MAX_CM) throw new Error('terrain: height span exceeds 655.35 m');
          throw new Error(`terrain file ${path}: row ${r} changed between the two passes`);
        }
        bytes[2 * c] = cm & 0xff;
        bytes[2 * c + 1] = cm >>> 8;
      }
      write(bytes);
    }
  });
}

/** Runs fill(write) into a temporary file next to `path` and renames it to `path`; removes it if anything throws. */
function atomicWrite(path: string, fill: (write: (bytes: Uint8Array) => void) => void): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx');
  let closed = false;
  try {
    const buf = new Uint8Array(1 << 20);
    let used = 0;
    const flush = () => {
      for (let o = 0; o < used; ) o += writeSync(fd, buf, o, used - o);
      used = 0;
    };
    fill((bytes) => {
      for (let o = 0; o < bytes.length; ) {
        const n = Math.min(bytes.length - o, buf.length - used);
        buf.set(bytes.subarray(o, o + n), used);
        used += n;
        o += n;
        if (used === buf.length) flush();
      }
    });
    flush();
    closeSync(fd);
    closed = true;
    renameSync(tmp, path);
  } catch (err) {
    if (!closed) closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Streams a full grid to a new file at `path` (atomically): `rows(r, out)` gives the Float32 heights of row r. It is
 * called twice per row – all rows in order for the minimum, then all rows again for writing – so it must be
 * repeatable (give the same values on both calls). Byte-identical to encodeTerrain of the same grid.
 */
export function writeTerrainFile(path: string, header: Header, rows: (r: number, out: Float32Array) => void): TerrainFile {
  writeTwoPass(path, header, rows);
  return TerrainFile.open(path);
}

/**
 * Writes the next version: every cell = edits.get(c, r) where editedMask is non-zero (a Float32 value), else prev's
 * decoded height; re-quantised with the new global minimum – byte-identical to decoding prev, assigning the edits
 * into its Float32Array and encodeTerrain. Two streaming passes over prev, written to `path` atomically.
 * Edits and mask come together (both or neither).
 */
export function commitVersion(prev: TerrainFile, edits: SparseRaster<Float32Array> | null, editedMask: SparseRaster<Uint8Array> | null,
  path: string): TerrainFile {
  if ((edits === null) !== (editedMask === null)) throw new Error('commitVersion: edits and editedMask go together (both or neither)');
  const { cols, rows } = prev;
  for (const s of [edits, editedMask])
    if (s && (s.cols !== cols || s.rows !== rows)) throw new Error(`commitVersion: size ${s.cols} × ${s.rows} does not match the terrain's ${cols} × ${rows}`);
  if (resolve(path) === resolve(prev.path)) throw new Error(`commitVersion: cannot write ${path} over the version it reads`);
  writeTwoPass(path, prev, (r, out) => {
    prev.row(r, out);
    if (!edits || !editedMask) return;
    const pr = Math.floor(r / PAGE), off = (r % PAGE) * PAGE;
    for (let pc = 0; pc < editedMask.pageCols; pc++) {
      const m = editedMask.page(pc, pr);
      if (!m) continue;
      const e = edits.page(pc, pr);
      const c0 = pc * PAGE, n = Math.min(PAGE, cols - c0);
      for (let i = 0; i < n; i++) if (m[off + i] !== 0) out[c0 + i] = e ? e[off + i]! : edits.get(c0 + i, r);
    }
  });
  return TerrainFile.open(path, { blocks: prev.blockCapacity, maxWindowCells: prev.maxWindowCells });
}
