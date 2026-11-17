import { expect, test } from 'vitest';
import { placeRand } from './placerand.js';

test('placeRand: same seed, spot and salt give the same value; centimetre noise does not change it', () => {
  const a = placeRand(7, { x: 12.3, z: -40.1 }, 2);
  expect(placeRand(7, { x: 12.3, z: -40.1 }, 2)).toBe(a);
  expect(placeRand(7, { x: 12.31, z: -40.09 }, 2)).toBe(a);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(a).toBeLessThan(1);
});

test('placeRand: seed, salt and position each change the draw; values spread over [0, 1)', () => {
  const p = { x: 3, z: 4 };
  expect(placeRand(1, p)).not.toBe(placeRand(2, p));
  expect(placeRand(1, p, 0)).not.toBe(placeRand(1, p, 1));
  const vs = Array.from({ length: 4000 }, (_, i) => placeRand(9, { x: (i % 80) * 3, z: Math.floor(i / 80) * 3 }));
  const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
  expect(mean).toBeGreaterThan(0.47);
  expect(mean).toBeLessThan(0.53);
  expect(vs.filter((v) => v < 0.1).length / vs.length).toBeGreaterThan(0.08);
  expect(vs.filter((v) => v < 0.1).length / vs.length).toBeLessThan(0.12);
});
