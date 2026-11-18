import { heightAt } from '@nn/shared';
import { expect, test } from 'vitest';
import { bridgeBodies, CLEARANCE, deckAt, liftOntoDecks, onBridge, planBridges } from './bridges.js';
import { crossSectionFromTags } from './crosssection.js';
import { densify, type OsmFeatures, type Road } from './osm.js';
import { buildStreetGeometry } from './streets.js';
import { allSidewalkWidths } from './sidewalkwidth.js';
import { centreLine, riverTerrain } from './riverfixture.js';
import { carveRiverBed, findWater } from './water.js';

const road = (id: number, kind: string, pts: [number, number][], bridge: boolean): Road => {
  const cross = crossSectionFromTags({}, kind);
  const r: Road = { id, kind, points: densify(pts.map(([x, z]) => ({ x, z })), 8), width: cross.carriageway, oneway: false, lanes: 2, cross };
  if (bridge) r.bridge = true;
  return r;
};

/** A street crossing the river (x 150..250) on a bridge from x = 120 to 280, with ground streets beyond. */
function world() {
  const t = riverTerrain();
  const w = findWater(t, [centreLine]);
  carveRiverBed(t, w);
  const roads = [
    road(1, 'residential', [[60, 150], [120, 150]], false),
    road(2, 'residential', [[120, 150], [280, 150]], true),
    road(3, 'residential', [[280, 150], [340, 150]], false),
    road(4, 'residential', [[60, 40], [340, 40]], true), // a bridge=* way elsewhere that is not ours: also over the water
  ];
  const f: OsmFeatures = {
    boundary: [], roads, tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [centreLine], tramStops: [], greens: [], trees: [], lamps: [],
    shops: [], squares: [], bikeParking: [],
  };
  return { t, w, f, plan: planBridges(f, t, w) };
}

test('deck heights meet the terrain at the abutments and clear the water in between', () => {
  const { t, w, plan } = world();
  expect(plan.structures).toHaveLength(2);
  expect(plan.roads.size).toBe(2);
  for (const x of [120, 280]) expect(deckAt(plan, x, 150)!.y).toBeCloseTo(heightAt(t, x, 150), 3);
  // full clearance over the fairway (the middle half of the water), the decks meet the banks lower
  for (let x = 175; x <= 225; x += 5) expect(deckAt(plan, x, 150)!.y).toBeGreaterThanOrEqual(w.meanLevel + CLEARANCE - 0.05);
  for (let x = 150; x <= 250; x += 10) expect(deckAt(plan, x, 150)!.y).toBeGreaterThan(w.meanLevel + 5);
  // smooth: no step between neighbouring metres
  for (let x = 120; x < 280; x++) expect(Math.abs(deckAt(plan, x + 1, 150)!.y - deckAt(plan, x, 150)!.y)).toBeLessThan(0.2);
});

test('bridge geometry is lifted onto the deck; the bodies close the deck and keep props off it', () => {
  const { t, f, plan } = world();
  const geo = buildStreetGeometry(f, allSidewalkWidths(f.roads, []), { roads: plan.roads, tracks: plan.tracks });
  // the ground streets keep their geometry, the bridge's goes to `bridge`
  const xs = (m: { positions: Float32Array }) => Array.from({ length: m.positions.length / 3 }, (_, i) => m.positions[i * 3]!);
  expect(xs(geo.road).filter((x, i) => Math.abs(geo.road.positions[i * 3 + 2]! - 150) < 5 && x > 125 && x < 275)).toEqual([]);
  const deck = liftOntoDecks(geo.bridge.road, plan);
  for (let v = 0; v < deck.positions.length; v += 3) {
    const x = deck.positions[v]!;
    if (x > 160 && x < 240) expect(deck.positions[v + 1]!).toBeGreaterThan(heightAt(t, x, deck.positions[v + 2]!) + 5);
  }
  const sidewalk = liftOntoDecks(geo.bridge.sidewalk, plan);
  const bodies = bridgeBodies(plan, [deck, sidewalk], t);
  expect(bodies.mesh.indices.length).toBeGreaterThan(0);
  expect(bodies.collision.length % 9).toBe(0);
  // slab right under the deck in mid-river, parapets beyond the sidewalks
  const s = plan.structures.find((st) => st.axis.some((p) => Math.abs(p.z - 150) < 1))!;
  const mid = Math.round((s.s1 - s.s0) / 2 / 2);
  expect(s.top[mid]!).toBeLessThan(deckAt(plan, 200, 150)!.y);
  expect(s.top[mid]!).toBeGreaterThan(deckAt(plan, 200, 150)!.y - 0.5);
  expect(s.right[mid]! - s.left[mid]!).toBeGreaterThan(10);
  const tops = Array.from({ length: bodies.mesh.positions.length / 3 }, (_, i) => bodies.mesh.positions[i * 3 + 1]!);
  expect(Math.max(...tops)).toBeGreaterThan(deckAt(plan, 200, 150)!.y + 1);
  // piers reach down into the river bed
  expect(Math.min(...tops)).toBeLessThan(heightAt(t, 200, 150));
  expect(onBridge(plan, t, { x: 200, z: 150 })).toBe(true);
  expect(onBridge(plan, t, { x: 200, z: 150 + s.right[mid]! + 3 })).toBe(false);
  expect(onBridge(plan, t, { x: 100, z: 150 })).toBe(false);
});
