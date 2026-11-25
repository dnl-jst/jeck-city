import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ORIGIN_UTM } from '@nn/shared';
import type { Rect } from '../chunks.js';
import { gaussKernel, NODATA, type Mosaic } from '../dgm.js';
import { type TerrainFile, writeTerrainFile } from './file.js';

// T0 – the blurred DGM sampled on the world grid – computed in bands, never holding the mosaic, its blurred copy or the
// grid. The arithmetic is that of dgm.ts (mosaic → gaussBlur → terrainFromMosaic/sampleMosaic) step by step, in the
// same order and with the same Float32 stores, so the result is byte-identical:
//   raw mosaic row j (tiles pasted in list order) → horizontal pass (float64 sum, d = -r..r, stored as Float32)
//   → vertical pass over 2r + 1 horizontal rows (row index clamped to the MOSAIC, float64 sum, stored as Float32)
//   → bilinear sample at the integer grid points (sampleMosaic's index and clamping rules) → minus datum → Float32.
// Raw rows are consumed in order, so only the tiles crossing the current pixel row are decoded at a time.

/** Where a tile sits in the mosaic, in pixels (column `left`, row `top`; row 0 = north). */
type TileBox = { name: string; order: number; left: number; top: number; width: number; height: number; e0: number; n0: number };
/** The mosaic as dgm.ts's `mosaic` would build it, without its pixels. */
type Layout = { e0: number; n0: number; width: number; height: number; tiles: TileBox[] };
type Read = (name: string) => Promise<Mosaic>;

/** The checks readDgmTile and mosaic make on a tile's pixels (NoData, non-finite; mosaic treats NaN as a gap). */
function checkTile(name: string, t: Mosaic): void {
  if (t.data.length !== t.width * t.height) throw new Error(`dgm: tile ${name} has ${t.data.length} pixels, expected ${t.width} × ${t.height}`);
  const d = t.data;
  for (let i = 0; i < d.length; i++) if (d[i] === NODATA || !Number.isFinite(d[i]!)) throw new Error('dgm: tile contains NoData');
}

/** Reads every tile once (one at a time) for its extent and checks; the union extent and gap check of `mosaic`. */
async function survey(names: string[], read: Read): Promise<Layout> {
  if (!names.length) throw new Error('dgm: no tiles');
  const ext: { e0: number; n0: number; width: number; height: number }[] = [];
  for (const name of names) {
    const t = await read(name);
    checkTile(name, t);
    ext.push({ e0: t.e0, n0: t.n0, width: t.width, height: t.height });
  }
  const e0 = Math.min(...ext.map((t) => t.e0));
  const n0 = Math.max(...ext.map((t) => t.n0));
  const e1 = Math.max(...ext.map((t) => t.e0 + t.width));
  const n1 = Math.min(...ext.map((t) => t.n0 - t.height));
  const width = e1 - e0, height = n0 - n1;
  const tiles = ext.map((t, order) => ({ ...t, name: names[order]!, order, left: t.e0 - e0, top: n0 - t.n0 }));
  // gaps: between consecutive tile edges (north–south), the tiles spanning that strip must cover every column
  const edges = [...new Set([0, height, ...tiles.flatMap((t) => [t.top, t.top + t.height])])].sort((a, b) => a - b);
  for (let s = 0; s + 1 < edges.length; s++) {
    const y0 = edges[s]!, y1 = edges[s + 1]!;
    const spans = tiles.filter((t) => t.top <= y0 && t.top + t.height >= y1).sort((a, b) => a.left - b.left);
    let reach = 0;
    for (const t of spans) {
      if (t.left > reach) break;
      reach = Math.max(reach, t.left + t.width);
    }
    if (reach < width) throw new Error('dgm: mosaic has gaps');
  }
  return { e0, n0, width, height, tiles };
}

/**
 * The blurred mosaic's rows ja..jb over columns ia..ib (other columns of the returned rows are stale), computed in
 * row order. Keeps 2r + 1 horizontal rows, the last requested blurred rows and the decoded tiles
 * crossing the current raw row.
 */
