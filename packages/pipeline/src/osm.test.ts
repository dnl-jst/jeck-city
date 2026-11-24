import { expect, test } from 'vitest';
import { loadFixture } from './fixture.js';
import { parseOsm } from './osm.js';

test('fixture feature counts', () => {
  const f = loadFixture();
  expect(f.roads.filter((r) => r.kind === 'residential')).toHaveLength(2);
  expect(f.roads).toHaveLength(5); // + footway + two Doppelstraße carriageways
  expect(f.trees).toHaveLength(3);
  expect(f.lamps).toHaveLength(2);
  expect(f.shops).toEqual([expect.objectContaining({ name: 'Backstube Nippes', type: 'bakery' })]);
  expect(f.tramTracks).toHaveLength(2); // tram + light_rail; mainline rail ignored
  expect(f.tramStops.map((s) => s.name)).toEqual(['Florastr.']); // tram_stop, stop_position and platform collapse to one;
  expect(f.greens).toHaveLength(1);
});

test('subway entrances and mainline rail bridges do not leak into roads, tracks, stops or shops', () => {
  const f = parseOsm({ elements: [
    { type: 'node', id: 1, lat: 50.9638, lon: 6.9538, tags: { railway: 'subway_entrance', name: 'Florastraße', level: '0;-2' } },
    { type: 'way', id: 2, tags: { railway: 'rail', bridge: 'yes', layer: '1' }, geometry: [{ lat: 50.96, lon: 6.94 }, { lat: 50.961, lon: 6.94 }] },
  ] });
  expect([f.roads, f.tramTracks, f.tramStops, f.shops, f.greens]).toEqual([[], [], [], [], []]);
});

test('residential road without tags is 2 × 3.0 m wide, two-way, two lanes', () => {
  const r = loadFixture().roads.find((x) => x.name === 'Teststraße')!;
  expect(r).toMatchObject({ kind: 'residential', width: 6.0, oneway: false, lanes: 2 });
});

test('width tag beats lanes; oneway parsed', () => {
  const mk = (tags: Record<string, string>) =>
    parseOsm({ elements: [{ type: 'way', id: 1, tags: { highway: 'tertiary', ...tags }, geometry: [{ lat: 50.96, lon: 6.95 }, { lat: 50.961, lon: 6.95 }] }] }).roads[0]!;
  expect(mk({}).width).toBe(6.5);
  expect(mk({ lanes: '3' }).width).toBe(9.75);
  expect(mk({ lanes: '2', width: '7.2' }).width).toBe(7.2);
  expect(mk({ oneway: 'yes' }).oneway).toBe(true);
});

test('closed square area becomes a square, not a road', () => {
  const f = loadFixture();
  expect(f.squares).toHaveLength(1);
  expect(f.squares[0]!.name).toBe('Testplatz');
  expect(f.roads.some((r) => r.kind === 'pedestrian')).toBe(false);
});

test('boundary relation parts are joined (one reversed) into a closed ring', () => {
  const b = loadFixture().boundary;
  expect(b).toHaveLength(5);
  expect(b[0]).toEqual(b[4]);
  expect(new Set(b.map((p) => `${p.x.toFixed(0)},${p.z.toFixed(0)}`)).size).toBe(4);
});

