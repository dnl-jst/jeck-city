import { expect, test } from 'vitest';
import { boxBuilding, crossOf } from './fixture.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { edgeAt } from './roadprofile.js';
import { streetTrees, TREE_KERB_OFFSET, TREE_SPACING } from './streettrees.js';

const empty: OsmFeatures = { boundary: [], roads: [], tramTracks: [], tramStops: [], greens: [], trees: [], lamps: [], shops: [], squares: [], bikeParking: [], benches: [], crossings: [], signals: [], giveWay: [], stops: [] };
// eastbound road along z = 0; "right" of travel is +z (south)
const road = (over: Partial<Road> = {}): Road => ({
  id: 1, kind: 'secondary', name: 'A', points: [{ x: 0, z: 0 }, { x: 300, z: 0 }], width: 10, oneway: false, lanes: 2, cross: crossOf('secondary', 10), ...over,
});
const KERB = edgeAt(road(), 1, 'kerb', 0);
/** South facades 5 m behind the kerb (sidewalk 5 m), north facades 3 m behind it (too narrow for trees). */
const blocks = (flags = 0) => [boxBuilding('S', -20, KERB + 5, 320, KERB + 25, 17, flags), boxBuilding('N', -20, -KERB - 25, 320, -KERB - 3, 17)];
const far = { x: -1000, z: -1000 };
const SEED = 7;

test('trees on sidewalks ≥ 3.5 m only, 1.2 m behind the kerb, every 14 ± 2 m', () => {
  const trees = streetTrees({ ...empty, roads: [road()] }, blocks(), far, SEED);
  expect(trees.length).toBeGreaterThan(15);
  for (const t of trees) expect(t.z).toBeCloseTo(KERB + TREE_KERB_OFFSET, 5);
  const xs = trees.map((t) => t.x).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
  for (const g of gaps) {
    expect(g).toBeGreaterThanOrEqual(TREE_SPACING - 2 - 1e-6);
    expect(g).toBeLessThanOrEqual(TREE_SPACING + 2 + 1e-6);
  }
  expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(3); // seeded jitter, not a fixed grid
});

test('no trees without buildings (default sidewalk 2.5 m)', () => {
  expect(streetTrees({ ...empty, roads: [road()] }, [], far, SEED)).toEqual([]);
});

test('skips: OSM tree within 8 m, junctions (8 m from the crossing carriageway), tram stops, the spawn (4 m)', () => {
  const all = streetTrees({ ...empty, roads: [road()] }, blocks(), far, SEED);
  const osm: Pt = { x: all[3]!.x + 3, z: all[3]!.z };
  const spawn: Pt = { x: all[10]!.x + 1, z: all[10]!.z };
  const stop: Pt = { x: all[6]!.x, z: 0 };
  const cross = road({ id: 2, name: 'B', kind: 'residential', width: 6, cross: crossOf('residential', 6), points: [{ x: 150, z: -60 }, { x: 150, z: 0 }, { x: 150, z: 60 }] });
  const main = road({ points: [{ x: 0, z: 0 }, { x: 150, z: 0 }, { x: 300, z: 0 }] });
  const trees = streetTrees({ ...empty, roads: [main, cross], trees: [osm], tramStops: [{ pos: stop, name: 'H' }] }, blocks(), spawn, SEED);
  expect(trees.length).toBeGreaterThan(10);
  const crossKerb = edgeAt(cross, 1, 'kerb', 0);
  for (const t of trees) {
    expect(Math.hypot(t.x - osm.x, t.z - osm.z)).toBeGreaterThanOrEqual(8);
    expect(Math.hypot(t.x - spawn.x, t.z - spawn.z)).toBeGreaterThanOrEqual(4);
    expect(Math.hypot(t.x - stop.x, t.z - stop.z)).toBeGreaterThanOrEqual(15);
    // trees of A keep 8 m from B's kerb, trees of B (if any) 8 m from A's
    if (Math.abs(t.z - (KERB + TREE_KERB_OFFSET)) < 1e-6) expect(Math.abs(t.x - 150) - crossKerb).toBeGreaterThanOrEqual(8);
    else expect(Math.abs(t.z) - KERB).toBeGreaterThanOrEqual(8);
  }
  // without the blockers the trees are there
  expect(all.some((t) => Math.abs(t.x - 150) - crossKerb < 8)).toBe(true);
});

test('not in front of shopfront buildings (bit 0) closer than 2.5 m to the tree', () => {
  // sidewalk 3.6 m: tree 1.2 m from the kerb is 2.4 m from the facade
  const narrow = (flags: number) => [boxBuilding('S', -20, KERB + 3.6, 320, KERB + 25, 17, flags)];
  expect(streetTrees({ ...empty, roads: [road()] }, narrow(0), far, SEED).length).toBeGreaterThan(15);
  expect(streetTrees({ ...empty, roads: [road()] }, narrow(1), far, SEED)).toEqual([]);
  // the 5 m sidewalk leaves 3.8 m to the shopfront: trees stay
  expect(streetTrees({ ...empty, roads: [road()] }, blocks(1), far, SEED).length).toBeGreaterThan(15);
});

test('deterministic', () => {
  const f = { ...empty, roads: [road()] };
  expect(streetTrees(f, blocks(), far, SEED)).toEqual(streetTrees(f, blocks(), far, SEED));
});