class BlurStream {
  private readonly r: number;
  private readonly ra: number;
  private readonly rb: number;
  private nextH: number;
  private nextB: number;
  private readonly hRows = new Map<number, Float32Array>();
  private readonly bRows = new Map<number, Float32Array>();
  private readonly free: Float32Array[] = [];
  private readonly raw: Float32Array;
  private readonly held = new Map<TileBox, Mosaic>();
  /** The tiles the raw rows use (they intersect the raw columns), by top row. */
  private readonly wanted: TileBox[];
  private nextTile = 0;

  constructor(private readonly m: Layout, private readonly read: Read, private readonly k: Float64Array,
    private readonly ia: number, private readonly ib: number, ja: number, jb: number, private readonly maxTiles: number) {
    const r = (this.r = (k.length - 1) / 2);
    this.ra = Math.max(0, ia - r);
    this.rb = Math.min(m.width - 1, ib + r);
    const ha = Math.max(0, ja - r), hb = Math.min(m.height - 1, jb + r);
    this.nextH = ha;
    this.nextB = ja;
    this.raw = new Float32Array(m.width);
    this.wanted = m.tiles
      .filter((t) => t.left <= this.rb && t.left + t.width > this.ra && t.top <= hb && t.top + t.height > ha)
      .sort((a, b) => a.top - b.top || a.order - b.order);
    // the most tiles crossing one raw row: refused here, before anything is read or written
    for (const y of new Set([ha, ...this.wanted.map((t) => t.top).filter((y) => y >= ha)])) {
      const n = this.wanted.filter((t) => t.top <= y && t.top + t.height > y).length;
      if (n > maxTiles) throw new Error(`dgm: pixel row ${y} needs ${n} decoded tiles at once, more than maxTiles = ${maxTiles}`);
    }
  }

  private row(): Float32Array {
    return this.free.pop() ?? new Float32Array(this.m.width);
  }

  /** Decoded tiles for raw row y: drops those above it, reads those starting at it. */
  private async tilesFor(y: number): Promise<void> {
    for (const t of this.held.keys()) if (t.top + t.height <= y) this.held.delete(t);
    while (this.nextTile < this.wanted.length && this.wanted[this.nextTile]!.top <= y) {
      const box = this.wanted[this.nextTile++]!;
      if (box.top + box.height <= y) continue;
      if (this.held.size >= this.maxTiles) throw new Error(`dgm: more than maxTiles = ${this.maxTiles} decoded tiles at once`);
      const t = await this.read(box.name);
      if (t.e0 !== box.e0 || t.n0 !== box.n0 || t.width !== box.width || t.height !== box.height)
        throw new Error(`dgm: tile ${box.name} changed between reads`);
      checkTile(box.name, t);
      this.held.set(box, t);
    }
  }

  /** Horizontal pass of raw row y (gaussBlur's first loop), columns ia..ib. */
  private async horizontal(y: number): Promise<Float32Array> {
    await this.tilesFor(y);
    const raw = this.raw;
    // pasted in list order, like mosaic: where tiles overlap the later one wins
    const held = [...this.held].sort((a, b) => a[0].order - b[0].order);
    for (const [box, t] of held) {
      const a = Math.max(box.left, this.ra), b = Math.min(box.left + box.width - 1, this.rb);
      const o = (y - box.top) * box.width - box.left;
      raw.set(t.data.subarray(o + a, o + b + 1), a);
    }
    const { k, r, ia, ib } = this, w = this.m.width;
    const out = this.row();
    for (let i = ia; i <= ib; i++) {
      let a = 0;
      for (let d = -r; d <= r; d++) a += k[d + r]! * raw[Math.min(Math.max(i + d, 0), w - 1)]!;
      out[i] = a;
    }
    return out;
  }

  /** Blurred row j (gaussBlur's second loop); j is not below a row given to release. */
  async blurred(j: number): Promise<Float32Array> {
    const got = this.bRows.get(j);
    if (got) return got;
    if (j < this.nextB) throw new Error(`dgm: blurred row ${j} requested after row ${this.nextB - 1}`);
    const { k, r, ia, ib } = this, h = this.m.height;
    for (; this.nextB <= j; this.nextB++) {
      const jj = this.nextB;
      for (const [y, row] of this.hRows) if (y < jj - r) (this.hRows.delete(y), this.free.push(row));
      for (const last = Math.min(h - 1, jj + r); this.nextH <= last; this.nextH++) this.hRows.set(this.nextH, await this.horizontal(this.nextH));
      const taps: Float32Array[] = [];
      for (let d = -r; d <= r; d++) taps.push(this.hRows.get(Math.min(Math.max(jj + d, 0), h - 1))!);
      const out = this.row();
      for (let i = ia; i <= ib; i++) {
        let a = 0;
        for (let d = -r; d <= r; d++) a += k[d + r]! * taps[d + r]![i]!;
        out[i] = a;
      }
      this.bRows.set(jj, out);
    }
    return this.bRows.get(j)!;
  }

