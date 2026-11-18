import { describe, expect, test } from 'vitest';
import { boundaryCurtain } from './boundary-glow';

describe('boundaryCurtain', () => {
  // a 10 m square ring, on a slope y = x / 10
  const ring = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
  const g = boundaryCurtain(ring, (x) => x / 10, 4, 4);
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');

  test('pieces at most `step` long, closed back onto the first column', () => {
    // 4 edges of 10 m → 3 pieces each, plus the closing column; two vertices (foot, top) per column
    expect(pos.count).toBe((4 * 3 + 1) * 2);
    expect(g.getIndex()!.count).toBe(4 * 3 * 6);
    const last = pos.count - 2;
    expect([pos.getX(last), pos.getZ(last)]).toEqual([0, 0]);
    expect(uv.getX(last)).toBeCloseTo(40); // u: metres along the ring
  });

  test('follows the terrain: foot just under the ground, top `height` above it', () => {
    for (let c = 0; c < pos.count / 2; c++) {
      const ground = pos.getX(2 * c) / 10;
      expect(pos.getY(2 * c)).toBeLessThan(ground);
      expect(pos.getY(2 * c + 1)).toBeCloseTo(ground + 4);
      expect(uv.getY(2 * c + 1)).toBe(1);
    }
  });

  test('repeated closing point adds no zero-length piece', () => {
    const closed = boundaryCurtain(new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]), () => 0, 4, 4);
    expect(closed.getAttribute('position').count).toBe(pos.count);
  });
});
