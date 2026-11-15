import { describe, expect, it } from 'vitest';
import type { MapData } from '@nn/shared';
import { MapGrid } from './grid';
import { StreetTracker } from './street';

const data: MapData = {
  version: 1, bounds: { minX: -300, minZ: -300, maxX: 300, maxZ: 300 }, boundary: [],
  roads: [
    { kind: 'residential', name: 'A', width: 6, pts: [-100, 0, 100, 0] },
    { kind: 'residential', name: 'B', width: 6, pts: [0, -100, 0, 100] },
    { kind: 'footway', width: 2, pts: [-100, 5, 100, 5] },
  ],
  buildings: [], greens: [], squares: [], tram: [], tramStops: [],
};
const make = () => new StreetTracker(data, new MapGrid(data));

describe('StreetTracker', () => {
  it('names the nearest named road', () => {
    expect(make().update(50, 3)).toBe('A');
  });
  it('keeps the current name near a junction', () => {
    const t = make();
    t.update(50, 3);
    expect(t.update(2, 2.5)).toBe('A');
  });
  it('switches when clearly closer', () => {
    const t = make();
    t.update(50, 3);
    t.update(2, 2.5);
    expect(t.update(1, 40)).toBe('B');
  });
  it('empty when nothing within 25 m', () => {
    const t = make();
    t.update(50, 3);
    expect(t.update(200, 200)).toBe('');
  });
});
