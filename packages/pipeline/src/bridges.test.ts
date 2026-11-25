import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTerrain, heightAt } from '@nn/shared';
import { afterAll, expect, test } from 'vitest';
import { abutmentFills, bridgeBodies, CLEARANCE, deckAt, liftOntoDecks, onBridge, planBridges } from './bridges.js';
import { crossSectionFromTags } from './crosssection.js';
import { densify, type OsmFeatures, type Road } from './osm.js';
import { buildStreetGeometry, railMesh } from './streets.js';
import { allSidewalkWidths } from './sidewalkwidth.js';
import { centreLine, riverTerrain } from './riverfixture.js';
import { commitVersion, type TerrainFile, writeTerrainFile } from './terrain/file.js';
import { carveRiverBed, findWater } from './water.js';

const dir = mkdtempSync(join(tmpdir(), 'nn-bridges-'));
const opened: TerrainFile[] = [];
afterAll(() => {
  for (const f of opened) f.close();
  rmSync(dir, { recursive: true, force: true });
});
let files = 0;

const road = (id: number, kind: string, pts: [number, number][], bridge: boolean): Road => {
  const cross = crossSectionFromTags({}, kind);
  const r: Road = { id, kind, points: densify(pts.map(([x, z]) => ({ x, z })), 8), width: cross.carriageway, oneway: false, lanes: 2, cross };
  if (bridge) r.bridge = true;
  return r;
};

/** A street crossing the river (x 150..250) on a bridge from x = 120 to 280, with ground streets beyond. */
function world() {
  const g = riverTerrain();
  const t0 = writeTerrainFile(join(dir, `t${files++}.bin`), g, (r, out) => out.set(g.heights.subarray(r * g.cols, (r + 1) * g.cols)));
  const w = findWater(t0, [centreLine]);
  const bed = carveRiverBed(t0, w);
  // T2, the terrain after the river bed, as a file (planBridges) and decoded (the readers that still take a grid)
  const file = commitVersion(t0, bed.edits, bed.edited, join(dir, `t${files++}.bin`));
  t0.close();
  opened.push(file);
  const bytes = readFileSync(file.path);
  const t = decodeTerrain(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const roads = [
    road(1, 'residential', [[60, 150], [120, 150]], false),
    road(2, 'residential', [[120, 150], [280, 150]], true),
    road(3, 'residential', [[280, 150], [340, 150]], false),
    road(4, 'residential', [[60, 40], [340, 40]], true), // a bridge=* way elsewhere that is not ours: also over the water
  ];
  const f: OsmFeatures = {
    boundary: [], roads, tramTracks: [], bridgeTracks: [], railBridges: [], rivers: [centreLine], tramStops: [], tunnelTracks: [], tunnelPlatforms: [], platforms: [], greens: [], trees: [], lamps: [],
    shops: [], squares: [], bikeParking: [],
  };
  return { t, file, w, f, plan: planBridges(f, file, w) };
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

test('a railway bridge gets steel arches over its spans; abutment fills sit at the deck ends', () => {
  const { t, file, w, f } = world();
  const rails = [212, 220, 228].map((z) => densify([{ x: 120, z }, { x: 280, z }], 8));
  const withRail: OsmFeatures = { ...f, roads: f.roads.slice(0, 3), railBridges: rails };
  const plan = planBridges(withRail, file, w);
  const st = plan.structures.find((s) => s.rails)!;
  expect(st).toBeDefined();
  const geo = buildStreetGeometry(withRail, allSidewalkWidths(withRail.roads, []), { roads: plan.roads, tracks: plan.tracks });
  const bodies = bridgeBodies(plan, [liftOntoDecks(geo.bridge.road, plan), liftOntoDecks(railMesh(plan.rails), plan)], t);
  expect(bodies.steel.indices.length).toBeGreaterThan(0);
  const ys = Array.from({ length: bodies.steel.positions.length / 3 }, (_, i) => bodies.steel.positions[i * 3 + 1]!);
  // crowns well above the deck (rise 16 % of a 50 m span)
  expect(Math.max(...ys)).toBeGreaterThan(deckAt(plan, 175, 220)!.y + 6);
  const fills = abutmentFills(plan);
  expect(fills.length).toBe(plan.ends.length * 18);
  for (const e of plan.ends) {
    const p = plan.pos[e.n]!;
    expect(p.x < 150 || p.x > 250).toBe(true); // abutments on the banks
    expect(e.out.x * (p.x - 200)).toBeGreaterThan(0); // pointing away from the river
  }
});
