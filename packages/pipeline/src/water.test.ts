import { CHUNK_SIZE } from '@nn/shared';
import { expect, test } from 'vitest';
import { centreLine, riverTerrain } from './riverfixture.js';
import { boxRecord } from './fixture.js';
import { carveRiverBed, findWater, LEVEL_TOL, WATER_DEPTH, waterOutlines, waterShare, waterSurface } from './water.js';

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
