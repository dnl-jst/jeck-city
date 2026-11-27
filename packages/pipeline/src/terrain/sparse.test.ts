import { describe, expect, it } from 'vitest';
import { SparseRaster } from './sparse.js';

describe('SparseRaster', () => {
  it('unwritten cells read the fill value; has() is false until the page exists', () => {
    for (const fill of [NaN, Infinity, -Infinity, 0, 7.5]) {
      const s = new SparseRaster(600, 600, (n) => new Float32Array(n), fill);
      expect(Object.is(s.get(10, 10), fill)).toBe(true);
      expect(s.has(10, 10)).toBe(false);
      expect([...s.pages()]).toEqual([]);
      s.set(300, 10, 1.25);
      expect(s.get(300, 10)).toBe(1.25);
      // the rest of the page exists now and holds the fill value
      expect(s.has(257, 0)).toBe(true);
      expect(Object.is(s.get(257, 0), Math.fround(fill))).toBe(true);
      // other pages still do not exist
      expect(s.has(10, 10)).toBe(false);
      expect(s.has(300, 300)).toBe(false);
      expect(Object.is(s.get(300, 300), fill)).toBe(true);
    }
    const m = new SparseRaster(10, 10, (n) => new Uint8Array(n), 0);
    expect(m.get(3, 3)).toBe(0);
    m.set(3, 3, 1);
    expect(m.get(3, 3)).toBe(1);
    expect(m.get(4, 3)).toBe(0);
  });

  it('stores values as the page type gives them (Float32 rounding)', () => {
    const s = new SparseRaster(4, 4, (n) => new Float32Array(n), 0);
    s.set(1, 1, 0.1);
    expect(s.get(1, 1)).toBe(Math.fround(0.1));
  });

  it('cells on page borders and in the last partial page round-trip', () => {
    const cols = 300, rows = 270;
    const s = new SparseRaster(cols, rows, (n) => new Float32Array(n), NaN);
    const v = (c: number, r: number) => r * 1000 + c;
    const cells: [number, number][] = [];
    for (const c of [0, 1, 254, 255, 256, 257, 298, 299]) for (const r of [0, 1, 254, 255, 256, 257, 268, 269]) cells.push([c, r]);
    for (const [c, r] of cells) s.set(c, r, v(c, r));
    for (const [c, r] of cells) expect(s.get(c, r)).toBe(v(c, r));
    expect(Number.isNaN(s.get(2, 2))).toBe(true);
    expect(s.cols).toBe(cols);
    expect(s.rows).toBe(rows);
    expect(() => s.set(300, 0, 1)).toThrow(RangeError);
    expect(() => s.get(0, 270)).toThrow(RangeError);
    expect(() => s.has(-1, 0)).toThrow(RangeError);
  });

  it('pages() lists allocated pages in row-major page order', () => {
    const s = new SparseRaster(1000, 1000, (n) => new Uint8Array(n), 0);
    s.set(900, 900, 1); // page (3, 3)
    s.set(0, 600, 2); // page (0, 2)
    s.set(600, 0, 3); // page (2, 0)
    s.set(300, 0, 4); // page (1, 0)
    s.set(10, 700, 5); // page (0, 2) again
    const pages = [...s.pages()].map(([pc, pr, data]) => [pc, pr, data.length]);
    expect(pages).toEqual([[1, 0, 65536], [2, 0, 65536], [0, 2, 65536], [3, 3, 65536]]);
    const [, , data] = [...s.pages()].find(([pc, pr]) => pc === 0 && pr === 2)!;
    expect(data[(700 - 512) * 256 + 10]).toBe(5);
  });
});
