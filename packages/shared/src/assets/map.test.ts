import { expect, test } from 'vitest';
import { parseMapData, type MapData } from './map';

const valid = (): MapData => ({
  version: 1,
  bounds: { minX: -10, minZ: -20, maxX: 30, maxZ: 40 },
  boundary: [0, 0, 10, 0, 10, 10],
  roads: [{ kind: 'primary', name: 'Neusser Str.', width: 8, pts: [0, 0, 5, 5, 10, 5] }],
  buildings: [[0, 0, 1, 0, 1, 1, 2, 2, 3, 2, 3, 3]],
  greens: [[0, 0, 4, 0, 4, 4, 0, 4]],
  squares: [{ name: 'Wilhelm-Sollmann-Platz', pts: [0, 0, 3, 0, 3, 3] }, { name: '', pts: [5, 5, 6, 5, 6, 6] }],
  tram: [[0, 0, 10, 10]],
  tramStops: [{ name: 'Florastr.', x: 5, z: 6 }],
});

test('parses a valid map', () => {
  const m = valid();
  expect(parseMapData(JSON.parse(JSON.stringify(m)))).toEqual(m);
});

test('rejects version 2', () => expect(() => parseMapData({ ...valid(), version: 2 })).toThrow(/map: version/));

test('rejects odd-length point arrays', () => {
  const m = valid();
  m.roads[0]!.pts = [1, 2, 3];
  expect(() => parseMapData(m)).toThrow(/roads\[0\]\.pts/);
});

test('rejects building triangle lists not divisible by 6', () => {
  const m = valid();
  m.buildings[0] = [0, 0, 1, 0, 1, 1, 2, 2];
  expect(() => parseMapData(m)).toThrow(/buildings\[0\]/);
});

test('road name is optional', () => {
  const m = valid();
  delete m.roads[0]!.name;
  expect(parseMapData(m).roads[0]!.name).toBeUndefined();
});
