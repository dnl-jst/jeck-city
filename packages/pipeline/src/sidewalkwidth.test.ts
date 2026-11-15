import { expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { boxBuilding } from './fixture.js';
import type { Road } from './osm.js';
import { allSidewalkWidths, SIDEWALK_STEP, sidewalkWidths, widthAt } from './sidewalkwidth.js';

// residential, 6.0 m kerb to kerb (kerbs at z = ±3); runs east, so right of travel is south (+z)
const road = (xs: number[]): Road => {
  const cross = crossSectionFromTags({}, 'residential');
  return { id: 1, kind: 'residential', points: xs.map((x) => ({ x, z: 0 })), width: cross.carriageway, oneway: false, lanes: 2, cross };
};
const all = (v: number[], x: number) => v.forEach((w) => expect(w).toBeCloseTo(x, 5));

test('samples: every vertex, plus points between where the width does not run linearly', () => {
  const plain = sidewalkWidths(road([0, 5, 30]), []);
  expect(plain.s).toEqual([0, 5, 30]); // constant widths: only the vertices
  expect(plain.left).toHaveLength(3);
  const b = [boxBuilding('A', -10, 7, 20, 30, 12), boxBuilding('B', 20, 5, 70, 30, 12)];
  const w = sidewalkWidths(road([0, 60]), b);
  expect(w.s[0]).toBe(0);
  expect(w.s[w.s.length - 1]).toBe(60);
  const between = w.s.filter((s) => s > 0 && s < 60);
  expect(between.length).toBeGreaterThan(0); // the facade step at x = 20
  for (const s of between) expect(Math.abs(s - 20)).toBeLessThanOrEqual(2 * SIDEWALK_STEP);
});

test('facade 4 m behind the kerb → 4.0; no building within 10 m → 2.5', () => {
  const w = sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', -10, 7, 50, 20, 12)]);
  all(w.right, 4);
  all(w.left, 2.5);
});

test('a facade more than 10 m behind the kerb → 2.5', () => {
  all(sidewalkWidths(road([0, 20, 40]), [boxBuilding('far', -10, 14, 50, 30, 12)]).right, 2.5); // 11 m behind the kerb
});

test('a facade 9 m behind the kerb is capped at 8 m', () => {
  all(sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', -10, 12, 50, 30, 12)]).right, 8);
});

test('a courtyard gap keeps the neighbours\' building line instead of running to the back', () => {
  const b = [
    boxBuilding('W', -30, -20, -3, -7, 12), boxBuilding('E', 13, -20, 40, -7, 12), // facades 4 m behind the north kerb
    boxBuilding('back', -30, -45, 40, -33, 12), // courtyard back, 30 m behind the kerb
  ];
  all(sidewalkWidths(road([0, 5, 10]), b).left, 4);
});

test('facade right at the kerb is clamped to 1.5 m', () => {
  all(sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', -10, 3.5, 50, 20, 12)]).right, 1.5);
});

test('a single recessed vertex is smoothed away', () => {
  const b = [boxBuilding('a', -10, 7, 18, 30, 12), boxBuilding('b', 22, 7, 50, 30, 12), boxBuilding('c', 18, 23, 22, 30, 12)];
  all(sidewalkWidths(road([0, 10, 20, 30, 40]), b).right, 4);
});

test('a side-street gap at the end of the way does not flare the sidewalk', () => {
  // facade 4 m behind the south kerb from x = 5 on; at x = 0 a straight ray runs past the building corner
  all(sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', 5, 7, 50, 30, 12)]).right, 4);
});

test('side-street gaps at junction vertices do not flare the sidewalk', () => {
  const b = [boxBuilding('a', -10, 7, 8, 30, 12), boxBuilding('b', 12, 7, 18, 30, 12), boxBuilding('c', 22, 7, 50, 30, 12)];
  all(sidewalkWidths(road([0, 10, 20, 30, 40]), b).right, 4);
});

test('a way with only two vertices follows a building that covers only its middle', () => {
  all(sidewalkWidths(road([0, 40]), [boxBuilding('S', 10, 7, 30, 30, 12)]).right, 4);
});

// one 60 m segment along a stepped facade (south side, kerb at z = 3): 4 m, then 2 m (a building standing forward),
// a 3 m passage to a rear building 7 m behind the kerb, then 5 m
const stepped = [
  boxBuilding('A', -10, 7, 20, 30, 12), boxBuilding('B', 20, 5, 40, 30, 12),
  boxBuilding('rear', 38, 10, 45, 30, 12), boxBuilding('C', 43, 8, 70, 30, 12),
];
const facadeZ = (x: number): number => {
  const zs = stepped.map((b) => {
    const xs = [...b.positions].filter((_, i) => i % 3 === 0), zz = [...b.positions].filter((_, i) => i % 3 === 2);
    return x >= Math.min(...xs) && x <= Math.max(...xs) ? Math.min(...zz) : Infinity;
  });
  return Math.min(...zs);
};

test('long segment along a stepped facade: the outer edge never enters a building, between samples too', () => {
  const r = road([0, 60]);
  const w = sidewalkWidths(r, stepped);
  for (let x = 0; x <= 60; x += 0.1) expect(3 + widthAt(w, 1, x), `x=${x.toFixed(1)}`).toBeLessThanOrEqual(facadeZ(x) + 1e-6);
});

test('long segment along a stepped facade: the outer edge stays on the facade away from the steps', () => {
  const w = sidewalkWidths(road([0, 60]), stepped);
  // within 2 steps of a facade step the edge may stay at the nearer facade; elsewhere it reaches the facade
  for (const [x0, x1, z] of [[0, 16, 7], [24, 36, 5], [47, 60, 8]] as const) {
    for (let x = x0; x <= x1; x += 0.5) expect(3 + widthAt(w, 1, x), `x=${x}`).toBeCloseTo(z, 5);
  }
});

test('a 3 m passage does not pull the sidewalk to the rear building behind it', () => {
  const w = sidewalkWidths(road([0, 60]), stepped);
  // the rear facade lies at z = 10; the edge stays on the facades beside the passage (z = 5 and 8)
  for (let x = 40; x <= 43; x += 0.25) expect(3 + widthAt(w, 1, x)).toBeLessThanOrEqual(8 + 1e-6);
});

test('allSidewalkWidths: every drivable way once, from the one building set it is given', () => {
  const r = road([0, 20, 40]);
  const path: Road = { ...road([0, 10]), id: 2, kind: 'footway' };
  const m = allSidewalkWidths([r, path], [boxBuilding('S', -10, 7, 50, 20, 12)]);
  expect([...m.keys()]).toEqual([r]);
  all(m.get(r)!.right, 4);
});
