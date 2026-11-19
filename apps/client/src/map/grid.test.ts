import { describe, expect, it } from 'vitest';
import type { MapData } from '@nn/shared';
import { MapGrid } from './grid';

const data = (over: Partial<MapData>): MapData => ({
  version: 1, bounds: { minX: 0, minZ: 0, maxX: 1000, maxZ: 1000 }, boundary: [], roads: [], buildings: [], greens: [], water: [],
  squares: [], tram: [], tramStops: [], ...over,
});

describe('MapGrid', () => {
  it('returns roads crossing the query box', () => {
    const g = new MapGrid(data({ roads: [{ kind: 'x', width: 4, pts: [-500, 50, 600, 50] }, { kind: 'x', width: 4, pts: [0, 900, 10, 900] }] }));
    expect(g.query(250, 40, 260, 60).roads).toEqual([0]);
  });
  it('no duplicates for features spanning several cells', () => {
    const g = new MapGrid(data({ roads: [{ kind: 'x', width: 4, pts: [0, 0, 900, 900] }], greens: [[0, 0, 500, 0, 500, 500]] }));
    const r = g.query(0, 0, 1000, 1000);
    expect(r.roads).toEqual([0]);
    expect(r.greens).toEqual([0]);
  });
  it('empty query far away returns empty lists', () => {
    const g = new MapGrid(data({
      roads: [{ kind: 'x', width: 4, pts: [0, 0, 10, 10] }], buildings: [[0, 0, 5, 0, 5, 5]], tram: [[0, 0, 5, 5]],
      squares: [{ name: '', pts: [0, 0, 5, 5] }],
    }));
    expect(g.query(5000, 5000, 5100, 5100)).toEqual({ roads: [], buildings: [], greens: [], squares: [], tram: [] });
  });
});