  /** Lets go of the blurred rows above j: no row before j is asked for any more. */
  release(j: number): void {
    for (const [y, row] of this.bRows) if (y < j) (this.bRows.delete(y), this.free.push(row));
  }
}

type RowSink = (r: number, s: Float64Array) => void;

/**
 * Samples the blurred mosaic bilinearly at the integer grid points (x0 + c, z0 + r), c < cols, r < rows, in the
 * arithmetic of sampleMosaic (dgm.ts). Plans the band (and refuses a maxTiles it cannot keep) right away; the returned
 * function, called once, calls onRow(r, samples) for every row in order (samples: cols doubles, reused).
 */
function gridSampler(m: Layout, read: Read, k: Float64Array, maxTiles: number,
  g: { x0: number; z0: number; cols: number; rows: number }): (onRow: RowSink) => Promise<void> {
  const W = m.width, H = m.height;
  const ci = new Int32Array(g.cols), ci1 = new Int32Array(g.cols), fxs = new Float64Array(g.cols);
  for (let c = 0; c < g.cols; c++) {
    const e = ORIGIN_UTM.e + (g.x0 + c);
    const u = Math.min(Math.max(e - m.e0 - 0.5, 0), W - 1);
    const i = Math.min(Math.floor(u), Math.max(W - 2, 0));
    ci[c] = i;
    fxs[c] = u - i;
    ci1[c] = Math.min(i + 1, W - 1);
  }
  const rj = new Int32Array(g.rows), rj1 = new Int32Array(g.rows), fys = new Float64Array(g.rows);
  for (let r = 0; r < g.rows; r++) {
    const n = ORIGIN_UTM.n - (g.z0 + r);
    const v = Math.min(Math.max(m.n0 - n - 0.5, 0), H - 1);
    const j = Math.min(Math.floor(v), Math.max(H - 2, 0));
    rj[r] = j;
    fys[r] = v - j;
    rj1[r] = Math.min(j + 1, H - 1);
  }
  if (!g.cols || !g.rows) return async () => {};
  // u and v grow with c and r: the first and last samples bound the pixels used
  const stream = new BlurStream(m, read, k, ci[0]!, ci1[g.cols - 1]!, rj[0]!, rj1[g.rows - 1]!, maxTiles);
  return async (onRow) => {
    const s = new Float64Array(g.cols);
    for (let r = 0; r < g.rows; r++) {
      const top = await stream.blurred(rj[r]!);
      const bot = await stream.blurred(rj1[r]!);
      const fy = fys[r]!;
      for (let c = 0; c < g.cols; c++) {
        const i = ci[c]!, i1 = ci1[c]!, fx = fxs[c]!;
        const t = top[i]! * (1 - fx) + top[i1]! * fx;
        const b = bot[i]! * (1 - fx) + bot[i1]! * fx;
        s[c] = t * (1 - fy) + b * fy;
      }
      onRow(r, s);
      stream.release(rj[r]!);
    }
  };
}

type T0Options = { tiles: string[]; read: (name: string) => Promise<Mosaic>; area: Rect; sigma: number; maxTiles?: number };
type T0Header = { x0: number; z0: number; cols: number; rows: number; datum: number };

/**
 * The checks and the datum of T0, then `rows` streams its unquantised heights: onRow(r, heights) for every grid row in
 * order, heights[c] = terrainFromMosaic(…).heights[r·cols + c] exactly (the array is reused between calls).
 *
 * Every tile is read once here (extent, NoData, gaps, then the area check – all of terrainFromMosaic's and mosaic's
 * errors come before anything is written), and the datum's few tiles once more; `rows` reads each tile the grid uses
 * once more, holding only the decoded tiles that cross one pixel row (`maxTiles` caps that, refused here, before
 * the datum; default unlimited). `rows` can be called once.
 */
