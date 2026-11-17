import { expect, test } from 'vitest';
import type { JunctionInfo } from '@nn/shared';
import { crossSectionFromTags } from './crosssection.js';
import { buildNpcNet } from './npcnet.js';
import type { Pt, Road } from './osm.js';
import { onCarriageway } from './roadprofile.js';
import { allSidewalkWidths } from './sidewalkwidth.js';

let nextId = 1;
const road = (pts: Pt[], kind = 'residential', priority = false): Road => {
  const cross = crossSectionFromTags({}, kind);
  const r: Road = { id: nextId++, kind, points: pts, width: cross.carriageway, oneway: false, lanes: 2, cross };
  if (priority) r.priority = true;
  return r;
};
const o = { x: 0, z: 0 };
const cross4 = (kindEW = 'residential', kindNS = 'residential'): Road[] => [
  road([{ x: -100, z: 0 }, o], kindEW), road([o, { x: 100, z: 0 }], kindEW), road([{ x: 0, z: -100 }, o], kindNS), road([o, { x: 0, z: 100 }], kindNS),
];
const net = (roads: Road[], extra: { signals?: Pt[]; giveWay?: Pt[]; stops?: Pt[]; crossings?: Pt[] } = {}) =>
  buildNpcNet({ roads, sidewalks: allSidewalkWidths(roads, []), buildings: [], crossings: extra.crossings ?? [], greens: [], squares: [], benches: [], trees: [], signals: extra.signals ?? [], giveWay: extra.giveWay ?? [], stops: extra.stops ?? [], seed: 1 });
const centre = (js: JunctionInfo[]) => js.find((j) => Math.hypot(j.x, j.z) < 1)!;

test('a signalled cross gets two groups by axis', () => {
  const n = net(cross4(), { signals: [{ x: 8, z: 8 }] });
  const j = centre(n.junctions);
  expect(j.signal).not.toBeNull();
  expect(j.approaches.length).toBe(4);
  const groupOf = (dx: number, dz: number) => j.approaches.find((a) => {
    const e = n.drive.edges[a.edge]!;
    const [x, z] = e.pts[e.pts.length - 1]!;
    return Math.sign(Math.round(x)) === dx && Math.sign(Math.round(z)) === dz || (dx === 0 && Math.abs(x) < 3 && Math.sign(z) === dz) || (dz === 0 && Math.abs(z) < 3 && Math.sign(x) === dx);
  })!.group;
  expect(groupOf(-1, 0)).toBe(groupOf(1, 0));
  expect(groupOf(0, -1)).toBe(groupOf(0, 1));
  expect(groupOf(-1, 0)).not.toBe(groupOf(0, -1));
  expect(j.turns.length).toBe(12);
  expect(j.stopLines.length).toBe(4);
  expect(j.peds.length).toBe(4);
  // ped group: crossing the north arm means walking east–west, parallel to the east–west cars
  for (const p of j.peds) {
    const e = n.walk.edges[p.walkEdge]!;
    const [ax, az] = e.pts[0]!, [bx, bz] = e.pts[e.pts.length - 1]!;
    const eastWest = Math.abs(bx - ax) > Math.abs(bz - az);
    expect(p.group).toBe(eastWest ? groupOf(1, 0) : groupOf(0, 1));
  }
});

test('an unsignalled junction has no signal and no poles', () => {
  const j = centre(net(cross4()).junctions);
  expect(j.signal).toBeNull();
  expect(j.poles).toEqual([]);
  expect(j.approaches.length).toBe(4);
});

test('poles stand on the sidewalk, not on the carriageway', () => {
  const roads = cross4();
  const j = centre(net(roads, { signals: [o] }).junctions);
  expect(j.poles.length).toBeGreaterThanOrEqual(4);
  for (const p of j.poles) for (const r of roads) expect(onCarriageway(r, p)).toBe(false);
  expect(j.poles.some((p) => p.kind !== 'car')).toBe(true); // pedestrian heads at the crossings
});

test('ranks follow the road class and give_way lowers it', () => {
  const n = net(cross4('secondary', 'residential'), { giveWay: [{ x: 0, z: -12 }] });
  const j = centre(n.junctions);
  const rankAt = (test: (x: number, z: number) => boolean) => j.approaches.find((a) => {
    const e = n.drive.edges[a.edge]!;
    const [x, z] = e.pts[e.pts.length - 1]!;
    return test(x, z);
  })!.rank;
  const west = rankAt((x, z) => x < -3 && Math.abs(z) < 4), north = rankAt((x, z) => z < -3 && Math.abs(x) < 4), south = rankAt((x, z) => z > 3 && Math.abs(x) < 4);
  expect(west).toBeGreaterThan(south);
  expect(north).toBe(south - 1);
});

test('priority_road raises the rank', () => {
  const roads = [road([{ x: -100, z: 0 }, o], 'residential', true), road([o, { x: 100, z: 0 }], 'residential', true), road([{ x: 0, z: -100 }, o]), road([o, { x: 0, z: 100 }])];
  const n = net(roads);
  const j = centre(n.junctions);
  const ranks = j.approaches.map((a) => a.rank).sort();
  expect(ranks[0]).toBeLessThan(ranks[3]!);
});

test('a midblock signal gets a pedestrian phase', () => {
  const n = net([road([{ x: -100, z: 0 }, { x: 100, z: 0 }])], { signals: [{ x: 10, z: 0 }], crossings: [{ x: 10, z: 0 }] });
  const mb = n.junctions.filter((j) => j.signal?.midblock);
  expect(mb.length).toBe(1);
  expect(mb[0]!.approaches.length).toBe(2);
  expect(mb[0]!.peds.length).toBe(1);
  expect(mb[0]!.peds[0]!.group).toBe(1);
  for (const a of mb[0]!.approaches) expect(a.group).toBe(0);
});

test('a signal node lights only its nearest junction', () => {
  // two junctions 25 m apart, one signal 5 m from the first
  const roads = [...cross4(), road([{ x: 100, z: 0 }, { x: 125, z: 0 }]), road([{ x: 25, z: -100 }, { x: 25, z: 0 }]), road([{ x: 25, z: 0 }, { x: 25, z: 100 }])];
  const r = roads.map((x) => x);
  // the east arm of the cross passes x = 25: split it there
  r[1] = road([o, { x: 25, z: 0 }]);
  r.push(road([{ x: 25, z: 0 }, { x: 100, z: 0 }]));
  const js = net(r, { signals: [{ x: 4, z: 3 }] }).junctions;
  expect(js.filter((j) => j.signal).length).toBe(1);
  expect(Math.hypot(js.find((j) => j.signal)!.x, js.find((j) => j.signal)!.z)).toBeLessThan(1);
});

test('junctions get different signal offsets', () => {
  const roads = [...cross4(), road([{ x: 100, z: 0 }, { x: 200, z: 0 }]), road([{ x: 100, z: -100 }, { x: 100, z: 0 }]), road([{ x: 100, z: 0 }, { x: 100, z: 100 }])];
  const js = net(roads, { signals: [o, { x: 100, z: 0 }] }).junctions.filter((j) => j.signal && !j.signal.midblock);
  expect(js.length).toBe(2);
  expect(js[0]!.signal!.offsetTicks).not.toBe(js[1]!.signal!.offsetTicks);
});
