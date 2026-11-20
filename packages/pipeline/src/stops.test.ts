import { crossOf } from './fixture.js';
import { expect, test } from 'vitest';
import type { OsmFeatures } from './osm.js';
import { placeShelter, SHELTER_OFFSET } from './stops.js';

const empty: OsmFeatures = { boundary: [], roads: [], tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [], tramStops: [], tunnelTracks: [], tunnelPlatforms: [], platforms: [], greens: [], trees: [], lamps: [], shops: [], squares: [], bikeParking: [] };
// track runs north (−z) along x = 0
const track = [{ x: 0, z: 100 }, { x: 0, z: -100 }];

test('shelter goes 3.5 m to the right of the track direction when both sides are free; heading keeps the track on its left', () => {
  const s = placeShelter({ x: 0.3, z: 0 }, { ...empty, tramTracks: [track] });
  expect(s.x).toBeCloseTo(SHELTER_OFFSET); // right of north = east
  expect(s.z).toBeCloseTo(0);
  // heading = north: forward (sin h, cos h) = (0, −1)
  expect(Math.sin(s.heading)).toBeCloseTo(0);
  expect(Math.cos(s.heading)).toBeCloseTo(-1);
});

test('shelter avoids the side with a road ribbon; heading flips so the track stays on its left', () => {
  const road = { id: 1, kind: 'secondary', points: [{ x: 6, z: 100 }, { x: 6, z: -100 }], width: 8, oneway: false, lanes: 2, cross: crossOf('secondary', 8) };
  const s = placeShelter({ x: 0, z: 0 }, { ...empty, roads: [road], tramTracks: [track] });
  expect(s.x).toBeCloseTo(-SHELTER_OFFSET);
  expect(Math.cos(s.heading)).toBeCloseTo(1); // south: west is on its right
});