export async function planT0(o: T0Options): Promise<{ header: T0Header; rows: (onRow: (r: number, heights: Float32Array) => void) => Promise<void> }> {
  const maxTiles = o.maxTiles ?? Infinity;
  if (!(maxTiles >= 1)) throw new Error(`dgm: bad maxTiles ${o.maxTiles}`);
  const m = await survey(o.tiles, o.read);
  const rect = o.area;
  // terrainFromMosaic's grid and its check, verbatim
  const x0 = Math.floor(rect.minX), z0 = Math.floor(rect.minZ);
  const cols = Math.ceil(rect.maxX) - x0 + 1, rows = Math.ceil(rect.maxZ) - z0 + 1;
  const eMin = ORIGIN_UTM.e + x0, eMax = ORIGIN_UTM.e + x0 + cols - 1;
  const nMax = ORIGIN_UTM.n - z0, nMin = ORIGIN_UTM.n - (z0 + rows - 1);
  if (eMin < m.e0 || eMax > m.e0 + m.width || nMax > m.n0 || nMin < m.n0 - m.height)
    throw new Error(`terrain rect E ${eMin}..${eMax}, N ${nMin}..${nMax} lies outside the DGM mosaic E ${m.e0}..${m.e0 + m.width}, N ${m.n0 - m.height}..${m.n0}`);
  const k = gaussKernel(o.sigma);

  const datumBand = gridSampler(m, o.read, k, maxTiles, { x0: 0, z0: 0, cols: 1, rows: 1 });
  const mainBand = gridSampler(m, o.read, k, maxTiles, { x0, z0, cols, rows });

  // the datum: the same band code on the one-point grid at local (0, 0)
  let at00 = NaN;
  await datumBand((_r, s) => (at00 = s[0]!));
  const datum = Math.round(at00 * 10) / 10;

  const line = new Float32Array(cols);
  let used = false;
  return {
    header: { x0, z0, cols, rows, datum },
    rows: (onRow) => {
      if (used) throw new Error('planT0: rows can be streamed once');
      used = true;
      return mainBand((r, s) => {
        for (let c = 0; c < cols; c++) line[c] = s[c]! - datum;
        onRow(r, line);
      });
    },
  };
}

/**
 * T0: the blurred DGM sampled on the world grid, quantised — byte-identical to
 * encodeTerrain(terrainFromMosaic(gaussBlur(mosaic(tiles), sigma), area)), without ever holding the mosaic.
 *
 * Reads and checks as planT0. The heights are computed once: their unquantised Float32 rows are spooled to a temporary
 * file next to `path` (cols · rows · 4 bytes on disk, removed at the end), which writeTerrainFile's two passes
 * (minimum, then writing) read back row by row.
 */
export async function buildT0(o: T0Options & { path: string }): Promise<TerrainFile> {
  const plan = await planT0(o);
  const { cols } = plan.header;
  const spool = join(dirname(o.path), `.${basename(o.path)}.${process.pid}.${randomBytes(4).toString('hex')}.spool`);
  const fd = openSync(spool, 'wx+');
  try {
    const rowBytes = 4 * cols;
    const buf = new Uint8Array(Math.max(rowBytes, 1 << 20));
    let used = 0, pos = 0;
    const flush = () => {
      for (let w = 0; w < used; ) w += writeSync(fd, buf, w, used - w, pos + w);
      pos += used;
      used = 0;
    };
    await plan.rows((_r, heights) => {
      if (used + rowBytes > buf.length) flush();
      buf.set(new Uint8Array(heights.buffer, heights.byteOffset, rowBytes), used);
      used += rowBytes;
    });
    flush();
    return writeTerrainFile(o.path, plan.header, (r, out) => {
      const into = new Uint8Array(out.buffer, out.byteOffset, rowBytes);
      for (let done = 0; done < rowBytes; ) {
        const n = readSync(fd, into, done, rowBytes - done, r * rowBytes + done);
        if (n === 0) throw new Error(`dgm: spool ${spool} ends early at row ${r}`);
        done += n;
      }
    });
  } finally {
    closeSync(fd);
    rmSync(spool, { force: true });
  }
}
