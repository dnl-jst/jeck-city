import { expect, test } from 'vitest';
import { heightAt, TERRAIN_DIAGONAL, type TerrainGrid } from '@nn/shared';
import { drapeMesh } from './drape.js';
import type { Mesh } from './streets.js';

const X0 = -3;
const Z0 = -2;
const N = 20;

function grid(f: (x: number, z: number) => number): TerrainGrid {
  const heights = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) heights[r * N + c] = f(X0 + c, Z0 + r);
  return { x0: X0, z0: Z0, cols: N, rows: N, datum: 0, heights };
}

const hilly = grid((x, z) => 0.3 * x + 0.2 * z + 0.5 * Math.sin(x) * Math.cos(z));
const flat = grid(() => 2);

type V = [number, number, number];

/** Non-indexed-style mesh from triangles; uv defaults to (x, z). */
function mesh(tris: V[][], uv?: (p: V) => [number, number]): Mesh {
  const pos: number[] = [];
  const uvs: number[] = [];
  for (const t of tris)
    for (const p of t) {
      pos.push(...p);
      uvs.push(...(uv ? uv(p) : [p[0], p[2]]));
    }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i), uv: Float32Array.from(uvs) };
}

const vert = (m: Mesh, i: number): V => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];

function* triangles(m: Mesh): Generator<[V, V, V]> {
  for (let i = 0; i < m.indices.length; i += 3) yield [vert(m, m.indices[i]!), vert(m, m.indices[i + 1]!), vert(m, m.indices[i + 2]!)];
}

/** Signed xz area, positive for counter-clockwise seen from above (normal y > 0). */
const xzArea = ([a, b, c]: [V, V, V]) => ((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])) / 2;
const totalArea = (m: Mesh) => [...triangles(m)].reduce((s, t) => s + xzArea(t), 0);

// Upward-facing (counter-clockwise from above) triangle spanning ~5×5 cells, avoiding lattice corners.
const BIG: V[] = [
  [1.3, 0.01, 1.2],
  [2.2, 0.01, 6.7],
  [6.4, 0.01, 2.1],
];

function expectValid(m: Mesh) {
  expect(m.positions.length % 3).toBe(0);
  expect(m.uv.length / 2).toBe(m.positions.length / 3);
  expect(m.indices.length % 3).toBe(0);
  for (const i of m.indices) expect(i).toBeLessThan(m.positions.length / 3);
}

test('flat terrain is identity-like', () => {
  const input = mesh([BIG, [[7, 0.05, 7], [7.5, 0.05, 9.25], [9.9, 0.05, 7.1]]]);
  expect(totalArea(input)).toBeGreaterThan(0);
  const out = drapeMesh(input, flat);
  expectValid(out);
  for (const t of triangles(out)) for (const p of t) expect([0.01 + 2, 0.05 + 2].some((y) => Math.abs(p[1] - y) < 1e-6)).toBe(true);
  expect(totalArea(out)).toBeCloseTo(totalArea(input), 6);
});

test('every vertex sits on terrain plus offset', () => {
  const out = drapeMesh(mesh([BIG]), hilly);
  expectValid(out);
  expect(out.indices.length / 3).toBeGreaterThan(25);
  for (let i = 0; i < out.positions.length / 3; i++) {
    const [x, y, z] = vert(out, i);
    expect(Math.abs(y - 0.01 - heightAt(hilly, x, z))).toBeLessThan(1e-5);
  }
});

/** Signed distance-like value of (x, z) to the diagonal of cell (c, r); <= 0 on the side containing corner (x0+c, z0+r). */
function diagSide(x: number, z: number, c: number, r: number): number {
  const u = x - X0 - c;
  const v = z - Z0 - r;
  return TERRAIN_DIAGONAL === 'x1z0-x0z1' ? u + v - 1 : v - u;
}

test('no output triangle spans a terrain triangle', () => {
  const out = drapeMesh(mesh([BIG]), hilly);
  for (const t of triangles(out)) {
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
    const cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
    const c = Math.floor(cx - X0);
    const r = Math.floor(cz - Z0);
    const side = Math.sign(diagSide(cx, cz, c, r));
    for (const [x, , z] of t) {
      expect(x).toBeGreaterThanOrEqual(X0 + c - 1e-6);
      expect(x).toBeLessThanOrEqual(X0 + c + 1 + 1e-6);
      expect(z).toBeGreaterThanOrEqual(Z0 + r - 1e-6);
      expect(z).toBeLessThanOrEqual(Z0 + r + 1 + 1e-6);
      expect(side * diagSide(x, z, c, r)).toBeGreaterThanOrEqual(-1e-6);
    }
  }
});

test('area and winding preserved', () => {
  const input = mesh([BIG]);
  const out = drapeMesh(input, hilly);
  expect(Math.abs(totalArea(out) - totalArea(input))).toBeLessThan(1e-6);
  for (const [a, b, c] of triangles(out)) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    expect(ny).toBeGreaterThan(0);
  }
});

test('uv interpolated', () => {
  const out = drapeMesh(mesh([BIG]), hilly);
  for (let i = 0; i < out.positions.length / 3; i++) {
    const [x, , z] = vert(out, i);
    expect(Math.abs(out.uv[i * 2]! - x)).toBeLessThan(1e-6);
    expect(Math.abs(out.uv[i * 2 + 1]! - z)).toBeLessThan(1e-6);
  }
});

