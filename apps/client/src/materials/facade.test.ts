import { describe, expect, it } from 'vitest';
import { wallEaves } from './facade';

describe('wallEaves', () => {
  it('gives every wall vertex the eave height of its wall surface, roofs 0', () => {
    // wall A: rectangle 0..10 m (two triangles sharing vertices 1 and 2)
    // wall B: gable wall, corners at 0 / 8 m, apex at 12 m
    // vertices 9..11: one roof triangle
    const uv = [
      0, 0, 5, 0, 0, 10, 5, 10, // A: 0..3
      0, 0, 6, 0, 0, 8, 6, 8, 3, 12, // B: 4..8
      0, 0, 1, 0, 0, 1, // roof: 9..11
    ];
    const kind = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1];
    const index = [0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 6, 7, 8, 9, 10, 11];
    const e = wallEaves(Uint32Array.from(index), Float32Array.from(kind), Float32Array.from(uv), 12);
    expect([...e]).toEqual([10, 10, 10, 10, 8, 8, 8, 8, 8, 0, 0, 0]);
  });

  it('measures the eave from the wall bottom for walls that start above ground', () => {
    // wall standing on a lower roof: 6..9 m
    const e = wallEaves(Uint32Array.from([0, 1, 2, 2, 1, 3]), new Float32Array(4), Float32Array.from([0, 6, 4, 6, 0, 9, 4, 9]), 4);
    expect([...e]).toEqual([9, 9, 9, 9]);
  });
});
