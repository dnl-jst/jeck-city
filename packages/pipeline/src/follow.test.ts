import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { heightAt, type TerrainGrid } from '@nn/shared';
import { drapeMesh } from './drape.js';
import { followDeviation, followTerrain, triangleDeviation } from './follow.js';
import type { Mesh } from './streets.js';

function grid(x0: number, z0: number, cols: number, rows: number, f: (x: number, z: number) => number): TerrainGrid {
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(x0 + c, z0 + r);
  return { x0, z0, cols, rows, datum: 0, heights };
}

/** Street-like terrain: a 3 % slope with gentle 0.5 m swells (wavelength ~60 m), like the smoothed DGM in the city. */
const street = grid(-5, -10, 130, 30, (x, z) => 0.03 * x + 0.5 * Math.sin(x / 10) * Math.cos(z / 12));
/** The drape tests' hilly grid: 0.5 m bumps every ~6 m — far rougher than any street. */
const hilly = grid(-5, -10, 130, 30, (x, z) => 0.3 * x + 0.2 * z + 0.5 * Math.sin(x) * Math.cos(z));

/** A kerb like streets.ts builds it: a 100 m strip of quads (top at y 0.12) plus the vertical face towards the road. */
function kerb(): Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(0, 0, 0, 1, 1, 0, 1, 1);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
  // top: x 0 → 100 in segments of 25 m, z 0 … 2.15 (curb + sidewalk); a, b, a', b' counter-clockwise from above
  for (let x = 0; x < 100; x += 25) quad([x, 0.12, 0], [x, 0.12, 2.15], [x + 25, 0.12, 0], [x + 25, 0.12, 2.15]);
  // vertical face at z = 0, bottom 0.01, top 0.12
  for (let x = 0; x < 100; x += 25) quad([x, 0.01, 0], [x, 0.12, 0], [x + 25, 0.01, 0], [x + 25, 0.12, 0]);
  return { positions: Float32Array.from(pos), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

/** Plain length split, and the pipeline's choice (8 m edges, adaptive to 2 cm, edges down to 5 cm). */
const CONFIGS: { name: string; maxEdge: number; tol?: number; t: TerrainGrid }[] = [
  { name: '4 m, street', maxEdge: 4, t: street },
  { name: '8 m + 2 cm, street', maxEdge: 8, tol: 0.02, t: street },
  { name: '8 m + 2 cm, hilly', maxEdge: 8, tol: 0.02, t: hilly },
];
const run = (c: (typeof CONFIGS)[number]) => followTerrain(kerb(), c.t, c.maxEdge, c.tol, 0.05);
/** float32 output positions move the measured deviation by a few µm */
const F32 = 1e-5;

const vtx = (m: Mesh, i: number) => ({ x: m.positions[i * 3]!, y: m.positions[i * 3 + 1]!, z: m.positions[i * 3 + 2]! });

test.each(CONFIGS)('every vertex lies at its offset above the terrain ($name)', (cfg) => {
  const out = run(cfg);
  const street = cfg.t;
  expect(out.uv.length / 2).toBe(out.positions.length / 3);
  for (let i = 0; i < out.positions.length / 3; i++) {
    const p = vtx(out, i);
    const off = p.y - heightAt(street, p.x, p.z);
    // top vertices: 0.12; face vertices: on the face between 0.01 and 0.12 (edge midpoints interpolate the offset)
    if (p.z > 1e-9) expect(off).toBeCloseTo(0.12, 5);
    else expect(off).toBeGreaterThanOrEqual(0.01 - 1e-5), expect(off).toBeLessThanOrEqual(0.12 + 1e-5);
  }
  // corners keep their exact offsets
  const corner = [...Array(out.positions.length / 3).keys()].map((i) => vtx(out, i)).find((p) => p.x === 50 && p.z === 0 && p.y < heightAt(street, 50, 0) + 0.05)!;
  expect(corner.y - heightAt(street, 50, 0)).toBeCloseTo(0.01, 5);
});

test.each(CONFIGS)('no edge is longer than maxEdge in xz, area and winding kept ($name)', (cfg) => {
  const out = run(cfg);
  let area = 0;
  for (let i = 0; i < out.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vtx(out, out.indices[i + k]!)) as [ReturnType<typeof vtx>, ReturnType<typeof vtx>, ReturnType<typeof vtx>];
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThanOrEqual(cfg.maxEdge + 1e-9);
    const s = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    expect(s).toBeGreaterThanOrEqual(-1e-9);
    // top pieces never collapse onto a line (a zip running past the end of its rail did that, leaving holes)
    if (Math.max(a.z, b.z, c.z) > 1e-6) expect(s).toBeGreaterThan(1e-6);
    area += s / 2;
  }
  expect(area).toBeCloseTo(100 * 2.15, 3);
});

