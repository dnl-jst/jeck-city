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
