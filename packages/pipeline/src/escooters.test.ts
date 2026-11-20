import { expect, test } from 'vitest';
import { ESCOOTER_TYPE, FLEET_COLORS, placeScooters } from './escooters.js';
import { boxBuilding, crossOf } from './fixture.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { edgeAt } from './roadprofile.js';

const L = 3000;
const box = (x0: number, z0: number, x1: number, z1: number): Pt[] => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
const empty: OsmFeatures = { boundary: box(-100, -1000, L + 100, 100), roads: [], tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [], tramStops: [], tunnelTracks: [], tunnelPlatforms: [], platforms: [], greens: [], trees: [], lamps: [], shops: [], squares: [], bikeParking: [] };
// eastbound road along z = 0; right of travel is +z
const road = (over: Partial<Road> = {}): Road => ({
  id: 1, kind: 'secondary', name: 'A', points: [{ x: 0, z: 0 }, { x: L, z: 0 }], width: 10, oneway: false, lanes: 2, cross: crossOf('secondary', 10), ...over,
});
const KERB = edgeAt(road(), 1, 'kerb', 0);
/** Sidewalks 4 m wide on both sides. */
const blocks = () => [boxBuilding('S', -20, KERB + 4, L + 20, KERB + 25, 17), boxBuilding('N', -20, -KERB - 25, L + 20, -KERB - 4, 17)];
const none = { lamps: [], trees: [], hoops: [], keepClear: [] };
const SEED = 11;

test('scooters stand on the sidewalks, in groups, in fleet colours, a few lying', () => {
  const sc = placeScooters({ ...empty, roads: [road()] }, blocks(), SEED, none);
  expect(sc.length).toBeGreaterThan(40);
  for (const s of sc) {
    expect(s.type).toBe(ESCOOTER_TYPE);
    expect(FLEET_COLORS).toContain(s.color);
    expect(Math.abs(s.z)).toBeGreaterThan(KERB + 0.4);
    expect(Math.abs(s.z)).toBeLessThan(KERB + 1);
  }
  expect(sc.some((s) => s.z > 0) && sc.some((s) => s.z < 0)).toBe(true);
  expect(sc.some((s) => s.down)).toBe(true);
  expect(sc.filter((s) => s.down).length).toBeLessThan(sc.length * 0.25);
  // some neighbours within 1.5 m: groups
  expect(sc.some((a, i) => sc.some((b, j) => i !== j && Math.hypot(a.x - b.x, a.z - b.z) < 1.5))).toBe(true);
});

test('none on narrow sidewalks (1.5 m)', () => {
  const narrow = [boxBuilding('S', -20, KERB + 1.5, L + 20, KERB + 25, 17), boxBuilding('N', -20, -KERB - 25, L + 20, -KERB - 1.5, 17)];
  expect(placeScooters({ ...empty, roads: [road()] }, narrow, SEED, none)).toEqual([]);
});

test('clear of lamps, hoops and the spawn', () => {
  const all = placeScooters({ ...empty, roads: [road()] }, blocks(), SEED, none);
  const lamp = { x: all[2]!.x + 0.3, z: all[2]!.z };
  const hoop = { x: all[8]!.x + 1, z: all[8]!.z };
  const spawn = { x: all[14]!.x, z: all[14]!.z + 1 };
  const sc = placeScooters({ ...empty, roads: [road()] }, blocks(), SEED, { lamps: [lamp], trees: [], hoops: [hoop], keepClear: [spawn] });
  for (const s of sc) {
    expect(Math.hypot(s.x - lamp.x, s.z - lamp.z)).toBeGreaterThanOrEqual(0.9);
    expect(Math.hypot(s.x - hoop.x, s.z - hoop.z)).toBeGreaterThanOrEqual(2);
    expect(Math.hypot(s.x - spawn.x, s.z - spawn.z)).toBeGreaterThanOrEqual(4);
  }
  expect(sc.length).toBeLessThan(all.length);
});

test('stable: another street elsewhere leaves the scooters of this one where they are', () => {
  const a = placeScooters({ ...empty, roads: [road()] }, blocks(), SEED, none);
  const other = road({ id: 2, name: 'B', points: [{ x: 0, z: -600 }, { x: L, z: -600 }] });
  const b = placeScooters({ ...empty, roads: [other, road()] }, blocks(), SEED, none);
  expect(b.filter((s) => Math.abs(s.z) < 50)).toEqual(a);
  expect(b.length).toBeGreaterThan(a.length);
});