test('shared edge splits identically', () => {
  const p: V = [1.3, 0.01, 1.2];
  const q: V = [7.1, 0.01, 5.6];
  const left: V[] = [p, [2.4, 0.01, 6.9], q]; // left of p→q, counter-clockwise from above
  const right: V[] = [p, q, [6.8, 0.01, 0.4]];
  const onEdge = (m: Mesh) => {
    const keys = new Set<string>();
    for (let i = 0; i < m.positions.length / 3; i++) {
      const [x, y, z] = vert(m, i);
      const t = ((x - p[0]) * (q[0] - p[0]) + (z - p[2]) * (q[2] - p[2])) / ((q[0] - p[0]) ** 2 + (q[2] - p[2]) ** 2);
      const dist = Math.hypot(p[0] + t * (q[0] - p[0]) - x, p[2] + t * (q[2] - p[2]) - z);
      if (dist < 1e-5) keys.add(`${x},${y},${z}`); // exact float32 values
    }
    return [...keys].sort();
  };
  const a = onEdge(drapeMesh(mesh([left]), hilly));
  const b = onEdge(drapeMesh(mesh([right]), hilly));
  expect(a.length).toBeGreaterThan(10);
  expect(a).toEqual(b);
});

test('vertical kerb face follows terrain', () => {
  const z = 3.3;
  // Quad strip as built by MeshBuilder.strip: a = bottom line, b = top line.
  const a0: V = [0, 0.01, z];
  const b0: V = [0, 0.12, z];
  const a1: V = [10, 0.01, z];
  const b1: V = [10, 0.12, z];
  const input = mesh([[a0, b0, a1], [a1, b0, b1]], (p) => [p[0], p[1] < 0.05 ? 0 : 1]);
  const out = drapeMesh(input, hilly);
  expectValid(out);
  const bottom = new Set<number>();
  const top = new Set<number>();
  for (let i = 0; i < out.positions.length / 3; i++) {
    const [x, y, vz] = vert(out, i);
    expect(vz).toBeCloseTo(z, 6);
    const off = y - heightAt(hilly, x, z);
    expect(off).toBeGreaterThan(0.01 - 1e-5);
    expect(off).toBeLessThan(0.12 + 1e-5);
    expect(Math.abs(out.uv[i * 2]! - x)).toBeLessThan(1e-5);
    expect(Math.abs(out.uv[i * 2 + 1]! - (off - 0.01) / 0.11)).toBeLessThan(1e-5);
    if (Math.abs(off - 0.01) < 1e-5) bottom.add(Math.round(x * 1e5) / 1e5);
    if (Math.abs(off - 0.12) < 1e-5) top.add(Math.round(x * 1e5) / 1e5);
  }
  // Grid lines x = 0..10 and diagonal crossings (x + z or x − z integer along z = 3.3).
  const expected = new Set<number>();
  for (let k = 0; k <= 10; k++) expected.add(k);
  const frac = TERRAIN_DIAGONAL === 'x1z0-x0z1' ? 0.7 : 0.3;
  for (let k = 0; k < 10; k++) expected.add(Math.round((k + frac) * 1e5) / 1e5);
  expect([...bottom].sort((p, q) => p - q)).toEqual([...expected].sort((p, q) => p - q));
  expect([...top].sort((p, q) => p - q)).toEqual([...expected].sort((p, q) => p - q));
  // Every output triangle stays within one terrain triangle along its trace.
  for (const t of triangles(out)) {
    const xs = t.map((p) => p[0]);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    for (const e of expected) expect(e <= lo + 1e-6 || e >= hi - 1e-6).toBe(true);
  }
});

test('edge along a cell diagonal through lattice corners stays finite', () => {
  // Lattice corners (integer coordinates, origin is integer too) on one diagonal line of the active TERRAIN_DIAGONAL.
  const p: V = [1, 0.01, 4];
  const q: V = TERRAIN_DIAGONAL === 'x1z0-x0z1' ? [4, 0.01, 1] : [4, 0.01, 7];
  let tri: V[] = [p, q, [5.3, 0.01, 5.6]];
  if (xzArea(tri as [V, V, V]) < 0) tri = [p, tri[2]!, q];
  const input = mesh([tri]);
  const out = drapeMesh(input, hilly);
  expectValid(out);
  for (const n of out.positions) expect(Number.isFinite(n)).toBe(true);
  for (const n of out.uv) expect(Number.isFinite(n)).toBe(true);
  expect(Math.abs(totalArea(out) - totalArea(input))).toBeLessThan(1e-6);
  for (let i = 0; i < out.positions.length / 3; i++) {
    const [x, y, z] = vert(out, i);
    expect(Math.abs(y - 0.01 - heightAt(hilly, x, z))).toBeLessThan(1e-5);
  }
});

test('vertices are welded within each source triangle', () => {
  const out = drapeMesh(mesh([BIG]), hilly);
  const keys = new Set<string>();
  for (let i = 0; i < out.positions.length / 3; i++) keys.add(`${vert(out, i).join(',')},${out.uv[i * 2]},${out.uv[i * 2 + 1]}`);
  expect(keys.size).toBe(out.positions.length / 3);
});
