import type { TerrainGrid } from '@nn/shared';

// Test helpers for the terrain tests (not used by the pipeline).

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random grid with smooth hills plus noise; heights in roughly [-20, 280]. */
export function randomGrid(cols: number, rows: number, seed: number, x0 = -1234, z0 = 567): TerrainGrid {
  const rand = rng(seed);
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) heights[r * cols + c] = 120 + 100 * Math.sin(c / 37) * Math.cos(r / 23) + 40 * rand() - 20;
  return { x0, z0, cols, rows, datum: 42.5, heights };
}
