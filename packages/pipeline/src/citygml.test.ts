import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parseCityGml } from './citygml.js';
import { triangulatePolygon3d } from './triangulate.js';

const read = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), 'utf8');

test('parses gable house', () => {
  const bs = parseCityGml(read('gable-house.gml'));
  expect(bs).toHaveLength(1);
  const b = bs[0]!;
  expect(b.street).toBe('Neusser Str.');
  expect(b.number).toBe('1');
  expect(b.roofType).toBe('3100');
  expect(b.measuredHeight).toBe(13);
  expect(b.surfaces.filter((s) => s.kind === 'roof')).toHaveLength(2);
  expect(b.surfaces.filter((s) => s.kind === 'wall')).toHaveLength(4);
  expect(b.surfaces.filter((s) => s.kind === 'ground')).toHaveLength(1);
  expect(b.surfaces.every((s) => s.outer.length >= 3)).toBe(true);
});

test('closing point removed', () => {
  const b = parseCityGml(read('gable-house.gml'))[0]!;
  const r = b.surfaces[0]!.outer;
  expect(r[0]).not.toEqual(r[r.length - 1]!);
});

test('broken polygons are skipped, valid wall survives', () => {
  const b = parseCityGml(read('broken.gml'))[0]!;
  const tris = b.surfaces.map((s) => triangulatePolygon3d(s.outer, s.holes)).filter(Boolean);
  expect(tris).toHaveLength(1);
});

const tile = fileURLToPath(new URL('../../../data/raw/lod2/LoD2_32_356_5647_1_NW.gml', import.meta.url));
test.skipIf(!existsSync(tile))('real tile smoke', () => {
  const bs = parseCityGml(readFileSync(tile, 'utf8'));
  expect(bs.length).toBeGreaterThan(500);
  expect(bs.some((b) => b.street === 'Neusser Str.')).toBe(true);
}, 60000);
