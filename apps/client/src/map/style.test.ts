import { describe, expect, it } from 'vitest';
import { roadStyle } from './style';

describe('roadStyle', () => {
  it('ranks important roads before minor ones', () => {
    expect(roadStyle('primary').rank).toBeLessThan(roadStyle('residential').rank);
    expect(roadStyle('residential').rank).toBeLessThan(roadStyle('footway').rank);
  });
  it('grows monotonically with scale and stays visible when zoomed out', () => {
    for (const kind of ['primary', 'residential', 'footway']) {
      const w = roadStyle(kind).widthPx;
      expect(w(0.3)).toBeGreaterThanOrEqual(1);
      let prev = 0;
      for (const s of [0.1, 0.3, 0.7, 1, 2, 4]) {
        expect(w(s)).toBeGreaterThanOrEqual(prev);
        prev = w(s);
      }
    }
  });
  it('treats unknown kinds like residential', () => {
    const a = roadStyle('bogus');
    const b = roadStyle('residential');
    expect(a.rank).toBe(b.rank);
    expect(a.color).toBe(b.color);
    expect(a.widthPx(1)).toBe(b.widthPx(1));
  });
});