test('Nippes and Neustadt-Nord join into one play area; their shared border way drops out', () => {
  const way = (ref: number, pts: [number, number][]) => ({ type: 'way', ref, role: 'outer', geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  const rel = (id: number, members: unknown[]) => ({ type: 'relation', id, tags: { boundary: 'administrative' }, members });
  // two unit squares stacked north–south, sharing way 3 (the lat 50.96 edge)
  const f = parseOsm({ elements: [
    rel(2613766, [way(1, [[50.96, 6.95], [50.97, 6.95], [50.97, 6.96]]), way(2, [[50.97, 6.96], [50.96, 6.96]]), way(3, [[50.96, 6.96], [50.96, 6.95]])]),
    rel(2613763, [way(3, [[50.96, 6.96], [50.96, 6.95]]), way(4, [[50.96, 6.95], [50.95, 6.95], [50.95, 6.96], [50.96, 6.96]])]),
  ] });
  expect(f.boundary).toHaveLength(7); // 6 corners, closed
  expect(f.boundary[0]).toEqual(f.boundary[6]);
  const zs = f.boundary.map((p) => p.z);
  expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(2000); // spans both squares (~2.2 km north–south)
});

test('cafés, restaurants, bars and pharmacies (amenity) count as shops; address kept', () => {
  const node = (id: number, tags: Record<string, string>) => ({ type: 'node', id, lat: 50.96, lon: 6.95, tags });
  const f = parseOsm({ elements: [
    node(1, { amenity: 'cafe', name: 'Café X', 'addr:street': 'Neusser Straße', 'addr:housenumber': '12' }),
    node(2, { amenity: 'pharmacy' }),
    node(3, { amenity: 'bench' }),
    node(4, { shop: 'kiosk', amenity: 'pub' }),
  ] });
  expect(f.shops.map((s) => s.type)).toEqual(['cafe', 'pharmacy', 'kiosk']);
  expect(f.shops[0]).toMatchObject({ name: 'Café X', street: 'Neusser Straße', housenumber: '12' });
});

test('railway and embankment land is green', () => {
  const sq = (landuse: string, id: number) => ({
    type: 'way' as const, id, tags: { landuse },
    geometry: [{ lat: 50.96, lon: 6.95 }, { lat: 50.96, lon: 6.951 }, { lat: 50.961, lon: 6.951 }, { lat: 50.96, lon: 6.95 }],
  });
  const g = (landuse: string) => parseOsm({ elements: [sq(landuse, 1)] }).greens.length;
  expect(g('railway')).toBe(1);
  expect(g('allotments')).toBe(1);
  for (const l of ['meadow', 'forest', 'flowerbed', 'brownfield']) expect(g(l)).toBe(1);
  expect(g('residential')).toBe(0);
});

test('bicycle parking: kinds, capacity default, areas with outline', () => {
  const node = (id: number, tags: Record<string, string>) => ({ type: 'node', id, lat: 50.96, lon: 6.95 + id * 1e-4, tags: { amenity: 'bicycle_parking', ...tags } });
  const f = parseOsm({ elements: [
    node(1, { bicycle_parking: 'stands', capacity: '8' }),
    node(2, {}),
    node(3, { bicycle_parking: 'wall_loops', capacity: 'viele' }),
    node(4, { bicycle_parking: 'lockers' }),
    { type: 'way', id: 5, tags: { amenity: 'bicycle_parking', bicycle_parking: 'rack', capacity: '20' }, geometry: [{ lat: 50.96, lon: 6.95 }, { lat: 50.96, lon: 6.9501 }, { lat: 50.96005, lon: 6.9501 }, { lat: 50.96, lon: 6.95 }] },
  ] });
  expect(f.bikeParking.map((b) => [b.kind, b.capacity])).toEqual([['stands', 8], ['stands', 6], ['wall', 6], ['other', 6], ['stands', 20]]);
  expect(f.bikeParking[4]!.outline).toHaveLength(3);
});

test('a pedestrian multipolygon (e.g. Kardinal-Höffner-Platz) becomes a square', () => {
  const way = (ref: number, pts: [number, number][]) => ({ type: 'way', ref, role: 'outer', geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  const f = parseOsm({ elements: [
    { type: 'relation', id: 7843405, tags: { type: 'multipolygon', highway: 'pedestrian', name: 'Kardinal-Höffner-Platz' }, members: [
      way(1, [[50.941, 6.956], [50.9415, 6.956], [50.9415, 6.9565]]), way(2, [[50.9415, 6.9565], [50.941, 6.9565], [50.941, 6.956]]),
    ] },
  ] });
  expect(f.squares).toHaveLength(1);
  expect(f.squares[0]!.name).toBe('Kardinal-Höffner-Platz');
  expect(f.squares[0]!.outline.length).toBeGreaterThanOrEqual(4);
});

test('shops get the name of the Stadtteil they lie in', () => {
  const way = (ref: number, pts: [number, number][]) => ({ type: 'way', ref, role: 'outer', geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  const rel = (id: number, name: string, members: unknown[]) => ({ type: 'relation', id, tags: { boundary: 'administrative', name }, members });
  const shop = (id: number, lat: number) => ({ type: 'node', id, lat, lon: 6.955, tags: { shop: 'bakery' } });
  const f = parseOsm({ elements: [
    shop(10, 50.965), shop(11, 50.955), shop(12, 50.945),
    rel(2613766, 'Nippes', [way(1, [[50.96, 6.95], [50.97, 6.95], [50.97, 6.96]]), way(2, [[50.97, 6.96], [50.96, 6.96]]), way(3, [[50.96, 6.96], [50.96, 6.95]])]),
    rel(2613763, 'Neustadt/Nord', [way(3, [[50.96, 6.96], [50.96, 6.95]]), way(4, [[50.96, 6.95], [50.95, 6.95], [50.95, 6.96], [50.96, 6.96]])]),
  ] });
  expect(f.shops.map((s) => s.district)).toEqual(['Nippes', 'Neustadt/Nord', undefined]);
});
