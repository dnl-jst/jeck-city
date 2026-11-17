import { expect, test } from 'vitest';
import { GraphIndex, type NetGraph } from '@nn/shared';
import { crossSectionFromTags } from './crosssection.js';
import { boxBuilding } from './fixture.js';
import { buildCycleGraph, buildDriveGraph, buildSeats, buildWalkGraph } from './npcnet.js';
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

test('a junction arm shorter than its cut-back yields no sidewalk piece and no crash', () => {
  const o = { x: 0, z: 0 }, p = { x: 3, z: 0 };
  const g = walk([road([{ x: -80, z: 0 }, o]), road([o, p]), road([o, { x: 0, z: 80 }]), road([p, { x: 3, z: -80 }]), road([p, { x: 80, z: 0 }])]);
  for (const e of g.edges) for (const [x, z] of e.pts) expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
});

// ---- lanes, cycle paths, seats ----

const oneway = (pts: Pt[]): Road => {
  const cross = crossSectionFromTags({ oneway: 'yes' }, 'residential');
  return { id: nextId++, kind: 'residential', points: pts, width: cross.carriageway, oneway: true, lanes: 1, cross };
};
/** Sign of the cross product: > 0 when p lies right of travel along a → b (x east, z south). */
const sideOf = (a: Pt, b: Pt, p: Pt): number => Math.sign((b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x));
const dirOf = (e: { pts: [number, number][] }) => ({ x: e.pts[e.pts.length - 1]![0] - e.pts[0]![0], z: e.pts[e.pts.length - 1]![1] - e.pts[0]![1] });

test('two-way road gets one lane per direction on the right', () => {
  const g = buildDriveGraph([road([{ x: 0, z: 0 }, { x: 100, z: 0 }])]);
  const lanes = g.edges.filter((e) => Math.hypot(dirOf(e).x, dirOf(e).z) > 50);
  expect(lanes.length).toBe(2);
  for (const e of lanes) {
    expect(e.oneway).toBe(true);
    const d = dirOf(e);
    const m = { x: e.pts[1]![0], z: e.pts[1]![1] };
    const a = d.x > 0 ? { x: 0, z: 0 } : { x: 100, z: 0 }, b = d.x > 0 ? { x: 100, z: 0 } : { x: 0, z: 0 };
    expect(sideOf(a, b, m)).toBe(1);
    expect(Math.abs(m.z)).toBeGreaterThan(0.5);
    expect(Math.abs(m.z)).toBeLessThan(3);
  }
});

test('one-way road has lanes only in its direction', () => {
  const g = buildDriveGraph([oneway([{ x: 0, z: 0 }, { x: 0, z: 100 }])]);
  const lanes = g.edges.filter((e) => Math.abs(dirOf(e).z) > 50);
  expect(lanes.length).toBe(1);
  expect(dirOf(lanes[0]!).z).toBeGreaterThan(0);
});

test('junction offers turns but no U-turns', () => {
  const o = { x: 0, z: 0 };
  const roads = [road([{ x: -80, z: 0 }, o]), road([o, { x: 80, z: 0 }]), road([{ x: 0, z: -80 }, o]), road([o, { x: 0, z: 80 }])];
  const g = buildDriveGraph(roads);
  const ix = new GraphIndex(g);
  // each lane arriving at the junction (its end within 15 m of o) continues on exactly 3 turn edges
  const arriving = g.edges.filter((e) => Math.hypot(dirOf(e).x, dirOf(e).z) > 50 && Math.hypot(e.pts[e.pts.length - 1]![0], e.pts[e.pts.length - 1]![1]) < 15);
  expect(arriving.length).toBe(4);
  for (const e of arriving) expect(ix.out(e.b).length).toBe(3);
});

test('cycle lanes sit right of the drive lanes', () => {
  const r = road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
  const east = (g: NetGraph) => g.edges.find((e) => dirOf(e).x > 50)!;
  const drive = east(buildDriveGraph([r])), cycle = east(buildCycleGraph([r]));
  expect(cycle.pts[1]![1]).toBeGreaterThan(drive.pts[1]![1]); // further south = further right going east
  expect(cycle.pts[1]![1]).toBeLessThan(3); // still on the carriageway
});

test('cycleways join the cycle network', () => {
  const r = road([{ x: 0, z: 0 }, { x: 100, z: 0 }]);
  const cw = road([{ x: 50, z: 5 }, { x: 50, z: 80 }], 'cycleway');
  const ix = new GraphIndex(buildCycleGraph([r, cw]));
  expect(ix.nearestEdge(50, 40)!.d).toBeLessThan(0.01);
  expect(ix.nearestEdge(50, 4)!.d).toBeLessThan(1.5);
});

test('benches in a park become seat rings facing their centre', () => {
  const park = [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 60, z: 60 }, { x: 0, z: 60 }];
  const seats = buildSeats([park], [], [{ x: 30, z: 30 }, { x: 200, z: 200 }], [], { nodes: [], edges: [] }, 1);
  const benchRings = seats.filter((s) => s.bench);
  expect(benchRings.length).toBe(1); // the bench outside the park is ignored
  const ring = benchRings[0]!;
  expect(ring.seats.length).toBeGreaterThanOrEqual(2);
  for (const q of ring.seats) {
    const toCentre = Math.atan2(ring.x - q.x, ring.z - q.z);
    expect(Math.abs(Math.atan2(Math.sin(q.heading - toCentre), Math.cos(q.heading - toCentre)))).toBeLessThan(0.01);
  }
});

test('lawn rings fill big greens and keep clear of trees and paths', () => {
  const park = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }]; // 10 000 m²
  const trees = [{ x: 50, z: 50 }, { x: 20, z: 70 }];
  const path: NetGraph = { nodes: [[0, 30], [100, 30]], edges: [{ a: 0, b: 1, pts: [[0, 30], [100, 30]], width: 2, oneway: false }] };
  const lawn = buildSeats([park], [], [], trees, path, 7).filter((s) => !s.bench);
  expect(lawn.length).toBe(2);
  for (const s of lawn) {
    expect(s.seats.length).toBeGreaterThanOrEqual(3);
    expect(s.seats.length).toBeLessThanOrEqual(4);
    for (const t of trees) expect(Math.hypot(s.x - t.x, s.z - t.z)).toBeGreaterThanOrEqual(3);
    expect(Math.abs(s.z - 30)).toBeGreaterThanOrEqual(2);
  }
  expect(buildSeats([park], [], [], trees, path, 7)).toEqual(buildSeats([park], [], [], trees, path, 7)); // seeded
});
