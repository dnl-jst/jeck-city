import { describe, expect, test } from 'vitest';
import { HORN_MIN, HornState, synthHorn } from './horn';

describe('horn', () => {
  test('1 s seamless loop, loud but not clipping', () => {
    const s = synthHorn(48000);
    expect(s.length).toBe(48000);
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0.9, 3);
    // the jump across the seam is no bigger than between ordinary neighbouring samples
    const step = Math.max(...Array.from({ length: 1000 }, (_, i) => Math.abs(s[i + 1]! - s[i]!)));
    expect(Math.abs(s[0]! - s[s.length - 1]!)).toBeLessThanOrEqual(step * 1.01);
  });

  test('sounds while held, a tap lasts HORN_MIN, then stops', () => {
    const h = new HornState();
    expect(h.update(false, 0.016)).toBe(false);
    expect(h.update(true, 0.016)).toBe(true);
    expect(h.update(false, HORN_MIN / 2)).toBe(true);
    expect(h.update(false, HORN_MIN)).toBe(false);
  });
});
