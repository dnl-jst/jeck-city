import { expect, test } from 'vitest';
import { LOD2_TILES, tileNamesForBounds } from './fetch';

test('tiles cover Nippes plus 150 m backdrop', () => {
  const t = tileNamesForBounds(355389 - 150, 5646699 - 150, 357399 + 150, 5648852 + 150);
  expect(t).toHaveLength(12);
  expect(t).toContain('LoD2_32_355_5646_1_NW.gml');
  expect(t).toContain('LoD2_32_357_5649_1_NW.gml');
});

test('LOD2_TILES lists the 12 Nippes tiles', () => {
  expect(LOD2_TILES).toHaveLength(12);
  expect(new Set(LOD2_TILES).size).toBe(12);
});
