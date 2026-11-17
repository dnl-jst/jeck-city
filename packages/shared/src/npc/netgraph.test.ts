import { expect, test } from 'vitest';
import { GraphIndex, parseNpcNet, type NetGraph } from './netgraph';

const g: NetGraph = {
  nodes: [[0, 0], [10, 0], [10, 10]],
  edges: [
    { a: 0, b: 1, pts: [[0, 0], [5, 0], [10, 0]], width: 2, oneway: false },
    { a: 1, b: 2, pts: [[10, 0], [10, 10]], width: 2, oneway: true },
  ],
};

test('GraphIndex: out edges respect one-way edges', () => {
  const ix = new GraphIndex(g);
  expect(ix.out(0)).toEqual([0]);
  expect(ix.out(1).sort()).toEqual([0, 1]);
  expect(ix.out(2)).toEqual([]); // edge 1 runs 1 → 2 only
});

test('GraphIndex.nearestEdge finds the edge and the distance along it', () => {
  const ix = new GraphIndex(g);
  const n = ix.nearestEdge(4, 1)!;
  expect(n.edge).toBe(0);
  expect(n.s).toBeCloseTo(4, 6);
  expect(n.d).toBeCloseTo(1, 6);
  expect(ix.nearestEdge(500, 500, 20)).toBeNull();
});

test('parseNpcNet accepts a good net and rejects bad input', () => {
  const net = { version: 1, walk: g, drive: { nodes: [], edges: [] }, cycle: { nodes: [], edges: [] }, seats: [], junctions: [] };
  expect(parseNpcNet(JSON.parse(JSON.stringify(net))).walk.edges.length).toBe(2);
  expect(() => parseNpcNet({ ...net, version: 2 })).toThrow();
  expect(() => parseNpcNet({ ...net, walk: { nodes: [[0, 0]], edges: [{ a: 0, b: 5, pts: [[0, 0], [1, 1]], width: 1, oneway: false }] } })).toThrow();
  expect(() => parseNpcNet(null)).toThrow();
});
