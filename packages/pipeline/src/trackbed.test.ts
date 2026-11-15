import { describe, expect, it } from 'vitest';
import { trackBed } from './trackbed';

const W = 0.07, G = 1.435;
/** Two straight rails along +x (track centre z = 0), as the pipeline builds them: quad strips, v 0 → W across. */
function track(): { positions: Float32Array; uv: Float32Array; index: Uint32Array } {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const c of [-G / 2, G / 2]) {
    for (let i = 0; i < 3; i++) {
      const base = pos.length / 3;
      // offsetLine: positive offset is the right-hand side of travel (+x travel → +z)
      pos.push(i * 5, 0.02, c - W / 2, i * 5, 0.02, c + W / 2);
      uv.push(i * 5, 0, i * 5, W);
      if (i > 0) idx.push(base - 2, base - 1, base, base, base - 1, base + 1);
    }
  }
  return { positions: Float32Array.from(pos), uv: Float32Array.from(uv), index: Uint32Array.from(idx) };
}

describe('trackBed', () => {
  it('widens each rail into a band from 0.12 m outside the rail to the track centre', () => {
    const t = track();
    const bed = trackBed(t.positions, t.uv, t.index);
    expect(bed.index).toEqual(t.index);
    const z = (i: number) => bed.positions[i * 3 + 2]!;
    const across = (i: number) => bed.uv[i * 2 + 1]!;
    // rail at z = -0.7175: vertex 0 is its outer edge, vertex 1 its inner (centre-side) edge
    expect(z(0)).toBeCloseTo(-G / 2 - 0.12, 3);
    expect(z(1)).toBeCloseTo(-G / 2 + 0.74, 3);
    expect([across(0), across(1)]).toEqual([expect.closeTo(-0.12, 3), expect.closeTo(0.74, 3)]);
    // rail at z = +0.7175: vertex 6 (v = 0) faces the centre
    expect(z(6)).toBeCloseTo(G / 2 - 0.74, 3);
    expect(z(7)).toBeCloseTo(G / 2 + 0.12, 3);
    for (let i = 0; i < 12; i++) expect(bed.positions[i * 3 + 1]).toBeCloseTo(0.016, 4);
    expect(bed.uv[0]).toBe(0); // u kept
  });

  it('falls back to a symmetric band for a rail without a partner', () => {
    const t = track();
    const one = trackBed(t.positions.slice(0, 18), t.uv.slice(0, 12), t.index.slice(0, 12));
    expect(one.positions[2]).toBeCloseTo(-G / 2 - 0.4, 3);
    expect(one.positions[5]).toBeCloseTo(-G / 2 + 0.4, 3);
  });
});
