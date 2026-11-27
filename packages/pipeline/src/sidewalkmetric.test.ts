import { expect, test } from 'vitest';
import { boxRecord } from './fixture.js';
import { sidewalkFit } from './sidewalkmetric.js';
import type { Mesh } from './streets.js';

/** Flat rectangle x0..x1 × z0..z1 as a two-triangle mesh. */
const rect = (x0: number, z0: number, x1: number, z1: number): Mesh => ({
  positions: new Float32Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]), uv: new Float32Array(8),
});

test('sidewalk reaching exactly to the facade: area, no overshoot, no undershoot', () => {
  const fit = sidewalkFit(rect(0, 3, 40, 7), [rect(0, -3, 40, 3)], [boxRecord('S', -10, 7, 50, 20, 12)]);
  expect(fit.area).toBeCloseTo(40 * 4, 0);
  expect(fit.overshoot).toBe(0);
  expect(fit.undershoot).toBe(0);
});

test('sidewalk 3 m into a building: only the part ≥ 1 m deep counts as overshoot', () => {
  const fit = sidewalkFit(rect(0, 3, 40, 10), [], [boxRecord('S', -10, 7, 50, 20, 12)]); // 3 m inside
  expect(fit.overshoot).toBeCloseTo(40 * 2, -1); // z 8..10
});

test('a 2 m gap to a facade counts as undershoot; a facade beyond 6.5 m or behind a road does not', () => {
  expect(sidewalkFit(rect(0, 3, 40, 5), [], [boxRecord('S', -10, 7, 50, 20, 12)]).undershoot).toBeCloseTo(40 * 2, -1);
  expect(sidewalkFit(rect(0, 3, 40, 5), [], [boxRecord('S', -10, 12, 50, 20, 12)]).undershoot).toBe(0);
  expect(sidewalkFit(rect(0, 3, 40, 5), [rect(-10, 5, 50, 7)], [boxRecord('S', -10, 7, 50, 20, 12)]).undershoot).toBe(0);
});
