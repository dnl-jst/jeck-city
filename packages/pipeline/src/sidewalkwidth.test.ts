import { expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { boxBuilding } from './fixture.js';
import type { Road } from './osm.js';
import { sidewalkWidths } from './sidewalkwidth.js';

// residential, 6.0 m kerb to kerb (kerbs at z = ±3); runs east, so right of travel is south (+z)
const road = (xs: number[]): Road => {
  const cross = crossSectionFromTags({}, 'residential');
  return { id: 1, kind: 'residential', points: xs.map((x) => ({ x, z: 0 })), width: cross.carriageway, oneway: false, lanes: 2, cross };
};

test('facade 4 m behind the kerb → 4.0; no building within 10 m → 2.5', () => {
  const w = sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', -10, 7, 50, 20, 12)]);
  for (const v of w.right) expect(v).toBeCloseTo(4.0, 5);
  expect(w.left).toEqual([2.5, 2.5, 2.5]);
});

test('a gap with no building within 10 m of the kerb → 2.5', () => {
  const w = sidewalkWidths(road([0, 20, 40]), [boxBuilding('far', -10, 14, 50, 30, 12)]); // 11 m behind the kerb
  expect(w.right).toEqual([2.5, 2.5, 2.5]);
});

test('a 30 m deep courtyard between buildings is capped at 8 m', () => {
  const b = [
    boxBuilding('W', -30, -20, -3, -7, 12), boxBuilding('E', 13, -20, 40, -7, 12), // facades 4 m behind the north kerb
    boxBuilding('back', -30, -45, 40, -33, 12), // courtyard back, 30 m behind the kerb
  ];
  expect(sidewalkWidths(road([0, 5, 10]), b).left).toEqual([8, 8, 8]);
});

test('facade right at the kerb is clamped to 1.5 m', () => {
  expect(sidewalkWidths(road([0, 20, 40]), [boxBuilding('S', -10, 3.5, 50, 20, 12)]).right).toEqual([1.5, 1.5, 1.5]);
});

test('a single recessed vertex is smoothed away (median over 3)', () => {
  const b = [boxBuilding('a', -10, 7, 18, 30, 12), boxBuilding('b', 22, 7, 50, 30, 12), boxBuilding('c', 18, 23, 22, 30, 12)];
  const w = sidewalkWidths(road([0, 10, 20, 30, 40]), b).right;
  for (const v of w) expect(v).toBeCloseTo(4.0, 5);
});
