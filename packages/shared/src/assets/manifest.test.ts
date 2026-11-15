import { expect, test } from 'vitest';
import { chunkKey, parseManifest, type WorldManifest } from './manifest';

const valid = (): WorldManifest => ({
  version: 1,
  origin: { e: 356198, n: 5647717 },
  chunkSize: 200,
  chunks: [{ key: '0_0', x: 0, z: 0, file: 'chunk_0_0.glb', bytes: 1234 }],
  spawn: { x: 1, y: 0.12, z: 2, heading: 3 },
  boundary: [[0, 0], [1, 0], [1, 1]],
  lamps: [[1, 2]],
  trees: [[3, 4]],
  tramStops: [{ name: 'Florastr.', x: 5, z: 6, heading: -1.5 }],
  shops: [{ x: 1, z: 2, label: 'bakery', type: 'bakery', buildingId: 'DENW1' }, { x: 3, z: 4, label: 'kiosk', type: 'kiosk', buildingId: 'DENW2', sign: { x: 3.5, z: 4, heading: 1.57, width: 4 } }],
  parked: [{ x: 1, z: 2, heading: 0.5, color: 0xffffff }],
  attribution: '© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude: Geobasis NRW (dl-de/zero-2.0)',
});

test('manifest parse accepts a valid manifest (JSON round trip)', () => {
  const m = valid();
  expect(parseManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
});

test('manifest parse rejects missing spawn', () => expect(() => parseManifest({ version: 1 })).toThrow());

test('manifest parse rejects wrong version, bad chunk and bad shop', () => {
  expect(() => parseManifest({ ...valid(), version: 2 })).toThrow();
  expect(() => parseManifest({ ...valid(), chunks: [{ key: '0_0', x: 0, z: 0, file: 'a.glb' }] })).toThrow();
  expect(() => parseManifest({ ...valid(), shops: [{ x: 1, z: 2, label: 'a', type: 'b', buildingId: 7 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), shops: [{ x: 1, z: 2, label: 'a', type: 'b', sign: { x: 1, z: 2, heading: 0 } }] })).toThrow();
  expect(() => parseManifest({ ...valid(), lamps: [[1]] })).toThrow();
  expect(() => parseManifest({ ...valid(), tramStops: [{ name: 'Florastr.', x: 5, z: 6 }] })).toThrow();
});

test('chunk key for point', () => expect(chunkKey(-1, 399)).toBe('-1_1'));
