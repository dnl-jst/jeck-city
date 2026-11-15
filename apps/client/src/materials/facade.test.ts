import { describe, expect, it } from 'vitest';
import { wallEaves } from './facade';

/** Positions of vertical walls in the x/y plane from their facade uv (x = u, y = v, z = 0). */
const flatPos = (uv: number[]) => Float32Array.from(uv.flatMap((c, i) => (i % 2 === 0 ? [c] : [c, 0])));

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
    const e = wallEaves(Uint32Array.from(index), Float32Array.from(kind), Float32Array.from(uv), 12, flatPos(uv));
    expect([...e]).toEqual([10, 10, 10, 10, 8, 8, 8, 8, 8, 0, 0, 0]);
  });

  it('measures the eave from the wall bottom for walls that start above ground', () => {
    // wall standing on a lower roof: 6..9 m
    const uv = [0, 6, 4, 6, 0, 9, 4, 9];
    const e = wallEaves(Uint32Array.from([0, 1, 2, 2, 1, 3]), new Float32Array(4), Float32Array.from(uv), 4, flatPos(uv));
    expect([...e]).toEqual([9, 9, 9, 9]);
  });

  it('a gable triangle on its own surface gets its base as eave (plain plaster above the main cornice)', () => {
    // rectangle 0..15 m, 10 m wide (vertices 0..3); separate gable triangle 15..20 m on top (4..6, no shared indices)
    // whose u starts at the apex (hypot from the first polygon vertex folds: both base corners have u = 5)
    const uv = [0, 0, 10, 0, 0, 15, 10, 15, 0, 20, 5, 15, 5, 15];
    const pos = Float32Array.from([0, 0, 0, 10, 0, 0, 0, 15, 0, 10, 15, 0, 5, 20, 0, 0, 15, 0, 10, 15, 0]);
    const e = wallEaves(Uint32Array.from([0, 1, 2, 2, 1, 3, 4, 5, 6]), new Float32Array(7), Float32Array.from(uv), 7, pos);
    expect([...e]).toEqual([15, 15, 15, 15, 15, 15, 15]);
  });

  it('a pentagon gable wall (one surface) keeps the eave at its corners, not the apex', () => {
    // corners 0 / 15 m, apex 20 m, the triangle shares the top corners
    const uv = [0, 0, 10, 0, 0, 15, 10, 15, 5, 20];
    const e = wallEaves(Uint32Array.from([0, 1, 2, 2, 1, 3, 2, 3, 4]), new Float32Array(5), Float32Array.from(uv), 5, flatPos(uv));
    expect([...e]).toEqual([15, 15, 15, 15, 15]);
  });

  it('a half-hipped (trapezoid) gable on its own surface also counts as gable', () => {
    // base 10 m wide at 15 m, top 3 m wide at 18 m
    const uv = [0, 15, 10, 15, 3.5, 18, 6.5, 18];
    const e = wallEaves(Uint32Array.from([0, 1, 2, 2, 1, 3]), new Float32Array(4), Float32Array.from(uv), 4, flatPos(uv));
    expect([...e]).toEqual([15, 15, 15, 15]);
  });
});
