import { expect, test } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeCollision, decodeTerrain, heightAt, TUNING } from '@nn/shared';
import { boxBuilding, loadFixture, crossOf } from './fixture.js';
import { crossSectionFromTags } from './crosssection.js';
import { sideOffsets } from './roadprofile.js';
import type { Road } from './osm.js';
import { footprintContains, footprintDistance, insideAnyFootprint } from './footprint.js';
import { findSpawn } from './spawn.js';
import { spawnCarSpot, withSpawnCar } from './parking.js';

const road = (id: number, name: string, pts: [number, number][]): Road => ({
  id, name, kind: 'secondary', points: pts.map(([x, z]) => ({ x, z })), width: 10, oneway: false, lanes: 2, cross: crossOf('secondary', 10),
});
// A side street passes right through the target; Neusser Straße runs north–south 30 m east of it
// (way drawn south → north). Its west sidewalk is covered by a building.
const fixtureRoads: Road[] = [
  road(1, 'Teststraße', [[-100, 0], [100, 0]]),
  road(2, 'Neusser Straße', [[30, 200], [30, 50], [30, -200]]),
];
const fixtureBuildings = [boxBuilding('W', 15, -20, 28, 20, 12), boxBuilding('far', 100, 100, 110, 110, 8)];

test('spawn is on Neusser Straße sidewalk near Wilhelmplatz and outside buildings', () => {
  const s = findSpawn(fixtureRoads, { x: 0, z: 0 }, fixtureBuildings);
  expect(Math.hypot(s.x, s.z)).toBeLessThan(80);
  expect(insideAnyFootprint(s, fixtureBuildings)).toBe(false);
  expect(s.x).toBeCloseTo(30 + 5 + 1.0, 5); // east sidewalk: 1.0 m from the kerb
  expect(s.z).toBeCloseTo(0, 5);
  expect(s.y).toBeCloseTo(0.12, 5);
});

test('spawn heading points north along the road whatever the way direction', () => {
  for (const pts of [[[30, 200], [30, -200]], [[30, -200], [30, 200]]] as [number, number][][]) {
    const s = findSpawn([road(2, 'Neusser Straße', pts)], { x: 0, z: 0 }, []);
    // forward = (sin h, cos h); north is -z
    expect(Math.sin(s.heading)).toBeCloseTo(0, 5);
    expect(Math.cos(s.heading)).toBeCloseTo(-1, 5);
  }
});

test('spawn throws without Neusser Straße', () => {
  expect(() => findSpawn([fixtureRoads[0]!], { x: 0, z: 0 }, [])).toThrow();
});

test('footprint test uses the projected roof', () => {
  const b = boxBuilding('b', 0, 0, 10, 5, 6);
  expect(footprintContains(b, 5, 2.5)).toBe(true);
  expect(footprintContains(b, 11, 2.5)).toBe(false);
  expect(footprintContains(b, 5, -0.1)).toBe(false);
  expect(footprintDistance(b, 5, 2.5)).toBe(0);
  expect(footprintDistance(b, 13, 9)).toBeCloseTo(5, 5);
});

test('a parked car stands next to the spawn, on the carriageway, along the road', () => {
  const road = (pts: [number, number][]): Road => ({ id: 2, name: 'Neusser Straße', kind: 'secondary', points: pts.map(([x, z]) => ({ x, z })), width: 10, oneway: false, lanes: 2, cross: crossOf('secondary', 10) });
  const f = { ...loadFixture(), boundary: [{ x: -500, z: -500 }, { x: 500, z: -500 }, { x: 500, z: 500 }, { x: -500, z: 500 }], tramTracks: [] };
  for (const pts of [[[30, 200], [30, -200]], [[30, -200], [30, 200]]] as [number, number][][]) {
    const roads = [road(pts)];
    const s = findSpawn(roads, { x: 0, z: 0 }, []);
    const spot = spawnCarSpot({ ...f, roads }, s, []);
    expect(Math.hypot(spot.pos.x - s.x, spot.pos.z - s.z)).toBeLessThanOrEqual(3);
    expect(Math.hypot(spot.pos.x - s.x, spot.pos.z - s.z)).toBeLessThanOrEqual(2.7);
    expect(spot.pos.x).toBeCloseTo(30 + 5 - 1.0, 5); // no strip: 1.0 m inside the kerb, spawn's (east) side
    expect(Math.abs(spot.pos.x - s.x) - 0.9).toBeGreaterThanOrEqual(0.8); // player to car contour (half width 0.9)
    expect(Math.sin(spot.heading)).toBeCloseTo(0, 5); // east side: traffic goes north
    expect(Math.cos(spot.heading)).toBeCloseTo(-1, 5);
    expect(spot.pos.z).toBeLessThan(s.z); // ahead (north)
  }
});

test('the spawn car comes first and drops overlapping cars only', () => {
  const spot = { pos: { x: 0, z: 0 }, heading: 0 }; // faces +z
  const near = { pos: { x: 1, z: 5 }, heading: 0 }, side = { pos: { x: 3, z: 0 }, heading: 0 }, far = { pos: { x: 0, z: 7 }, heading: 0 };
  expect(withSpawnCar(spot, [near, side, far])).toEqual([spot, side, far]);
});

