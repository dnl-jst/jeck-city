import { expect, test } from 'vitest';
import type { TerrainGrid } from '@nn/shared';
import { applyTerrainCuts, CUT_MARGIN } from './terraincut.js';

const flat = (h: number): TerrainGrid => ({ x0: 0, z0: 0, cols: 12, rows: 12, datum: 0, heights: new Float32Array(144).fill(h) });
const at = (t: TerrainGrid, x: number, z: number) => t.heights[z * t.cols + x]!;
// a 4 m × 4 m cut (x 4..8, z 4..8) as two triangles; a ramp falling from y 1.0 at x 4 to y 0.2 at x 8
const ramp = Float32Array.from([4, 1.0, 4, 8, 0.2, 4, 8, 0.2, 8, 4, 1.0, 4, 8, 0.2, 8, 4, 1.0, 8]);

test('terrain under a cut ends just below it; within 1 m outside it takes the nearest edge; beyond it is untouched', () => {
  const t = flat(2.0);
  const n = applyTerrainCuts(t, ramp);
  expect(at(t, 4, 6)).toBeCloseTo(1.0 - CUT_MARGIN, 5);
  expect(at(t, 6, 6)).toBeCloseTo(0.6 - CUT_MARGIN, 5);
  expect(at(t, 8, 6)).toBeCloseTo(0.2 - CUT_MARGIN, 5);
  expect(at(t, 9, 6)).toBeCloseTo(0.2 - CUT_MARGIN, 5); // 1 m east of the low edge
  expect(at(t, 3, 6)).toBeCloseTo(1.0 - CUT_MARGIN, 5); // 1 m west of the high edge
  expect(at(t, 10, 6)).toBe(2.0);
  expect(at(t, 6, 2)).toBe(2.0);
  expect(n).toBe(7 * 7 - 4); // x 3..9 × z 3..9 without the four corners (√2 m from the cut)
});

test('a cut never raises the terrain', () => {
  const t = flat(0.0);
  expect(applyTerrainCuts(t, ramp)).toBe(0);
  expect(Array.from(t.heights).every((h) => h === 0)).toBe(true);
});
