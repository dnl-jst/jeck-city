import { expect, test } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeCollision, decodeTerrain, heightAt } from '@nn/shared';
import { boxRecord } from './fixture.js';
import { footprintContains, footprintDistance } from './footprint.js';
import { placeSpawn, SPAWN_AT, topSurface } from './spawn.js';

const square = [{ x: -100, z: -100 }, { x: 100, z: -100 }, { x: 100, z: 100 }, { x: -100, z: 100 }];

test('spawn looks at its target; heading = atan2(dx, dz)', () => {
  const s = placeSpawn({ x: 0, z: 0 }, { x: 30, z: 0 }, square, []);
  expect(s).toMatchObject({ x: 0, z: 0 });
  expect(Math.sin(s.heading)).toBeCloseTo(1, 5); // east
  expect(Math.sin(placeSpawn({ x: 0, z: 0 }, { x: 0, z: -5 }, square, []).heading)).toBeCloseTo(0, 5);
  expect(Math.cos(placeSpawn({ x: 0, z: 0 }, { x: 0, z: -5 }, square, []).heading)).toBeCloseTo(-1, 5); // north
});

test('spawn throws inside a building or outside the play area', () => {
  expect(() => placeSpawn({ x: 0, z: 0 }, { x: 1, z: 0 }, square, [boxRecord('B', -5, -5, 5, 5, 10)])).toThrow('inside a building');
  expect(() => placeSpawn({ x: 150, z: 0 }, { x: 160, z: 0 }, square, [])).toThrow('outside the play area');
});

test('topSurface: highest triangle within reach above the ground, roofs ignored', () => {
  // three horizontal triangles over (0, 0): pavement at 0.12, a roof at 8, and one at 0.05
  const tri = (y: number) => [-1, y, -1, 1, y, -1, 0, y, 1];
  const mesh = { vertices: [...tri(0.12), ...tri(8), ...tri(0.05)], indices: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
  expect(topSurface(mesh, 0, 0, 0)).toBeCloseTo(0.12, 5);
  expect(topSurface(mesh, 5, 5, 0)).toBe(0); // nothing there: the ground
  expect(topSurface(mesh, 0, 0, 0, 10)).toBeCloseTo(8, 5);
});

test('footprint test uses the projected roof', () => {
  const b = boxRecord('b', 0, 0, 10, 5, 6);
  expect(footprintContains(b, 5, 2.5)).toBe(true);
  expect(footprintContains(b, 11, 2.5)).toBe(false);
  expect(footprintContains(b, 5, -0.1)).toBe(false);
  expect(footprintDistance(b, 5, 2.5)).toBe(0);
  expect(footprintDistance(b, 13, 9)).toBeCloseTo(5, 5);
});

const WORLD = (f: string) => fileURLToPath(new URL(`../../../apps/client/public/world/${f}`, import.meta.url));
const haveReal = existsSync(WORLD('manifest.json')) && existsSync(WORLD('collision.bin')) && existsSync(WORLD('terrain.bin'));

test.skipIf(!haveReal)('real manifest: spawn on the Domplatte, looking at the west portal, standing on the surface', () => {
  const m = JSON.parse(readFileSync(WORLD('manifest.json'), 'utf8')) as { spawn: { x: number; y: number; z: number; heading: number }; bikes: { x: number; z: number; type: number }[] };
  const { spawn } = m;
  expect(Math.hypot(spawn.x - SPAWN_AT.x, spawn.z - SPAWN_AT.z)).toBeLessThan(0.01);
  expect(Math.sin(spawn.heading)).toBeGreaterThan(0.99); // looking east
  const bike = m.bikes[0]!;
  expect(bike.type).toBe(3); // the Long John right behind the player
  expect(Math.hypot(bike.x - spawn.x, bike.z - spawn.z)).toBeLessThanOrEqual(3);
  // standing on the walkable surface: the highest collision surface under the spawn (within 1 m of the terrain, not a
  // roof), or the terrain itself
  const file = readFileSync(WORLD('collision.bin'));
  const col = decodeCollision(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const tf = readFileSync(WORLD('terrain.bin'));
  const ground = heightAt(decodeTerrain(tf.buffer.slice(tf.byteOffset, tf.byteOffset + tf.byteLength)), spawn.x, spawn.z);
  const top = topSurface(col, spawn.x, spawn.z, ground);
  expect(top - ground).toBeGreaterThanOrEqual(0);
  expect(top - ground).toBeLessThanOrEqual(0.2);
  expect(spawn.y).toBeCloseTo(top, 2);
});
