import type { TerrainGrid } from '@nn/shared';

/**
 * 400 × 300 m: banks at y = 6, a river 100 m wide (x 150..250) running along z with its surface at y = 0 (±0.2 noise),
 * banks rising 6 m over 10 m; a flat meadow at y = 0.3 behind a dike at x < 40 (lower than the tolerance, not connected).
 */
export function riverTerrain(): TerrainGrid {
  const cols = 401, rows = 301;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = Math.max(150 - c, c - 250, 0); // metres from the water's edge
      let h = Math.min(6, d * 0.6) + (d === 0 ? 0.2 * Math.sin(c * 1.7 + r * 0.9) : 0);
      if (c < 40) h = 0.3;
      heights[r * cols + c] = h;
    }
  }
  return { x0: 0, z0: 0, cols, rows, datum: 40, heights };
}
export const centreLine = [{ x: 200, z: -50 }, { x: 200, z: 350 }];
