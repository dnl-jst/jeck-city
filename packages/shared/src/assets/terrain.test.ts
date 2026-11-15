import { expect, test } from 'vitest';
import { decodeTerrain, encodeTerrain, heightAt, terrainNormal, TERRAIN_DIAGONAL, type TerrainGrid } from './terrain';

const grid = (cols: number, rows: number, f: (c: number, r: number) => number, x0 = 0, z0 = 0): TerrainGrid => {
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(c, r);
  return { x0, z0, cols, rows, datum: 37.5, heights };
};

test('exact at grid points', () => {
  const t = grid(3, 3, (c, r) => r * 10 + c, -5, 7);
  expect(heightAt(t, t.x0 + 2, t.z0 + 1)).toBe(12);
  expect(heightAt(t, t.x0, t.z0)).toBe(0);
});

test('linear inside a triangle', () => {
  const t = grid(2, 2, (c, r) => (c === r ? 0 : 1)); // h00=0 h10=1 h01=1 h11=0
  if (TERRAIN_DIAGONAL === 'x0z0-x1z1') {
    expect(heightAt(t, 0.5, 0.5)).toBeCloseTo(0, 6);
    // (0.25, 0.75) lies in triangle (0,0),(0,1),(1,1): h = 0 + 0.75*(1-0) + 0.25*(0-1)
    expect(heightAt(t, 0.25, 0.75)).toBeCloseTo(0.75 * 1 + 0.25 * -1, 6);
  } else {
    expect(heightAt(t, 0.5, 0.5)).toBeCloseTo(1, 6);
    // (0.25, 0.75) lies on the line x+z=1: between (1,0)=1 and (0,1)=1 -> 1
    expect(heightAt(t, 0.25, 0.75)).toBeCloseTo(1, 6);
  }
});

test('clamps outside the grid', () => {
  const t = grid(3, 3, (c, r) => r * 10 + c, 100, 200);
  expect(heightAt(t, t.x0 - 50, t.z0 - 50)).toBe(0);
  expect(heightAt(t, 1e6, 1e6)).toBe(22);
  expect(Number.isNaN(heightAt(t, -1e9, 1e9))).toBe(false);
});

test('normal of a plane', () => {
  const t = grid(5, 5, (c) => 0.1 * c);
  for (const [x, z] of [[1.3, 1.1], [2.2, 3.7]] as const) {
    const n = terrainNormal(t, x, z);
    expect(n.x).toBeCloseTo(-0.0995, 3);
    expect(n.y).toBeCloseTo(0.995, 3);
    expect(n.z).toBeCloseTo(0, 6);
  }
});

test('round trip to 1 cm', () => {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const t = { ...grid(50, 40, () => 38 + rnd() * 26, -12.25, 99.5), datum: 36.123 };
  const d = decodeTerrain(encodeTerrain(t));
  expect([d.cols, d.rows, d.x0, d.z0, d.datum]).toEqual([50, 40, -12.25, 99.5, 36.123]);
  for (let i = 0; i < t.heights.length; i++) expect(Math.abs(d.heights[i]! - t.heights[i]!)).toBeLessThanOrEqual(0.005 + 1e-4);
});

test('rejects too large span and non-finite values', () => {
  expect(() => encodeTerrain(grid(2, 2, (c) => c * 700))).toThrow();
  expect(() => encodeTerrain(grid(2, 2, (c) => (c ? NaN : 1)))).toThrow();
});

test('decode rejects bad magic and truncated data', () => {
  expect(() => decodeTerrain(new ArrayBuffer(44))).toThrow();
  const buf = encodeTerrain(grid(2, 2, () => 1));
  expect(() => decodeTerrain(buf.slice(0, buf.byteLength - 2))).toThrow();
});
