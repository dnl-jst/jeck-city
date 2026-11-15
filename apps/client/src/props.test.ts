import { expect, test } from 'vitest';
import { Matrix4 } from 'three';
import type { TerrainGrid } from '@nn/shared';
import { LAMP_LIGHT_Y, lampMatrix, needsTreeRebuild, signCorners, TREE_REBUILD_MOVE, TREE_RENDER_RADIUS, TREE_SHADOW_RADIUS, treeMatrix, treeSets } from './props';

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

test('treeSets: trees within 80 m cast shadows, 80–250 m are drawn without, beyond and outside loaded chunks not at all', () => {
  expect([TREE_RENDER_RADIUS, TREE_SHADOW_RADIUS]).toEqual([250, 80]);
  const trees: [number, number][] = [[0, 0], [80, 0], [0, -80.5], [176, 176], [177, 178], [-50, 10]];
  expect(treeSets(trees, 0, 0)).toEqual({ near: [0, 1, 5], far: [2, 3] });
  expect(treeSets(trees, 0, 0, (x) => x >= 0)).toEqual({ near: [0, 1], far: [2, 3] }); // -50: chunk not loaded
  expect(treeSets(trees, 0, 0, () => true, 60, 100)).toEqual({ near: [0, 5], far: [1, 2] });
});

test('needsTreeRebuild: never built, or the camera moved more than 20 m since', () => {
  expect(TREE_REBUILD_MOVE).toBe(20);
  expect(needsTreeRebuild(null, 0, 0)).toBe(true);
  expect(needsTreeRebuild({ x: 0, z: 0 }, 12, 16)).toBe(false);
  expect(needsTreeRebuild({ x: 0, z: 0 }, 12, 16.1)).toBe(true);
});
