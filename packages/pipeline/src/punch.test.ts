import { expect, test } from 'vitest';
import { meshCovers, punchMesh } from './punch.js';

const square = () => ({
  positions: Float32Array.from([0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10]),
  uv: Float32Array.from([0, 0, 10, 0, 10, 10, 0, 10]),
  indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
});

test('punchMesh cuts a hole to within its fineness and leaves the rest', () => {
  const hole = [{ x: 4, z: 4 }, { x: 6, z: 4 }, { x: 6, z: 7 }, { x: 4, z: 7 }];
  const m = punchMesh(square(), [hole]);
  let area = 0;
  const covers = meshCovers(m, 2);
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    const p = m.positions;
    area += Math.abs((p[b]! - p[a]!) * (p[c + 2]! - p[a + 2]!) - (p[c]! - p[a]!) * (p[b + 2]! - p[a + 2]!)) / 2;
    expect(p[a + 1]).toBe(1);
  }
  expect(area).toBeGreaterThan(100 - 6 - 1.5);
  expect(area).toBeLessThan(100 - 6 + 1.5);
  expect(covers({ x: 5, z: 5.5 })).toBe(false);
  expect(covers({ x: 4.5, z: 6.5 })).toBe(false);
  expect(covers({ x: 3.5, z: 5 })).toBe(true);
  expect(covers({ x: 9, z: 1 })).toBe(true);
  // new vertices carry interpolated attributes
  for (let v = 0; v < m.positions.length / 3; v++) {
    expect(m.uv[v * 2]).toBeCloseTo(m.positions[v * 3]!, 5);
    expect(m.uv[v * 2 + 1]).toBeCloseTo(m.positions[v * 3 + 2]!, 5);
  }
});

test('punchMesh returns the mesh itself when no hole is near', () => {
  const m = square();
  expect(punchMesh(m, [[{ x: 50, z: 50 }, { x: 52, z: 50 }, { x: 52, z: 52 }]])).toBe(m);
});
