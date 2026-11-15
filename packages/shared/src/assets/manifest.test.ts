import { expect, test } from 'vitest';
import { chunkKey, parseManifest, SIGN_Y, type WorldManifest } from './manifest';

const valid = (): WorldManifest => ({
  version: 2,
  origin: { e: 356198, n: 5647717 },
  chunkSize: 200,
  chunks: [{ key: '0_0', x: 0, z: 0, file: 'chunk_0_0.glb', bytes: 1234 }],
  spawn: { x: 1, y: 0.12, z: 2, heading: 3 },
  boundary: [[0, 0], [1, 0], [1, 1]],
  lamps: [[1, 2]],
  trees: [[3, 4]],
  tramStops: [{ name: 'Florastr.', x: 5, z: 6, heading: -1.5 }],
  shops: [{ x: 1, z: 2, label: 'bakery', type: 'bakery', buildingId: 'DENW1' }, { x: 3, z: 4, label: 'kiosk', type: 'kiosk', buildingId: 'DENW2', sign: { x: 3.5, y: 6.1, z: 4, heading: 1.57, width: 4 } }],
  parked: [{ x: 1, z: 2, heading: 0.5, color: 0xffffff }],
  models: [{ id: 'DENW3', chunk: '0_0', file: 'model_a.glb', bytes: 99 }],
  terrain: { file: 'terrain.bin', bytes: 4321 },
  datum: 47.3,
  farGroundY: -9.4,
  attribution: '© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude und Gelände: Geobasis NRW (dl-de/zero-2.0)',
});

test('manifest parse accepts a valid manifest (JSON round trip)', () => {
  const m = valid();
  expect(parseManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
});

test('manifest parse rejects missing spawn', () => expect(() => parseManifest({ version: 1 })).toThrow());

test('manifest parse rejects wrong version, bad chunk and bad shop', () => {
  expect(() => parseManifest({ ...valid(), version: 1 })).toThrow();
  expect(() => parseManifest({ ...valid(), version: 3 })).toThrow();
  expect(() => parseManifest({ ...valid(), chunks: [{ key: '0_0', x: 0, z: 0, file: 'a.glb' }] })).toThrow();
  expect(() => parseManifest({ ...valid(), shops: [{ x: 1, z: 2, label: 'a', type: 'b', buildingId: 7 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), shops: [{ x: 1, z: 2, label: 'a', type: 'b', sign: { x: 1, y: 3.5, z: 2, heading: 0 } }] })).toThrow();
  // sign.y is required whenever there is a sign
  expect(() => parseManifest({ ...valid(), shops: [{ x: 1, z: 2, label: 'a', type: 'b', sign: { x: 1, z: 2, heading: 0, width: 4 } }] })).toThrow();
  expect(() => parseManifest({ ...valid(), lamps: [[1]] })).toThrow();
  expect(() => parseManifest({ ...valid(), tramStops: [{ name: 'Florastr.', x: 5, z: 6 }] })).toThrow();
});

test('manifest parse: models default to [] for older manifests and are validated', () => {
  const { models: _, ...old } = valid();
  expect(parseManifest(old).models).toEqual([]);
  expect(() => parseManifest({ ...valid(), models: [{ id: 'a', chunk: '0_0', file: 'm.glb' }] })).toThrow();
});

test('manifest parse v2: terrain, datum and farGroundY are required and validated', () => {
  const m = parseManifest(JSON.parse(JSON.stringify(valid())));
  expect(m.version).toBe(2);
  expect(m.terrain).toEqual({ file: 'terrain.bin', bytes: 4321 });
  expect(m.datum).toBe(47.3);
  expect(m.farGroundY).toBe(-9.4);
  expect(m.shops[1]!.sign!.y).toBe(6.1);
  const { terrain: _t, ...noTerrain } = valid();
  expect(() => parseManifest(noTerrain)).toThrow();
  const { datum: _d, ...noDatum } = valid();
  expect(() => parseManifest(noDatum)).toThrow();
  const { farGroundY: _f, ...noFar } = valid();
  expect(() => parseManifest(noFar)).toThrow();
  expect(() => parseManifest({ ...valid(), terrain: { file: 'terrain.bin' } })).toThrow();
  expect(() => parseManifest({ ...valid(), terrain: { file: 'other.bin', bytes: 1 } })).toThrow();
});

test('SIGN_Y is the sign board centre above the building base', () => expect(SIGN_Y).toBe(3.975));

test('chunk key for point', () => expect(chunkKey(-1, 399)).toBe('-1_1'));
