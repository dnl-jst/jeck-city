import { expect, test } from 'vitest';
import { triangulatePolygon3d, type Triangulated } from './triangulate.js';

function triangleArea(t: Triangulated): number {
  let sum = 0;
  for (let i = 0; i < t.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => t.indices[i + k]! * 3) as [number, number, number];
    const p = (i: number) => t.positions[i]!;
    const ux = p(b) - p(a), uy = p(b + 1) - p(a + 1), uz = p(b + 2) - p(a + 2);
    const vx = p(c) - p(a), vy = p(c + 1) - p(a + 1), vz = p(c + 2) - p(a + 2);
    sum += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return sum;
}

test('vertical wall triangulates to 2 triangles with area preserved', () => {
  const t = triangulatePolygon3d([[0, 0, 0], [10, 0, 0], [10, 0, 9], [0, 0, 9]], [])!;
  expect(t.indices).toHaveLength(6);
  expect(triangleArea(t)).toBeCloseTo(90, 3);
});

test('polygon with hole', () => {
  const t = triangulatePolygon3d(
    [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
    [[[4, 4, 0], [6, 4, 0], [6, 6, 0], [4, 6, 0]]],
  )!;
  expect(triangleArea(t)).toBeCloseTo(96, 3);
});

test('degenerate polygons return null', () => {
  expect(triangulatePolygon3d([[0, 0, 0], [1, 0, 0]], [])).toBeNull();
  expect(triangulatePolygon3d([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [])).toBeNull();
});
