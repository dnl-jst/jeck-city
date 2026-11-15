import { TERRAIN_DIAGONAL, type TerrainGrid } from '@nn/shared';
import { expect, test } from 'vitest';
import { groundMesh, type GroundMesh } from './ground.js';

/** Grid over x/z ∈ [lo, hi] (1 m spacing) with height h(x, z). */
function grid(lo: number, hi: number, h: (x: number, z: number) => number = () => 0): TerrainGrid {
  const n = hi - lo + 1;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = h(lo + c, lo + r);
  return { x0: lo, z0: lo, cols: n, rows: n, datum: 40, heights };
}

/** Summed xz area of all triangles; also asserts every triangle faces up (counter-clockwise from above). */
function xzArea(m: GroundMesh): number {
  let sum = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const ux = p[b * 3]! - p[a * 3]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const ny = uz * vx - ux * vz; // y of (b − a) × (c − a)
    expect(ny).toBeGreaterThan(0);
    sum += ny / 2;
  }
  return sum;
}

const bounds = (m: GroundMesh) => {
  const xs = [], zs = [];
  for (let i = 0; i < m.positions.length; i += 3) xs.push(m.positions[i]!), zs.push(m.positions[i + 2]!);
  return [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
};

test('ground covers its chunk without gaps', () => {
  const t = grid(-250, 450, (x, z) => 0.01 * x + 0.02 * z);
  const m = groundMesh(t, 0, 0)!;
  expect(m.positions.length / 3).toBe(201 * 201);
  expect(m.uv.length / 2).toBe(201 * 201);
  expect(m.normals.length / 3).toBe(201 * 201);
  expect(m.indices.length / 3).toBe(200 * 200 * 2);
  expect(xzArea(m)).toBeCloseTo(40_000, 6);
  expect(bounds(m)).toEqual([0, 200, 0, 200]);
  for (let i = 0; i < m.positions.length / 3; i++) {
    const x = m.positions[i * 3]!, z = m.positions[i * 3 + 2]!;
    expect(m.positions[i * 3 + 1]).toBeCloseTo(0.01 * x + 0.02 * z, 4);
    expect(m.uv[i * 2]).toBe(x);
    expect(m.uv[i * 2 + 1]).toBe(z);
  }
  // the neighbour chunk shares the edge column x = 200
  expect(bounds(groundMesh(t, 1, 0)!)).toEqual([200, 400, 0, 200]);
  expect(bounds(groundMesh(t, -1, -1)!)).toEqual([-200, 0, -200, 0]);
});

test('ground clipped to the grid', () => {
  const t = grid(-250, 450);
  const m = groundMesh(t, 2, -2)!; // [400, 600] × [−400, −200] ∩ grid = [400, 450] × [−250, −200]
  expect(bounds(m)).toEqual([400, 450, -250, -200]);
  expect(m.positions.length / 3).toBe(51 * 51);
  expect(xzArea(m)).toBeCloseTo(2500, 6);
});

test('ground normals point up and match slope', () => {
  const m = groundMesh(grid(-250, 450, (x) => 0.1 * x), 0, 0)!;
  for (let i = 0; i < m.normals.length / 3; i++) {
    expect(m.normals[i * 3]).toBeCloseTo(-0.0995, 4);
    expect(m.normals[i * 3 + 1]).toBeCloseTo(0.995, 3);
    expect(m.normals[i * 3 + 2]).toBeCloseTo(0, 6);
  }
  // also at the grid edge (one-sided difference)
  const e = groundMesh(grid(-250, 450, (x) => 0.1 * x), 2, 0)!;
  for (let i = 0; i < e.normals.length / 3; i++) expect(e.normals[i * 3]).toBeCloseTo(-0.0995, 4);
});

test('ground triangles use TERRAIN_DIAGONAL', () => {
  const m = groundMesh(grid(-250, 450), 0, 0)!;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => m.indices[t + k]!).map((i) => [p[i * 3]!, p[i * 3 + 2]!] as const);
    const cx = Math.min(...v.map((q) => q[0])), cz = Math.min(...v.map((q) => q[1]));
    const has = (x: number, z: number) => v.some((q) => q[0] === x && q[1] === z);
    if (TERRAIN_DIAGONAL === 'x0z0-x1z1') expect(has(cx, cz) && has(cx + 1, cz + 1)).toBe(true);
    else expect(has(cx + 1, cz) && has(cx, cz + 1)).toBe(true);
  }
});

test('outside → null', () => {
  const t = grid(-250, 450);
  expect(groundMesh(t, 5, 0)).toBeNull();
  expect(groundMesh(t, 0, -3)).toBeNull();
  expect(groundMesh(grid(0, 400), 2, 0)).toBeNull(); // touches the grid only along the line x = 400
});
