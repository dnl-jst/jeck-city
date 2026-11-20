import { expect, test } from 'vitest';
import { boxBuilding, crossOf } from './fixture.js';
import { generatedLamps, LAMP_SPACING } from './lamps.js';
import type { OsmFeatures, Road } from './osm.js';

const empty: OsmFeatures = { boundary: [], roads: [], tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [], tramStops: [], tunnelTracks: [], tunnelPlatforms: [], platforms: [], greens: [], trees: [], lamps: [], shops: [], squares: [], bikeParking: [] };
// eastbound road along z = 0; "right" of travel is +z (south)
const road = (over: Partial<Road> = {}): Road => ({
  id: 1, kind: 'residential', points: [{ x: 0, z: 0 }, { x: 300, z: 0 }], width: 6.5, oneway: false, lanes: 2, cross: crossOf('residential', over.width ?? 6.5), ...over,
});

test('narrow roads: one side, every 28 m, at road width / 2 + 0.5 m', () => {
  const lamps = generatedLamps({ ...empty, roads: [road()] }, []);
  expect(lamps.length).toBe(Math.floor((300 - LAMP_SPACING / 2) / LAMP_SPACING) + 1);
  for (const l of lamps) expect(l.z).toBeCloseTo(3.75);
  for (let i = 1; i < lamps.length; i++) expect(lamps[i]!.x - lamps[i - 1]!.x).toBeCloseTo(28);
});

test('two-way roads ≥ 9 m wide alternate sides; one-way wide roads do not', () => {
  const two = generatedLamps({ ...empty, roads: [road({ kind: 'secondary', width: 10 })] }, []);
  expect(two.slice(0, 4).map((l) => l.z)).toEqual([5.5, -5.5, 5.5, -5.5]);
  const one = generatedLamps({ ...empty, roads: [road({ kind: 'secondary', width: 10, oneway: true })] }, []);
  expect(new Set(one.map((l) => l.z))).toEqual(new Set([5.5]));
});

test('skips candidates near OSM lamps, inside footprints, on tram tracks and near junctions', () => {
  const all = generatedLamps({ ...empty, roads: [road()] }, []);
  expect(all.map((l) => Math.round(l.x)).slice(0, 5)).toEqual([14, 42, 70, 98, 126]);
  const xs = generatedLamps({
    ...empty,
    roads: [road({ points: [{ x: 0, z: 0 }, { x: 126, z: 0 }, { x: 300, z: 0 }] }), { ...road(), id: 2, points: [{ x: 126, z: -50 }, { x: 126, z: 50 }] }], // crossing: shared node at x = 126
    lamps: [{ x: 40, z: 10 }], // within 20 m of the x = 42 candidate only
    tramTracks: [[{ x: 98, z: -20 }, { x: 98, z: 20 }]],
  }, [boxBuilding('B', 65, 2, 75, 10, 10)]).map((l) => Math.round(l.x * 100) / 100);
  expect(xs.slice(0, 2)).toEqual([14, 154]);
  expect(xs).not.toContain(126);
});

test('deterministic', () => {
  const f = { ...empty, roads: [road({ kind: 'secondary', width: 10 }), road({ id: 2, points: [{ x: 0, z: 100 }, { x: 0, z: 400 }] })] };
  expect(generatedLamps(f, [])).toEqual(generatedLamps(f, []));
});
