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
  bikeRacks: [{ x: 4, z: 5, heading: 1.2, kind: 0 }],
  bikes: [{ x: 4.5, z: 5, heading: 1.2, type: 3, color: 0x336699 }],
  bikeModels: [{ type: 'longjohn', file: 'bike_longjohn.glb', bytes: 10 }],
  rackModels: [{ kind: 0, file: 'rack_hoop.glb', bytes: 5 }],
    characterModels: [{ variant: 'woman', file: 'character_woman.glb', bytes: 7 }],
  carModels: [],
  npc: { file: 'npc.json', bytes: 77 },
  signals: { file: 'signals.json', bytes: 12 },
  signalModels: [{ kind: 'car', file: 'signal_car.glb', bytes: 9 }, { kind: 'car+ped', file: 'signal_carped.glb', bytes: 9 }],
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

test('manifest parse: bikes and racks', () => {
  const m = parseManifest(JSON.parse(JSON.stringify(valid())));
  expect(m.bikeRacks).toEqual([{ x: 4, z: 5, heading: 1.2, kind: 0 }]);
  expect(m.bikes).toEqual([{ x: 4.5, z: 5, heading: 1.2, type: 3, color: 0x336699 }]);
});

test('manifest parse: signalModels default to [] and are validated', () => {
  const { signalModels: _s, ...old } = valid();
  expect(parseManifest(old).signalModels).toEqual([]);
  expect(() => parseManifest({ ...valid(), signalModels: [{ kind: 'tram', file: 'x.glb', bytes: 1 }] as never })).toThrow();
});

test('manifest parse: npc is optional and validated', () => {
  const { npc: _n, ...old } = valid();
  expect(parseManifest(old).npc).toBeUndefined();
  expect(() => parseManifest({ ...valid(), npc: { file: 'other.json', bytes: 1 } as never })).toThrow();
});

test('manifest parse: old manifest without bikes gets empty lists', () => {
  const { bikes: _b, bikeRacks: _r, ...old } = valid();
  const m = parseManifest(old);
  expect(m.bikes).toEqual([]);
  expect(m.bikeRacks).toEqual([]);
});

test('manifest parse keeps the down flag of a lying e-scooter, drops a false one', () => {
  const m = parseManifest({ ...valid(), bikes: [{ x: 0, z: 0, heading: 0, type: 6, color: 0, down: true }, { x: 1, z: 0, heading: 0, type: 6, color: 0, down: false }] });
  expect(m.bikes[0]!.down).toBe(true);
  expect('down' in m.bikes[1]!).toBe(false);
});

test('manifest parse rejects bike type out of range and rack kind 2', () => {
  expect(() => parseManifest({ ...valid(), bikes: [{ x: 0, z: 0, heading: 0, type: 7, color: 0 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), bikes: [{ x: 0, z: 0, heading: 0, type: 6, color: 0, down: 1 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), bikes: [{ x: 0, z: 0, heading: 0, type: 1.5, color: 0 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), bikeRacks: [{ x: 0, z: 0, heading: 0, kind: 2 }] })).toThrow();
});

test('manifest parse: bike and rack models, default [] and validated', () => {
  const m = parseManifest(JSON.parse(JSON.stringify(valid())));
  expect(m.bikeModels).toEqual([{ type: 'longjohn', file: 'bike_longjohn.glb', bytes: 10 }]);
  expect(m.rackModels).toEqual([{ kind: 0, file: 'rack_hoop.glb', bytes: 5 }]);
  const { bikeModels: _b, rackModels: _r, ...old } = valid();
  expect(parseManifest(old).bikeModels).toEqual([]);
  expect(parseManifest(old).rackModels).toEqual([]);
  expect(() => parseManifest({ ...valid(), bikeModels: [{ type: 'unicycle', file: 'x.glb', bytes: 1 }] })).toThrow();
});

test('manifest parse: car types and car models, default and validated', () => {
  const car = { x: 1, z: 2, heading: 0.5, color: 0xffffff };
  const models = [{ type: 'smart', file: 'car_smart.glb', lod: 'car_smart_lod.glb', bytes: 7 }];
  const m = parseManifest({ ...valid(), parked: [{ ...car, type: 3 }, car], carModels: models });
  expect(m.parked[0]!.type).toBe(3);
  expect(m.parked[1]!.type).toBeUndefined();
  expect(m.carModels).toEqual(models);
  expect(parseManifest(valid()).carModels).toEqual([]);
  expect(() => parseManifest({ ...valid(), parked: [{ ...car, type: 4 }] })).toThrow();
  expect(() => parseManifest({ ...valid(), carModels: [{ ...models[0], type: 'bus' }] })).toThrow();
});

test('manifest parse: character models, default [] and validated', () => {
  expect(parseManifest(JSON.parse(JSON.stringify(valid()))).characterModels).toEqual([{ variant: 'woman', file: 'character_woman.glb', bytes: 7 }]);
  const { characterModels: _c, ...old } = valid();
  expect(parseManifest(old).characterModels).toEqual([]);
  expect(() => parseManifest({ ...valid(), characterModels: [{ variant: 'robot', file: 'x.glb', bytes: 1 }] })).toThrow();
});
