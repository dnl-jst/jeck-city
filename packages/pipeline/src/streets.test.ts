import { expect, test } from 'vitest';
import { loadFixture } from './fixture.js';
import { buildStreetGeometry, type Mesh } from './streets.js';
import { wgs84ToLocal } from '@nn/shared';

const f = loadFixture();
const g = buildStreetGeometry(f);
const verts = (m: Mesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => ({ x: m.positions[i * 3]!, y: m.positions[i * 3 + 1]!, z: m.positions[i * 3 + 2]! }));
const crossing = wgs84ToLocal(50.9631, 6.952);

test('every mesh is consistent: indices in range, uv per vertex', () => {
  for (const m of Object.values(g)) {
    expect(m.positions.length % 3).toBe(0);
    expect(m.uv.length / 2).toBe(m.positions.length / 3);
    expect(m.indices.length % 3).toBe(0);
    expect(m.indices.length).toBeGreaterThan(0);
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
  }
});

test('road ribbons lie at y=0.01 plus at most 0.005', () => {
  for (const v of verts(g.road)) {
    expect(v.y).toBeGreaterThanOrEqual(0.01 - 1e-6);
    expect(v.y).toBeLessThanOrEqual(0.015 + 1e-6);
  }
});

test('all ribbon/polygon triangles face up (horizontal meshes)', () => {
  for (const m of [g.road, g.sidewalk, g.tram, g.green, g.squares]) {
    for (let i = 0; i < m.indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.indices[i + k]! * 3);
      const ux = m.positions[b!]! - m.positions[a!]!, uz = m.positions[b! + 2]! - m.positions[a! + 2]!;
      const vx = m.positions[c!]! - m.positions[a!]!, vz = m.positions[c! + 2]! - m.positions[a! + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThanOrEqual(0);
    }
  }
});

test('curb is 0.12 m high, sidewalk at 0.12, none within 5 m of the junction', () => {
  const curb = verts(g.curb);
  expect(Math.max(...curb.map((v) => v.y))).toBeCloseTo(0.12, 5);
  expect(verts(g.sidewalk).every((v) => Math.abs(v.y - 0.12) < 1e-6)).toBe(true);
  for (const v of [...curb, ...verts(g.sidewalk)]) {
    expect(Math.hypot(v.x - crossing.x, v.z - crossing.z)).toBeGreaterThanOrEqual(5 - 1e-3);
  }
  // but kerbs exist further out
  expect(curb.some((v) => Math.hypot(v.x - crossing.x, v.z - crossing.z) > 20)).toBe(true);
});

test('footways get no kerb or sidewalk', () => {
  const foot = wgs84ToLocal(50.9628, 6.9515);
  const near = (v: { x: number; z: number }) => Math.hypot(v.x - foot.x, v.z - foot.z) < 4;
  expect(verts(g.curb).some(near)).toBe(false);
  expect(verts(g.sidewalk).some(near)).toBe(false);
});

test('tram has two rails with 1.435 m gauge', () => {
  const t = wgs84ToLocal(50.9636, 6.952);
  const zs = verts(g.tram).filter((v) => Math.abs(v.x - t.x) < 0.5).map((v) => v.z);
  const lo = zs.filter((z) => z < t.z), hi = zs.filter((z) => z > t.z);
  expect(lo.length).toBeGreaterThan(0);
  expect(hi.length).toBeGreaterThan(0);
  const centre = (a: number[]) => (Math.min(...a) + Math.max(...a)) / 2;
  expect(centre(hi) - centre(lo)).toBeCloseTo(1.435, 2);
});

test('uv: u runs in metres along the road', () => {
  const m = g.road;
  const maxU = Math.max(...Array.from({ length: m.uv.length / 2 }, (_, i) => m.uv[i * 2]!));
  expect(maxU).toBeGreaterThan(190); // Querstraße is ~200 m
  expect(maxU).toBeLessThan(210);
});
