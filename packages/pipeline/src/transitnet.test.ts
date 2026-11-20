import { expect, test } from 'vitest';
import { parseRoutes } from './transitnet.js';

// three ways in a row along the meridian (about 111 m each), the middle one drawn the other way round and in a tunnel
const ll = (lat: number) => ({ lat, lon: 6.95 });
const way = (id: number, a: number, b: number, tags: Record<string, string> = {}) =>
  ({ type: 'way', id, tags: { railway: 'light_rail', ...tags }, geometry: [ll(a), ll((a + b) / 2), ll(b)] });
const osm = { elements: [
  way(1, 50.95, 50.951), way(2, 50.952, 50.951, { tunnel: 'yes', layer: '-2' }), way(3, 50.952, 50.953),
  { type: 'node', id: 10, lat: 50.9505, lon: 6.95, tags: { name: 'Erste' } },
  { type: 'node', id: 11, lat: 50.9525, lon: 6.95, tags: { name: 'Zweite' } },
  { type: 'node', id: 12, lat: 50.9525, lon: 6.96, tags: { name: 'Abseits' } },
] };
const relation = (members: { type: string; ref: number; role: string }[]) => ({ elements: [{ type: 'relation', id: 1, tags: { type: 'route', route: 'tram', ref: '12', from: 'A', to: 'B' }, members }] });

test('a route joins its ways end to end in travel order, whichever way they are drawn', () => {
  const [r] = parseRoutes(osm, relation([
    { type: 'node', ref: 10, role: 'stop' }, { type: 'way', ref: 1, role: '' }, { type: 'way', ref: 2, role: '' },
    { type: 'node', ref: 11, role: 'stop' }, { type: 'node', ref: 12, role: 'stop' }, { type: 'way', ref: 3, role: '' }, { type: 'way', ref: 99, role: 'platform' },
  ]));
  expect(r).toMatchObject({ ref: '12', from: 'A', to: 'B' });
  expect(r!.pts).toHaveLength(7);
  // north is −z: the path runs north all the way
  for (let i = 1; i < r!.pts.length; i++) expect(r!.pts[i]!.z).toBeLessThan(r!.pts[i - 1]!.z);
  expect(r!.kind).toEqual(['surface', 'surface', 'surface', 'tunnel', 'tunnel', 'surface', 'surface']);
  expect(r!.layer[3]).toBe(-2);
  // the stops on the track, by distance; the one 700 m beside it is left out
  expect(r!.stops.map((s) => s.name)).toEqual(['Erste', 'Zweite']);
  expect(r!.stops[0]!.s).toBeGreaterThan(50);
  expect(r!.stops[0]!.s).toBeLessThan(60);
  expect(r!.stops[1]!.s).toBeGreaterThan(270);
});

test('ways outside the fetched area cut the route: the longest run inside counts', () => {
  const [r] = parseRoutes(osm, relation([{ type: 'way', ref: 1, role: '' }, { type: 'way', ref: 50, role: '' }, { type: 'way', ref: 2, role: '' }, { type: 'way', ref: 3, role: '' }]));
  expect(r!.pts).toHaveLength(5); // ways 2 and 3
});
