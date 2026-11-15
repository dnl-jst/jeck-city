import { expect, test } from 'vitest';
import { boxBuilding } from './fixture.js';
import type { Road } from './osm.js';
import { footprintContains, footprintDistance, insideAnyFootprint } from './footprint.js';
import { findSpawn } from './spawn.js';

const road = (id: number, name: string, pts: [number, number][]): Road => ({
  id, name, kind: 'secondary', points: pts.map(([x, z]) => ({ x, z })), width: 10, oneway: false, lanes: 2,
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
