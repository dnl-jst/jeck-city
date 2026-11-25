import { describe, expect, it } from 'vitest';
import { recordOf } from './buildingstore.js';
import { boxBuilding, boxRecord, loadFixture } from './fixture.js';
import { buildMapData } from './map.js';

describe('buildMapData', () => {
  it('keeps all roads with name and kind', () => {
    const f = loadFixture();
    const m = buildMapData(f, []);
    expect(m.roads.length).toBe(f.roads.length);
    f.roads.forEach((r, i) => {
      expect(m.roads[i]!.kind).toBe(r.kind);
      if (r.name) expect(m.roads[i]!.name).toBe(r.name);
    });
  });

  it('rounds coordinates to 0.1 m', () => {
    const m = buildMapData(loadFixture(), []);
    for (const r of m.roads) for (const v of r.pts) expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
  });

  it('building footprint = roof triangles in xz', () => {
    const m = buildMapData(loadFixture(), [boxRecord('b', 0, 0, 10, 20, 8)]);
    const t = m.buildings[0]!;
    expect(t.length % 6).toBe(0);
    let area = 0;
    for (let i = 0; i < t.length; i += 6) {
      area += Math.abs((t[i]! * (t[i + 3]! - t[i + 5]!) + t[i + 2]! * (t[i + 5]! - t[i + 1]!) + t[i + 4]! * (t[i + 1]! - t[i + 3]!)) / 2);
    }
    expect(Math.abs(area - 200)).toBeLessThan(0.5);
    for (let i = 0; i < t.length; i += 2) {
      expect(t[i]).toBeGreaterThanOrEqual(0);
      expect(t[i]).toBeLessThanOrEqual(10);
      expect(t[i + 1]).toBeGreaterThanOrEqual(0);
      expect(t[i + 1]).toBeLessThanOrEqual(20);
    }
  });

  it('wall-only triangles are dropped', () => {
    const b = boxBuilding('b', 0, 0, 10, 20, 8);
    b.kind.fill(0);
    expect(buildMapData(loadFixture(), [recordOf(b, 0)]).buildings.length).toBe(0);
  });

  it('bounds enclose boundary and all roads', () => {
    const f = loadFixture();
    const m = buildMapData(f, []);
    for (const p of [...f.boundary, ...f.roads.flatMap((r) => r.points)]) {
      expect(p.x).toBeGreaterThanOrEqual(m.bounds.minX);
      expect(p.x).toBeLessThanOrEqual(m.bounds.maxX);
      expect(p.z).toBeGreaterThanOrEqual(m.bounds.minZ);
      expect(p.z).toBeLessThanOrEqual(m.bounds.maxZ);
    }
  });

  it('squares and tram stops pass through', () => {
    const f = loadFixture();
    const m = buildMapData(f, []);
    expect(m.squares.map((s) => s.name)).toEqual(f.squares.map((s) => s.name));
    expect(m.tramStops.map((s) => s.name)).toEqual(f.tramStops.map((s) => s.name));
  });
});
