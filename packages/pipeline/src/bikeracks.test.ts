import { describe, expect, test } from 'vitest';
import { crossSectionFromTags } from './crosssection.js';
import { boxBuilding, loadFixture } from './fixture.js';
import type { OsmFeatures, Pt, Road } from './osm.js';
import { dropCarsAtRacks, fillRacks, layoutRacks, spawnBikeSpot, type RackRow } from './bikeracks.js';
import { onCarriageway, sideOffsets } from './roadprofile.js';

const mk = (id: number, kind: string, pts: [number, number][], tags: Record<string, string> = {}): Road => {
  const cross = crossSectionFromTags(tags, kind);
  return { id, kind, points: pts.map(([x, z]) => ({ x, z })), width: cross.carriageway, oneway: tags.oneway === 'yes', lanes: cross.lanesForward + cross.lanesBackward, cross };
};
type Parking = OsmFeatures['bikeParking'][number];
const world = (roads: Road[], bikeParking: Parking[], extra: Partial<OsmFeatures> = {}): OsmFeatures => ({
  ...loadFixture(), roads, tramTracks: [], tramStops: [], bikeParking,
  boundary: [{ x: -500, z: -500 }, { x: 500, z: -500 }, { x: 500, z: 500 }, { x: -500, z: 500 }],
  ...extra,
});
// way runs east (+x); right of travel = +z
const ROAD: [number, number][] = [[-200, 0], [200, 0]];
const stands = (x: number, z: number, capacity = 8): Parking => ({ pos: { x, z }, kind: 'stands', capacity });
const hoops = (rows: RackRow[]) => rows.flatMap((r) => r.hoops);

