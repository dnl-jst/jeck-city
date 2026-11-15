import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ORIGIN_UTM } from '@nn/shared';
import { gaussBlur, mosaic, readDgmTile, terrainFromMosaic, type Mosaic } from './dgm';

function ramp(e0: number, n0: number, w: number, h: number, f: (e: number, n: number) => number): Mosaic {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = f(e0 + i + 0.5, n0 - j - 0.5);
  return { e0, n0, width: w, height: h, data };
}

test('mosaic is continuous across tile seams', () => {
  const f = (e: number) => 40 + 0.01 * e;
  const m = mosaic([ramp(1010, 500, 10, 10, f), ramp(1000, 500, 10, 10, f)]);
  expect([m.width, m.height, m.e0, m.n0]).toEqual([20, 10, 1000, 500]);
  const b = gaussBlur(m, 1);
  for (let j = 4; j < 6; j++) // interior only: clamped edges flatten the ramp
    for (let i = 4; i < 15; i++) expect(Math.abs(b.data[j * 20 + i + 1]! - b.data[j * 20 + i]! - 0.01)).toBeLessThan(1e-4);
});

test('mosaic rejects gaps', () => {
  expect(() => mosaic([ramp(1000, 500, 10, 10, () => 1), ramp(1011, 500, 10, 10, () => 1)])).toThrow();
});

test('blur keeps planes', () => {
  const m = ramp(0, 30, 30, 30, (e, n) => 40 + 0.02 * e - 0.03 * n);
  const b = gaussBlur(m, 1);
  for (let j = 5; j < 25; j++)
    for (let i = 5; i < 25; i++) expect(b.data[j * 30 + i]!).toBeCloseTo(m.data[j * 30 + i]!, 3);
});

test('half-pixel sampling', () => {
  const m = ramp(ORIGIN_UTM.e - 50, ORIGIN_UTM.n + 50, 100, 100, (e) => e - ORIGIN_UTM.e + 40);
  const g = terrainFromMosaic(m, { minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
  expect(g.datum).toBe(40);
  for (let c = 0; c < g.cols; c++) expect(g.heights[c]! + g.datum).toBeCloseTo(40 + g.x0 + c, 3);
});

test('datum', () => {
  const m = ramp(ORIGIN_UTM.e - 50, ORIGIN_UTM.n + 50, 100, 100, () => 47.26);
  const g = terrainFromMosaic(m, { minX: -3, maxX: 3, minZ: -3, maxZ: 3 });
  expect(g.datum).toBe(47.3);
  for (const h of g.heights) expect(h).toBeCloseTo(-0.04, 4);
});

test('rect coverage', () => {
  const m = ramp(ORIGIN_UTM.e - 50, ORIGIN_UTM.n + 50, 100, 100, () => 47);
  const g = terrainFromMosaic(m, { minX: -10.5, maxX: 20.2, minZ: -3, maxZ: 4 });
  expect([g.x0, g.cols, g.z0, g.rows]).toEqual([-11, 32, -3, 8]);
});

test('mosaic and blur handle z orientation (row 0 = north)', () => {
  const m = ramp(ORIGIN_UTM.e - 50, ORIGIN_UTM.n + 50, 100, 100, (_e, n) => n - ORIGIN_UTM.n + 40);
  const g = terrainFromMosaic(m, { minX: -3, maxX: 3, minZ: -3, maxZ: 3 });
  // z = -(n - n0): height = 40 - z
  expect(g.heights[0]! + g.datum).toBeCloseTo(40 - g.z0, 3);
});

const real = 'data/raw/dgm1/dgm1_32_356_5647_1_nw_2022.tif';
test.skipIf(!existsSync(real))('readDgmTile reads a real tile', async () => {
  const b = readFileSync(real);
  const t = await readDgmTile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  expect([t.e0, t.n0, t.width, t.height]).toEqual([356000, 5648000, 1000, 1000]);
});
