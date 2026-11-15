import { expect, test } from 'vitest';
import { needsTreeRebuild, TREE_REBUILD_MOVE, TREE_RENDER_RADIUS, TREE_SHADOW_RADIUS, treeSets } from './props';

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
