import { expect, test } from 'vitest';
import { Matrix4 } from 'three';
import type { TerrainGrid } from '@nn/shared';
import { LAMP_LIGHT_Y, lampMatrix, signCorners, treeMatrix } from './props';

/** 101 × 101 m grid from (0, 0) with h = 0.1·x. */
function slope(): TerrainGrid {
  const cols = 101, rows = 101;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 0.1 * c;
  return { x0: 0, z0: 0, cols, rows, datum: 0, heights };
}

test('lamps and trees sit on terrain', () => {
  const t = slope();
  const m = new Matrix4();
  const lamp = lampMatrix(t, 20, 30, m);
  expect(lamp.light.y).toBeCloseTo(2 + LAMP_LIGHT_Y, 5);
  expect(m.elements[12]).toBeCloseTo(20);
  expect(m.elements[13]).toBeCloseTo(2.0, 5);
  expect(m.elements[14]).toBeCloseTo(30);
  treeMatrix(t, 55, 10, m);
  expect(m.elements[13]).toBeCloseTo(5.5, 5);
});

test('sign uses sign.y', () => {
  const corners = signCorners({ x: 10, y: 47.5, z: 3, heading: 0.7, width: 4 }, 2, 0.6);
  const ys = corners.map((c) => c[1]);
  expect(Math.min(...ys)).toBeCloseTo(47.2);
  expect(Math.max(...ys)).toBeCloseTo(47.8);
  expect(ys.reduce((a, b) => a + b) / 4).toBeCloseTo(47.5);
});