const neusser = (pts: [number, number][], tags: Record<string, string>): Road => {
  const cross = crossSectionFromTags(tags, 'secondary');
  return { id: 2, name: 'Neusser Straße', kind: 'secondary', points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: false, lanes: 2, cross };
};
const bigWorld = { ...loadFixture(), boundary: [{ x: -500, z: -500 }, { x: 500, z: -500 }, { x: 500, z: 500 }, { x: -500, z: 500 }], tramTracks: [] };

test('spawn prefers the sidewalk beside a parking strip, 1.0 m from the kerb; the spawn car stands in the strip', () => {
  // way drawn north (-z): right of travel = (-dz, dx) = east; strip on the left (west) only
  for (const [pts, tag] of [[[[30, 200], [30, -200]], 'parking:left'], [[[30, -200], [30, 200]], 'parking:right']] as [[number, number][], string][]) {
    const r = neusser(pts, { lanes: '2', 'cycleway:both': 'lane', [tag]: 'lane' });
    const hw = sideOffsets(r.cross)[tag === 'parking:left' ? 'left' : 'right'].kerb; // the west kerb
    const s = findSpawn([r], { x: 0, z: 0 }, []);
    expect(s.x).toBeCloseTo(30 - hw - 1.0, 5); // west sidewalk
    const spot = spawnCarSpot({ ...bigWorld, roads: [r] }, s, []);
    expect(spot.pos.x).toBeCloseTo(30 - hw + 1.0, 5); // middle of the 2 m strip
    expect(Math.hypot(spot.pos.x - s.x, spot.pos.z - s.z)).toBeLessThanOrEqual(2.7);
    expect(Math.cos(spot.heading)).toBeCloseTo(1, 5); // west side: traffic goes south
  }
});

test('the spawn car stands ahead along the spawn heading, not along a guessed north', () => {
  // an east–west Neusser Straße drawn west → east, strip on the right (south); the spawn faces west
  const r = neusser([[-200, 30], [200, 30]], { 'parking:right': 'lane' });
  const spawn = { x: 0, y: 0.12, z: 30 + sideOffsets(r.cross).right.kerb + 1, heading: -Math.PI / 2 };
  const spot = spawnCarSpot({ ...bigWorld, roads: [r] }, spawn, []);
  expect(spot.pos.x).toBeLessThan(0);
  expect(Math.hypot(spot.pos.x - spawn.x, spot.pos.z - spawn.z)).toBeLessThanOrEqual(2.7);
});

const WORLD = (f: string) => fileURLToPath(new URL(`../../../apps/client/public/world/${f}`, import.meta.url));
const haveReal = existsSync(WORLD('manifest.json')) && existsSync(WORLD('collision.bin')) && existsSync(WORLD('terrain.bin'));

test.skipIf(!haveReal)('real manifest: spawn on the sidewalk, parked[0] next to it and reachable with E', () => {
  const m = JSON.parse(readFileSync(WORLD('manifest.json'), 'utf8')) as { spawn: { x: number; y: number; z: number; heading: number }; parked: { x: number; z: number; heading: number }[] };
  const { spawn, parked } = m;
  const d = parked.map((c) => Math.hypot(c.x - spawn.x, c.z - spawn.z));
  expect(d[0]).toBeLessThanOrEqual(2.7);
  expect(Math.min(...d)).toBe(d[0]); // the nearest car is #0
  expect(d.filter((v) => v < 1.5).length).toBe(0);
  // contour of car 0 (oriented box) at least 0.8 m from the player
  const c = parked[0]!;
  const fx = Math.sin(c.heading), fz = Math.cos(c.heading);
  const dx = spawn.x - c.x, dz = spawn.z - c.z;
  const along = Math.max(0, Math.abs(dx * fx + dz * fz) - TUNING.vehicle.length / 2);
  const across = Math.max(0, Math.abs(dx * fz - dz * fx) - 0.9);
  expect(Math.hypot(along, across)).toBeGreaterThanOrEqual(0.8);
  expect(Math.cos(spawn.heading)).toBeLessThan(-0.9); // looking north
  // on the sidewalk: the highest collision surface under the spawn is the pavement 0.12 m above the terrain (not road,
  // not a roof); the terrain-following collision copy lies within 2 cm of the drape
  const file = readFileSync(WORLD('collision.bin'));
  const col = decodeCollision(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const tf = readFileSync(WORLD('terrain.bin'));
  const ground = heightAt(decodeTerrain(tf.buffer.slice(tf.byteOffset, tf.byteOffset + tf.byteLength)), spawn.x, spawn.z);
  let top = -Infinity;
  const v = col.vertices, idx = col.indices;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, e] = [idx[i]! * 3, idx[i + 1]! * 3, idx[i + 2]! * 3];
    const cr = (p: number, q: number) => (v[q]! - v[p]!) * (spawn.z - v[p + 2]!) - (v[q + 2]! - v[p + 2]!) * (spawn.x - v[p]!);
    const s1 = cr(a, b), s2 = cr(b, e), s3 = cr(e, a);
    if (!((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0))) continue;
    const sum = s1 + s2 + s3;
    if (Math.abs(sum) < 1e-9) continue; // vertical
    // barycentric height: s2 weighs a, s3 weighs b, s1 weighs e
    top = Math.max(top, (s2 * v[a + 1]! + s3 * v[b + 1]! + s1 * v[e + 1]!) / sum);
  }
  expect(Math.abs(top - (ground + 0.12))).toBeLessThan(0.025);
  expect(spawn.y).toBeCloseTo(ground + 0.12, 2);
});
