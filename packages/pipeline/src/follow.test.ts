import { expect, test } from 'vitest';
import { heightAt, type TerrainGrid } from '@nn/shared';
import { drapeMesh } from './drape.js';
import { followDeviation, followTerrain } from './follow.js';
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

/** Plain length split, and the pipeline's choice (8 m edges, cut further where the terrain bends > 1.5 cm). */
const CONFIGS: { name: string; maxEdge: number; tol?: number; t: TerrainGrid }[] = [
  { name: '4 m, street', maxEdge: 4, t: street },
  { name: '8 m + 1.5 cm, street', maxEdge: 8, tol: 0.015, t: street },
  { name: '8 m + 1.5 cm, hilly', maxEdge: 8, tol: 0.015, t: hilly },
];
const run = (c: (typeof CONFIGS)[number]) => followTerrain(kerb(), c.t, c.maxEdge, c.tol, 1);

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
  expect([...edges].filter(([, n]) => n !== 2)).toEqual([]);
});

test.each(CONFIGS.slice(0, 2))('coarse top surface stays within 2 cm of the 1 m drape on street-like terrain ($name)', (cfg) => {
  const m = kerb();
  const coarse = run(cfg);
  const draped = drapeMesh(m, street);
  // sampled: every draped vertex of the top surface (z > 0) against the coarse surface above it
  let max = 0;
  for (let i = 0; i < draped.positions.length / 3; i++) {
    const p = vtx(draped, i);
    if (p.z < 1e-6) continue;
    const y = coarseY(coarse, p.x, p.z);
    if (y !== undefined) max = Math.max(max, Math.abs(y - p.y));
  }
  expect(max).toBeLessThanOrEqual(0.02);
  expect(followDeviation(coarse, street).max).toBeLessThanOrEqual(0.02);
});

test('rough terrain: deviation shrinks with maxEdge (documented: 0.5 m bumps every 6 m need ~0.5 m edges)', () => {
  const dev = (e: number) => followDeviation(followTerrain(kerb(), hilly, e), hilly).max;
  const [d4, d1, d05] = [dev(4), dev(1), dev(0.5)];
  expect(d4).toBeGreaterThan(0.1); // the drape test grid is far rougher than a street
  expect(d1).toBeLessThan(d4);
  expect(d05).toBeLessThan(0.06);
});

test('tolerance refines only where the terrain bends, and terminates on rough terrain', () => {
  const plain = followTerrain(kerb(), hilly, 8);
  const tol = followTerrain(kerb(), hilly, 8, 0.015, 1);
  // measured: 0.67 m → 0.17 m; the rest sits across the 2 m wide strip, which only minEdge < 1 m would reach
  expect(followDeviation(tol, hilly).max).toBeLessThan(followDeviation(plain, hilly).max / 3);
  expect(tol.indices.length / 3).toBeLessThan(3000); // bounded by minEdge, no runaway splitting
  // on smooth street terrain it adds little over the plain 8 m split
  expect(followTerrain(kerb(), street, 8, 0.015, 1).indices.length / 3).toBeLessThan(2 * followTerrain(kerb(), street, 8).indices.length / 3);
});

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
