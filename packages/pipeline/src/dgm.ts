import { fromArrayBuffer } from 'geotiff';

/** NHN heights, 1 m pixels, row 0 = north; pixel (i, j) centre at (e0 + i + 0.5, n0 − j − 0.5). */
export type Mosaic = { e0: number; n0: number; width: number; height: number; data: Float32Array };

export const TERRAIN_SIGMA = 1;
export const NODATA = -9999;

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

/**
 * The normalised Gaussian kernel of the DGM blur (terrain/dgmstream.ts; its dense reference gaussBlur is in
 * dgm.dense.test-util.ts): radius r = max(1, ceil(3σ)), 2r + 1 weights.
 */
export function gaussKernel(sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}
