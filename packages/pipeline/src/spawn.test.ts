import { expect, test } from 'vitest';
import { boxBuilding, loadFixture, crossOf } from './fixture.js';
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
  expect(s.x).toBeCloseTo(30 + 5 + 1.5, 5); // east sidewalk: width/2 + 1.5 m
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
    expect(spot.pos.x).toBeCloseTo(30 + 5 - 1.1, 5); // 1.1 m inside the kerb, spawn's (east) side
    expect(Math.abs(spot.pos.x - s.x) - 0.9).toBeGreaterThanOrEqual(1); // player to car contour (half width 0.9)
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
