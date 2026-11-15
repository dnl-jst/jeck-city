import { expect, test } from 'vitest';
import { boxBuilding, crossOf } from './fixture.js';
import type { Road } from './osm.js';
import { assignShops, classifyBuildings, PARKED_PALETTE, parkedCars, shopSign } from './placements.js';

const boundary = [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }, { x: 0, z: 0 }];

test('buildings inside keep their flags, within 150 m outside get the backdrop bit, farther ones are dropped', () => {
  const kept = classifyBuildings([
    boxBuilding('in', 10, 10, 20, 20, 5, 1),
    boxBuilding('near', 400, 10, 420, 20, 5, 1), // centroid 110 m east of the boundary
    boxBuilding('far', 460, 10, 480, 20, 5), // 170 m
  ], boundary);
  expect(kept.map((b) => [b.id, b.flags])).toEqual([['in', 1], ['near', 3]]);
});

test('shops: inside the boundary only, labelled by type, assigned to containing or nearest building within 15 m', () => {
  const buildings = classifyBuildings([boxBuilding('A', 10, 10, 30, 30, 10), boxBuilding('B', 100, 100, 120, 120, 10), boxBuilding('X', 305, 10, 320, 20, 10)], boundary);
  const shops = assignShops([
    { pos: { x: 20, z: 20 }, type: 'bakery', name: 'Backstube' },
    { pos: { x: 110, z: 130 }, type: 'kiosk' }, // 10 m south of B
    { pos: { x: 200, z: 200 }, type: 'florist' }, // nothing within 15 m
    { pos: { x: 310, z: 15 }, type: 'butcher' }, // outside the boundary, inside a backdrop building
  ], boundary, buildings);
  expect(shops).toEqual([
    { x: 20, z: 20, label: 'bakery', type: 'bakery', buildingId: 'A' },
    { x: 110, z: 130, label: 'kiosk', type: 'kiosk', buildingId: 'B' },
    { x: 200, z: 200, label: 'florist', type: 'florist' },
  ]);
});

test('parked car colours are deterministic palette picks', () => {
  const spots = Array.from({ length: 50 }, (_, i) => ({ pos: { x: i, z: 0 }, heading: 0.5 }));
  const a = parkedCars(spots, 42);
  expect(a).toEqual(parkedCars(spots, 42));
  expect(a[3]).toMatchObject({ x: 3, z: 0, heading: 0.5 });
  for (const c of a) expect(PARKED_PALETTE).toContain(c.color);
  expect(new Set(a.map((c) => c.color)).size).toBeGreaterThan(4);
  expect(parkedCars(spots, 43).map((c) => c.color)).not.toEqual(a.map((c) => c.color));
});

const road = (points: [number, number][]): Road => ({ id: 1, kind: 'residential', points: points.map(([x, z]) => ({ x, z })), width: 6.5, oneway: false, lanes: 1, cross: crossOf('residential', 6.5) });

test('shop sign goes on the wall facing the street, centred on the shop, reading outwards', () => {
  const b = boxBuilding('A', 10, 10, 30, 30, 10);
  const east = shopSign(b, { x: 25, z: 16 }, [road([[40, -50], [40, 80]])])!;
  expect(east.x).toBeGreaterThan(30);
  expect(east.x).toBeLessThan(30.2);
  expect(east.z).toBeCloseTo(16, 1);
  expect(east.heading).toBeCloseTo(Math.PI / 2); // faces +x, towards the road
  expect(east.width).toBeGreaterThan(2);
  expect(east.width).toBeLessThanOrEqual(6);
  const north = shopSign(b, { x: 20, z: 12 }, [road([[-50, 0], [80, 0]])])!;
  expect(north.z).toBeLessThan(10);
  expect(Math.abs(north.heading)).toBeCloseTo(Math.PI); // faces −z
  expect(shopSign(b, { x: 20, z: 12 }, [])).toBeUndefined();
});

test('assignShops keeps a given label and adds the sign when roads are passed', () => {
  const buildings = [boxBuilding('A', 10, 10, 30, 30, 10)];
  const [s] = assignShops([{ pos: { x: 25, z: 20 }, type: 'cafe', label: 'Café Klaaf' }], boundary, buildings, [road([[40, -50], [40, 80]])]);
  expect(s).toMatchObject({ label: 'Café Klaaf', type: 'cafe', buildingId: 'A', sign: { heading: expect.closeTo(Math.PI / 2, 3) } });
});
