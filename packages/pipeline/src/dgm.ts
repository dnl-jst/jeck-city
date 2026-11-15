import { fromArrayBuffer } from 'geotiff';
import { ORIGIN_UTM, type TerrainGrid } from '@nn/shared';
import type { Rect } from './chunks.js';

/** NHN heights, 1 m pixels, row 0 = north; pixel (i, j) centre at (e0 + i + 0.5, n0 − j − 0.5). */
export type Mosaic = { e0: number; n0: number; width: number; height: number; data: Float32Array };

export const TERRAIN_SIGMA = 1;
const NODATA = -9999;

export async function readDgmTile(buf: ArrayBuffer): Promise<Mosaic> {
  const image = await (await fromArrayBuffer(buf)).getImage();
  const [e0, n0] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  if (Math.abs(rx!) !== 1 || Math.abs(ry!) !== 1) throw new Error(`dgm: resolution ${rx}×${ry}, expected 1 m`);
  const width = image.getWidth(), height = image.getHeight();
  const raster = (await image.readRasters({ samples: [0], interleave: true })) as unknown as ArrayLike<number>;
  const data = Float32Array.from(raster);
  if (data.some((v) => v === NODATA || !Number.isFinite(v))) throw new Error('dgm: tile contains NoData');
  return { e0: e0!, n0: n0!, width, height, data };
}

/** Joins tiles (any order) into one gap-free mosaic; throws if the union is not fully covered. */
export function mosaic(tiles: Mosaic[]): Mosaic {
  if (!tiles.length) throw new Error('dgm: no tiles');
  const e0 = Math.min(...tiles.map((t) => t.e0));
  const n0 = Math.max(...tiles.map((t) => t.n0));
  const e1 = Math.max(...tiles.map((t) => t.e0 + t.width));
  const n1 = Math.min(...tiles.map((t) => t.n0 - t.height));
  const width = e1 - e0, height = n0 - n1;
  const data = new Float32Array(width * height).fill(NaN);
  for (const t of tiles) {
    for (let j = 0; j < t.height; j++) {
      data.set(t.data.subarray(j * t.width, (j + 1) * t.width), (n0 - t.n0 + j) * width + (t.e0 - e0));
    }
  }
  if (data.some((v) => Number.isNaN(v))) throw new Error('dgm: mosaic has gaps');
  return { e0, n0, width, height, data };
}

/** Separable Gaussian blur, edges clamped. */
export function gaussBlur(m: Mosaic, sigma: number): Mosaic {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  const { width: w, height: h } = m;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let a = 0;
      for (let d = -r; d <= r; d++) a += k[d + r]! * m.data[j * w + Math.min(Math.max(i + d, 0), w - 1)]!;
      tmp[j * w + i] = a;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let a = 0;
      for (let d = -r; d <= r; d++) a += k[d + r]! * tmp[Math.min(Math.max(j + d, 0), h - 1) * w + i]!;
      out[j * w + i] = a;
    }
  }
  return { ...m, data: out };
}

/** Bilinear height at UTM (e, n); clamped to the mosaic. */
function sampleMosaic(m: Mosaic, e: number, n: number): number {
  const u = Math.min(Math.max(e - m.e0 - 0.5, 0), m.width - 1);
  const v = Math.min(Math.max(m.n0 - n - 0.5, 0), m.height - 1);
  const i = Math.min(Math.floor(u), Math.max(m.width - 2, 0));
  const j = Math.min(Math.floor(v), Math.max(m.height - 2, 0));
  const fx = u - i, fy = v - j;
  const i1 = Math.min(i + 1, m.width - 1), j1 = Math.min(j + 1, m.height - 1);
  const d = m.data, w = m.width;
  const top = d[j * w + i]! * (1 - fx) + d[j * w + i1]! * fx;
  const bot = d[j1 * w + i]! * (1 - fx) + d[j1 * w + i1]! * fx;
  return top * (1 - fy) + bot * fy;
}

/** Samples `m` bilinearly at integer local x/z from floor(min) to ceil(max) of `rect`; datum = height at (0,0) rounded to 0.1 m. */
export function terrainFromMosaic(m: Mosaic, rect: Rect): TerrainGrid {
  const x0 = Math.floor(rect.minX), z0 = Math.floor(rect.minZ);
  const cols = Math.ceil(rect.maxX) - x0 + 1, rows = Math.ceil(rect.maxZ) - z0 + 1;
  const eMin = ORIGIN_UTM.e + x0, eMax = ORIGIN_UTM.e + x0 + cols - 1;
  const nMax = ORIGIN_UTM.n - z0, nMin = ORIGIN_UTM.n - (z0 + rows - 1);
  if (eMin < m.e0 || eMax > m.e0 + m.width || nMax > m.n0 || nMin < m.n0 - m.height)
    throw new Error(`terrain rect E ${eMin}..${eMax}, N ${nMin}..${nMax} lies outside the DGM mosaic E ${m.e0}..${m.e0 + m.width}, N ${m.n0 - m.height}..${m.n0}`);
  const at = (x: number, z: number) => sampleMosaic(m, ORIGIN_UTM.e + x, ORIGIN_UTM.n - z);
  const datum = Math.round(at(0, 0) * 10) / 10;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = at(x0 + c, z0 + r) - datum;
  return { x0, z0, cols, rows, datum, heights };
}

