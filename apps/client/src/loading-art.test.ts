import { expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FADE_MS, LOADING_ART, panFor, SLIDE_MS } from './loading-art';

test('every loading picture exists in public/', () => {
  for (const src of LOADING_ART) expect(existsSync(fileURLToPath(new URL(`../public${src}`, import.meta.url))), src).toBe(true);
});

test('pictures pan alternately left and right, zooming in', () => {
  expect(panFor(0)).toEqual({ from: 'scale(1.08) translateX(-2.5%)', to: 'scale(1.14) translateX(2.5%)' });
  expect(panFor(1)).toEqual({ from: 'scale(1.08) translateX(2.5%)', to: 'scale(1.14) translateX(-2.5%)' });
});

test('the pan never uncovers an edge: the zoom overhang is larger than the offset', () => {
  // "scale(s) translateX(t%)": shifted by t% of the width, then scaled about the centre → offset s·t%, overhang (s − 1)/2
  for (const i of [0, 1]) {
    const p = panFor(i);
    for (const t of [p.from, p.to]) {
      const m = /scale\(([\d.]+)\) translateX\((-?[\d.]+)%\)/.exec(t)!;
      const s = Number(m[1]), x = Number(m[2]);
      expect(Math.abs(s * x)).toBeLessThan(((s - 1) / 2) * 100);
    }
  }
});

test('the crossfade is shorter than a slide', () => {
  expect(FADE_MS).toBeLessThan(SLIDE_MS);
});