test('triangle count stays linear in the length (no n² blow-up on long thin quads)', () => {
  for (const maxEdge of [4, 2]) {
    const out = followTerrain(kerb(), street, maxEdge);
    let area = 0;
    for (let i = 0; i < out.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => vtx(out, out.indices[i + k]!)) as [ReturnType<typeof vtx>, ReturnType<typeof vtx>, ReturnType<typeof vtx>];
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThanOrEqual(maxEdge + 1e-9);
      const s = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      expect(s).toBeGreaterThanOrEqual(-1e-9); // input top is counter-clockwise from above: no flipped piece
      area += s / 2;
    }
    expect(area).toBeCloseTo(100 * 2.15, 3); // float32 positions
    // a 100 m ribbon needs ~2·100/maxEdge pieces per side; n² subdivision of 25 m quads would need far more
    expect(out.indices.length / 3).toBeLessThan(2 * 2 * (100 / maxEdge) * 4);
  }
});

test.each(CONFIGS)('shared edges are split identically on both sides, no T-junctions ($name)', (cfg) => {
  const out = run(cfg);
  const key = (p: ReturnType<typeof vtx>) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`;
  const edges = new Map<string, number>();
  const onOutline = (p: ReturnType<typeof vtx>, q: ReturnType<typeof vtx>) =>
    [0, 2.15].some((z) => Math.abs(p.z - z) < 1e-6 && Math.abs(q.z - z) < 1e-6) || [0, 100].some((x) => Math.abs(p.x - x) < 1e-6 && Math.abs(q.x - x) < 1e-6);
  for (let i = 0; i < out.indices.length; i += 3) {
    const v = [0, 1, 2].map((k) => vtx(out, out.indices[i + k]!));
    const [a, b, c] = v as [ReturnType<typeof vtx>, ReturnType<typeof vtx>, ReturnType<typeof vtx>];
    if (Math.abs((b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z)) < 1e-9) continue; // vertical face
    for (let k = 0; k < 3; k++) {
      const p = v[k]!, q = v[(k + 1) % 3]!;
      if (onOutline(p, q)) continue;
      const e = [key(p), key(q)].sort().join('|');
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  expect(edges.size).toBeGreaterThan(0);
  expect([...edges].filter(([, n]) => n !== 2).slice(0, 4)).toEqual([]);
});

test.each(CONFIGS)('coarse top surface stays within 2 cm of the 1 m drape ($name)', (cfg) => {
  if (cfg.t === hilly && cfg.tol === undefined) return; // plain splits cannot follow the hilly grid
  const m = kerb();
  const coarse = run(cfg);
  const street = cfg.t;
  const draped = drapeMesh(m, street);
  // sampled: every draped vertex of the top surface (z > 0) against the coarse surface above it
  let max = 0;
  for (let i = 0; i < draped.positions.length / 3; i++) {
    const p = vtx(draped, i);
    if (p.z < 1e-6) continue;
    const y = coarseY(coarse, p.x, p.z);
    if (y !== undefined) max = Math.max(max, Math.abs(y - p.y));
  }
  expect(max).toBeLessThanOrEqual(0.02 + F32);
  expect(followDeviation(coarse, street).max).toBeLessThanOrEqual(0.02 + F32);
});

test('rough terrain: plain length splits cannot follow it (why the adaptive pass exists)', () => {
  const dev = (e: number) => followDeviation(followTerrain(kerb(), hilly, e), hilly).max;
  const [d4, d1, d05] = [dev(4), dev(1), dev(0.5)];
  expect(d4).toBeGreaterThan(0.1); // the drape test grid is far rougher than a street
  expect(d1).toBeLessThan(d4);
  expect(d05).toBeGreaterThan(0.02); // even 0.5 m edges miss 2 cm on 0.5 m bumps every 6 m
});

test('adaptive pass: refines only where needed, bounded on rough terrain', () => {
  const plain = followTerrain(kerb(), hilly, 8);
  const adaptive = followTerrain(kerb(), hilly, 8, 0.02, 0.05);
  expect(followDeviation(adaptive, hilly).max).toBeLessThanOrEqual(0.02 + F32);
  expect(adaptive.indices.length / 3).toBeGreaterThan(plain.indices.length / 3);
  expect(adaptive.indices.length / 3).toBeLessThan(20000); // no runaway splitting
  // on smooth street terrain it adds little over the plain 8 m split
  expect(followTerrain(kerb(), street, 8, 0.02, 0.05).indices.length / 3).toBeLessThan(2 * followTerrain(kerb(), street, 8).indices.length / 3);
  // minEdge bounds it: with a 1 m floor the 2 cm cannot be reached here, and it still terminates
  expect(followDeviation(followTerrain(kerb(), hilly, 8, 0.02, 1), hilly).max).toBeGreaterThan(0.02);
});

test('triangleDeviation is the exact maximum over the triangle (dense sampling never exceeds it)', () => {
  const tri = [[1.3, 2.7], [9.6, 4.1], [4.2, 11.8]] as const;
  const h = tri.map(([x, z]) => heightAt(hilly, x, z));
  const d = triangleDeviation(hilly, tri[0][0], tri[0][1], h[0]!, tri[1][0], tri[1][1], h[1]!, tri[2][0], tri[2][1], h[2]!);
  let dense = 0;
  const N = 300;
  for (let i = 0; i <= N; i++) for (let j = 0; i + j <= N; j++) {
    const [w0, w1] = [i / N, j / N], w2 = 1 - w0 - w1;
    const x = w0 * tri[0][0] + w1 * tri[1][0] + w2 * tri[2][0], z = w0 * tri[0][1] + w1 * tri[1][1] + w2 * tri[2][1];
    dense = Math.max(dense, Math.abs(w0 * h[0]! + w1 * h[1]! + w2 * h[2]! - heightAt(hilly, x, z)));
  }
  expect(dense).toBeLessThanOrEqual(d.dev + 1e-9);
  expect(dense).toBeGreaterThan(d.dev - 0.01);
  // a kerb face whose corners float32 rounding moved off their line counts as vertical, not as a wild plane
  expect(triangleDeviation(hilly, 0, 0, 0, 1, 1.00001, 5, 2, 2, 0).dev).toBe(0);
});

/** A street-corner-like mesh: 24 kerb strips at different angles and widths, sharing no vertices (as on the hilly grid). */
function strips(): Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < 24; i++) {
    const a = -0.5 + i / 23, len = 18 + (i % 5) * 4, w = 0.3 + (i % 3) * 1.1;
    const x0 = 5 + (i % 6) * 18, z0 = -6 + Math.floor(i / 6) * 5;
    const dx = Math.cos(a), dz = Math.sin(a), nx = -dz * w, nz = dx * w;
    const base = pos.length / 3;
    for (let k = 0; k <= 3; k++) {
      const x = x0 + (dx * len * k) / 3, z = z0 + (dz * len * k) / 3;
      pos.push(x, 0.12, z, x + nx, 0.12, z + nz);
      uv.push(k, 0, k, 1);
    }
    for (let k = 0; k < 3; k++) idx.push(base + 2 * k, base + 2 * k + 1, base + 2 * k + 2, base + 2 * k + 2, base + 2 * k + 1, base + 2 * k + 3);
  }
  return { positions: Float32Array.from(pos), uv: Float32Array.from(uv), indices: Uint32Array.from(idx) };
}

test('followTerrain output is frozen: byte for byte what it was before its rounds moved to typed arrays', () => {
  const digest = (m: Mesh) => {
    const h = createHash('sha256');
    for (const a of [m.positions, m.uv, m.indices]) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    return `${m.indices.length / 3}:${h.digest('hex').slice(0, 16)}`;
  };
  const got = [
    ...CONFIGS.map(run),
    followTerrain(strips(), hilly, 8, 0.02, 0.05),
    followTerrain(strips(), street, 8, 0.02, 0.05),
    followTerrain(strips(), hilly, 3),
  ].map(digest);
  expect(got).toEqual(FROZEN);
});
/** triangles:digest of each case above, from the implementation before (commit 029c953). */
const FROZEN = ['240:9f8642e2f2949585', '154:b7d44f6f7e5fc9b9', '10184:11c0bedb70eda95a', '30331:eb778fe336f40b3a', '344:e84e78a20831a250', '1044:f5ed20a9e6f6b24a'];

/** y of the (upward-facing) coarse triangle containing (x, z) in xz, undefined if none. */
function coarseY(m: Mesh, x: number, z: number): number | undefined {
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vtx(m, m.indices[i + k]!)) as [ReturnType<typeof vtx>, ReturnType<typeof vtx>, ReturnType<typeof vtx>];
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-9) continue;
    const w0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
    const w1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
    return w0 * a.y + w1 * b.y + w2 * c.y;
  }
  return undefined;
}
