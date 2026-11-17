import { expect, test } from 'vitest';
import { GraphIndex, type NetGraph } from '@nn/shared';
import { crossSectionFromTags } from './crosssection.js';
import { boxBuilding } from './fixture.js';
import { buildWalkGraph } from './npcnet.js';
import type { Pt, Road } from './osm.js';
import { onCarriageway } from './roadprofile.js';
import { allSidewalkWidths } from './sidewalkwidth.js';
import { footprintContains } from './footprint.js';

let nextId = 1;
/** residential, 6 m kerb to kerb, sidewalks 2.5 m (no buildings) → sidewalk centre 4.25 m from the centre line */
const road = (pts: Pt[], kind = 'residential'): Road => {
  const cross = crossSectionFromTags({}, kind);
  return { id: nextId++, kind, points: pts, width: cross.carriageway, oneway: false, lanes: 2, cross };
};
const walk = (roads: Road[], crossings: Pt[] = [], buildings = []): NetGraph =>
  buildWalkGraph(roads, allSidewalkWidths(roads, buildings), crossings, buildings);

/** Every node reachable from node 0 (edges both ways). */
function reachable(g: NetGraph): Set<number> {
  const adj = new Map<number, number[]>();
  for (const e of g.edges) {
    adj.set(e.a, [...(adj.get(e.a) ?? []), e.b]);
    adj.set(e.b, [...(adj.get(e.b) ?? []), e.a]);
  }
  const seen = new Set([0]);
  const q = [0];
  while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return seen;
}

test('sidewalk lines lie beside the carriageway, not on it', () => {
  const r = road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
  const g = walk([r]);
  const side = g.edges.filter((e) => !e.crossing);
  expect(side.length).toBeGreaterThanOrEqual(2);
  for (const e of side) {
    expect(e.width).toBeCloseTo(2.5, 5);
    for (const [x, z] of e.pts) {
      expect(onCarriageway(r, { x, z })).toBe(false);
      if (x > 1 && x < 99) expect(Math.abs(z)).toBeCloseTo(4.25, 1);
    }
    for (let i = 1; i < e.pts.length; i++) expect(Math.hypot(e.pts[i]![0] - e.pts[i - 1]![0], e.pts[i]![1] - e.pts[i - 1]![1])).toBeLessThanOrEqual(4.0001);
  }
});

test('a crossing joins both sides', () => {
  const g = walk([road([{ x: 0, z: 0 }, { x: 100, z: 0 }])], [{ x: 50, z: 0.5 }]);
  const cross = g.edges.filter((e) => e.crossing);
  expect(cross.some((e) => Math.abs(g.nodes[e.a]![0] - 50) < 0.5 && Math.sign(g.nodes[e.a]![1]) !== Math.sign(g.nodes[e.b]![1]))).toBe(true);
  expect(reachable(g).size).toBe(g.nodes.length);
});

test('T-junction connects corners and crossings into one network', () => {
  const o = { x: 0, z: 0 };
  const g = walk([road([{ x: -80, z: 0 }, o]), road([o, { x: 80, z: 0 }]), road([o, { x: 0, z: 80 }])]);
  expect(reachable(g).size).toBe(g.nodes.length);
  // no sidewalk point lies on any of the three carriageways
  expect(g.edges.filter((e) => e.crossing).length).toBeGreaterThanOrEqual(3);
});

test('a road through a junction vertex is split there', () => {
  const g = walk([road([{ x: -80, z: 0 }, { x: 0, z: 0 }, { x: 80, z: 0 }]), road([{ x: 0, z: 0 }, { x: 0, z: -80 }])]);
  expect(reachable(g).size).toBe(g.nodes.length);
  const r = road([{ x: 0, z: 0 }, { x: 0, z: -80 }]);
  for (const e of g.edges.filter((e) => !e.crossing)) for (const [x, z] of e.pts) expect(onCarriageway(r, { x, z }, -0.01)).toBe(false);
});

test('no point inside a building', () => {
  const b = boxBuilding('S', 20, 4.5, 60, 30, 10); // reaches into where the 2.5 m default sidewalk would be
  const g = walk([road([{ x: 0, z: 0 }, { x: 100, z: 0 }])], [], [b] as never);
  for (const e of g.edges) for (const [x, z] of e.pts) expect(footprintContains(b, x, z)).toBe(false);
});

test('footways join the sidewalks they end at', () => {
  const r = road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
  const path = road([{ x: 50, z: 0 }, { x: 50, z: 60 }], 'footway');
  const g = walk([r, path], [{ x: 20, z: 0 }]); // the crossing joins the two sidewalks
  expect(reachable(g).size).toBe(g.nodes.length);
  // the footway was mapped to the road's centre line: it starts at the sidewalk, not on the carriageway
  for (const e of g.edges.filter((e) => !e.crossing)) for (const [x, z] of e.pts) expect(onCarriageway(r, { x, z })).toBe(false);
  const ix = new GraphIndex(g);
  expect(ix.nearestEdge(50, 40)!.d).toBeLessThan(0.01);
});