describe('layoutRacks', () => {
  test('node rack along the road: hoops 1 m apart, row parallel, bikes perpendicular facing the road', () => {
    const r = mk(1, 'residential', ROAD);
    const kerb = sideOffsets(r.cross).right.kerb;
    const rows = layoutRacks(world([r], [stands(10, kerb + 1.5, 8)]), []);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.hoops).toHaveLength(4);
    expect(row.inStrip).toBe(false);
    const xs = row.hoops.map((h) => h.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(1, 6);
    for (const h of row.hoops) expect(h.z).toBeCloseTo(kerb + 1.5, 6);
    // the rack is right of the road (+z): bikes face −z, towards the road
    expect(Math.sin(row.heading)).toBeCloseTo(0, 6);
    expect(Math.cos(row.heading)).toBeCloseTo(-1, 6);
  });

  test('missing capacity gives 3 hoops; capacity 122 gives rows of at most 12, all hoops ≥ 1 m apart', () => {
    const r = mk(1, 'residential', ROAD);
    const kerb = sideOffsets(r.cross).right.kerb;
    expect(hoops(layoutRacks(world([r], [{ pos: { x: 0, z: kerb + 2 }, kind: 'stands', capacity: 6 }]), []))).toHaveLength(3);
    const big = layoutRacks(world([r], [stands(0, kerb + 3, 122)]), []);
    expect(hoops(big)).toHaveLength(61);
    for (const row of big) expect(row.hoops.length).toBeLessThanOrEqual(12);
    const all = hoops(big);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      expect(Math.hypot(all[i]!.x - all[j]!.x, all[i]!.z - all[j]!.z)).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  test('drops racks in buildings, on tracks and outside the play area', () => {
    const r = mk(1, 'residential', ROAD);
    const kerb = sideOffsets(r.cross).right.kerb;
    const house = boxBuilding('B1', -20, kerb + 4, 20, kerb + 20, 10);
    expect(hoops(layoutRacks(world([r], [stands(0, kerb + 8)]), [house]))).toHaveLength(0);
    const track: Pt[] = [{ x: -100, z: 30 }, { x: 100, z: 30 }];
    expect(hoops(layoutRacks(world([r], [stands(0, 30)], { tramTracks: [track] }), []))).toHaveLength(0);
    expect(hoops(layoutRacks(world([r], [stands(0, 600)]), []))).toHaveLength(0);
  });

  test('a rack mapped right at a facade moves out so hoop and bikes stay clear of the wall', () => {
    const r = mk(1, 'residential', ROAD);
    const kerb = sideOffsets(r.cross).right.kerb;
    const wall = kerb + 4;
    const house = boxBuilding('B1', -30, wall, 30, wall + 15, 10);
    for (const kind of ['stands', 'wall'] as const) {
      const rows = layoutRacks(world([r], [{ pos: { x: 0, z: wall - 0.3 }, kind, capacity: 6 }]), [house]);
      expect(hoops(rows).length, kind).toBe(3);
      const bikes = fillRacks(rows, 3, [house]);
      for (const row of rows) for (const h of row.hoops) {
        // the bikes stand along the heading, ±0.95 m around the hoop
        expect(h.z + 0.95 * Math.abs(Math.cos(row.heading)), kind).toBeLessThan(wall);
      }
      for (const b of bikes) {
        const half = b.type >= 3 ? 1.3 : 0.95;
        expect(b.z + half * Math.abs(Math.cos(b.heading)), kind).toBeLessThan(wall + 1e-9);
      }
    }
  });

  test('rack in a parking strip stays there, and parked cars next to it go', () => {
    const r = mk(1, 'residential', ROAD, { 'parking:right': 'lane' });
    const o = sideOffsets(r.cross).right;
    const z = (o.cycle + o.kerb) / 2;
    const rows = layoutRacks(world([r], [stands(0, z, 6)]), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inStrip).toBe(true);
    for (const h of rows[0]!.hoops) expect(h.z).toBeCloseTo(z, 6);
    const cars = [{ pos: { x: 2, z } }, { pos: { x: 30, z } }];
    expect(dropCarsAtRacks(cars, rows)).toEqual([{ pos: { x: 30, z } }]);
  });

  test('rack in a driving lane moves to the sidewalk', () => {
    const r = mk(1, 'residential', ROAD);
    const rows = layoutRacks(world([r], [stands(0, 1, 6)]), []);
    for (const h of hoops(rows)) expect(onCarriageway(r, h)).toBe(false);
    expect(hoops(rows)).toHaveLength(3);
  });

  test('wall loops become kind 1, lockers are skipped', () => {
    const r = mk(1, 'residential', ROAD);
    const kerb = sideOffsets(r.cross).right.kerb;
    const rows = layoutRacks(world([r], [{ pos: { x: 0, z: kerb + 2 }, kind: 'wall', capacity: 4 }, { pos: { x: 30, z: kerb + 2 }, kind: 'other', capacity: 4 }]), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(1);
  });
});

describe('fillRacks', () => {
  const r = mk(1, 'residential', ROAD);
  const kerb = sideOffsets(r.cross).right.kerb;
  const many = Array.from({ length: 25 }, (_, i) => stands(-180 + i * 15, kerb + 2, 16)); // 25 × 8 hoops × 2 slots = 400
  const rows = layoutRacks(world([r], many), []);

  test('fill is deterministic and about half, with the target type mix', () => {
    const a = fillRacks(rows, 42);
    expect(fillRacks(rows, 42)).toEqual(a);
    expect(a.length).toBeGreaterThanOrEqual(130);
    expect(a.length).toBeLessThanOrEqual(240);
    // cargo bikes take a whole hoop, so count slots: cargo 2, others 1
    const slots = [0, 0, 0, 0, 0];
    for (const b of a) slots[b.type]! += b.type >= 3 ? 2 : 1;
    const total = slots.reduce((s, v) => s + v, 0);
    const share = slots.map((v) => v / total);
    const want = [0.45, 0.15, 0.2, 0.1, 0.1]; // dutch, road, mtb, longjohn, trike
    want.forEach((w, i) => expect(Math.abs(share[i]! - w)).toBeLessThan(0.08));
  });

  test('bikes do not overlap each other or the hoops', () => {
    const bikes = fillRacks(rows, 7);
    const all = hoops(rows);
    for (const b of bikes) {
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      const half = b.type >= 3 ? 0.45 : 0.15;
      for (const h of all) {
        const dx = h.x - b.x, dz = h.z - b.z;
        const along = Math.abs(dx * fx + dz * fz), across = Math.abs(dx * fz - dz * fx);
        expect(along > 1.6 || across > half + 0.03).toBe(true);
      }
    }
    for (let i = 0; i < bikes.length; i++) for (let j = i + 1; j < bikes.length; j++) {
      expect(Math.hypot(bikes[i]!.x - bikes[j]!.x, bikes[i]!.z - bikes[j]!.z)).toBeGreaterThan(0.4);
    }
  });
});

describe('spawnBikeSpot', () => {
  test('spawn bike ~2.2 m behind the player, parallel, clear of buildings', () => {
    const spawn = { x: 0, z: 0, heading: Math.PI / 2 }; // facing +x
    const b = spawnBikeSpot(world([], []), spawn, []);
    expect(b.x).toBeCloseTo(-2.2, 5);
    expect(b.z).toBeCloseTo(0, 5);
    expect(b.heading).toBe(spawn.heading);
    // a house right behind at 2.2 m: the next distance that clears it
    const c = spawnBikeSpot(world([], []), spawn, [boxBuilding('B', -2.4, -1, -2.0, 1, 5)]);
    expect(c.x).toBeCloseTo(-1.8, 5);
  });
});
