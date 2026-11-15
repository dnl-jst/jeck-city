import { expect, test } from 'vitest';
import { loadFixture } from './fixture.js';
import { buildRoadGraph } from './roadgraph.js';
import { parkedCarSpots } from './parking.js';
import { wgs84ToLocal } from '@nn/shared';
import type { OsmFeatures, Pt, Road } from './osm.js';

const f = loadFixture();

test('crossing is a node of degree 4', () => {
  const g = buildRoadGraph(f);
  const deg = new Map<number, number>();
  for (const e of g.edges) for (const n of [e.from, e.to]) deg.set(n, (deg.get(n) ?? 0) + 1);
  expect([...deg.values()].filter((d) => d === 4)).toHaveLength(1);
  const c = wgs84ToLocal(50.9631, 6.952);
  const node = g.nodes.find((n) => Math.hypot(n.pos.x - c.x, n.pos.z - c.z) < 0.1)!;
  expect(deg.get(node.id)).toBe(4);
});

test('footways are not in the graph, tram is', () => {
  const g = buildRoadGraph(f);
  expect(g.edges.filter((e) => e.tram)).toHaveLength(1);
  expect(g.edges).toHaveLength(5);
});

test('tram stop is assigned to the tram edge', () => {
  const g = buildRoadGraph(f);
  expect(g.stops).toHaveLength(1);
  expect(g.edges[g.stops[0]!.edgeIndex]!.tram).toBe(true);
  expect(g.stops[0]!.name).toBe('Florastr.');
});

test('oneway roads have no backward lanes', () => {
  const road: Road = { id: 7, kind: 'residential', points: [{ x: 0, z: 0 }, { x: 50, z: 0 }], width: 6.5, oneway: true, lanes: 1 };
  const g = buildRoadGraph({ ...f, roads: [road], tramTracks: [], tramStops: [] });
  expect(g.edges).toEqual([expect.objectContaining({ lanesForward: 1, lanesBackward: 0, roadId: 7 })]);
});

const spots = parkedCarSpots(f, 42);
const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z);

test('parking keeps 10 m from junctions and stops, and off the tracks', () => {
  expect(spots.length).toBeGreaterThan(0);
  const junction = wgs84ToLocal(50.9631, 6.952);
  const stop = f.tramStops[0]!.pos;
  for (const s of spots) {
    expect(d(s.pos, junction)).toBeGreaterThanOrEqual(10);
    expect(d(s.pos, stop)).toBeGreaterThanOrEqual(10);
  }
  const track = wgs84ToLocal(50.9636, 6.952);
  expect(spots.every((s) => Math.abs(s.pos.z - track.z) > 3 || Math.abs(s.pos.x - track.x) > 20)).toBe(true);
});

test('same seed gives same spots, other seed differs', () => {
  expect(parkedCarSpots(f, 42)).toEqual(spots);
  expect(parkedCarSpots(f, 43)).not.toEqual(spots);
});

test('oneway: right side only; heading follows travel direction', () => {
  const east: Road = { id: 1, kind: 'residential', points: [{ x: 0, z: 0 }, { x: 600, z: 0 }], width: 6.5, oneway: true, lanes: 1 };
  const feat: OsmFeatures = { ...f, roads: [east], tramTracks: [], tramStops: [] };
  const s = parkedCarSpots(feat, 1);
  expect(s.length).toBeGreaterThan(10);
  for (const p of s) {
    expect(p.pos.z).toBeCloseTo(2.25, 5); // right of eastward travel = south = +z
    expect(p.heading).toBeCloseTo(Math.PI / 2, 5); // atan2(dx=1, dz=0)
  }
  const two = parkedCarSpots({ ...feat, roads: [{ ...east, oneway: false }] }, 1);
  expect(two.some((p) => p.pos.z < 0 && Math.abs(Math.abs(p.heading) - Math.PI / 2) < 1e-6 && p.heading < 0)).toBe(true);
});

test('at most 300 spots', () => {
  const long: Road = { id: 1, kind: 'tertiary', points: [{ x: 0, z: 0 }, { x: 20000, z: 0 }], width: 8, oneway: false, lanes: 1 };
  expect(parkedCarSpots({ ...f, roads: [long], tramTracks: [], tramStops: [] }, 3)).toHaveLength(300);
});
