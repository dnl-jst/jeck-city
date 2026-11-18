import { describe, expect, it } from 'vitest';
import type { MapData } from '@nn/shared';
import { MapGrid } from './grid';
import { placeLabels, minScaleFor } from './labels';
import type { MapView } from './view';

const data = (over: Partial<MapData>): MapData => ({
  version: 1, bounds: { minX: -5000, minZ: -5000, maxX: 5000, maxZ: 5000 }, boundary: [], roads: [], buildings: [], greens: [], water: [],
  squares: [], tram: [], tramStops: [], ...over,
});
const view = (scale: number, over: Partial<MapView> = {}): MapView => ({ cx: 0, cz: 0, scale, rot: 0, w: 2400, h: 800, ...over });
const measure = (t: string) => t.length * 7;
const run = (d: MapData, v: MapView) => placeLabels(d, new MapGrid(d).query(-5000, -5000, 5000, 5000), v, measure);
const road = (name: string, pts: number[], kind = 'primary') => ({ kind, name, width: 6, pts });

describe('placeLabels', () => {
  it('never upside down', () => {
    const l = run(data({ roads: [road('Neusser Strasse', [200, 0, -200, 0])] }), view(1));
    expect(l).toHaveLength(1);
    expect(l[0]!.angle).toBeGreaterThan(-Math.PI / 2);
    expect(l[0]!.angle).toBeLessThanOrEqual(Math.PI / 2);
  });
  it('places the label at the segment midpoint along its direction', () => {
    const l = run(data({ roads: [road('Abc', [0, 0, 0, 100])] }), view(1));
    expect(l[0]!.sx).toBeCloseTo(1200);
    expect(l[0]!.sy).toBeCloseTo(450);
    expect(Math.abs(l[0]!.angle)).toBeCloseTo(Math.PI / 2);
  });
  it('drops overlapping labels', () => {
    const l = run(data({ roads: [road('Erste Strasse', [-100, 0, 100, 0]), road('Zweite Strasse', [-100, 3, 100, 3])] }), view(1));
    expect(l).toHaveLength(1);
  });
  it('hides minor roads when zoomed out', () => {
    const d = data({ roads: [road('Fussweg', [-100, 0, 100, 0], 'footway')] });
    expect(run(d, view(1))).toHaveLength(0);
    expect(run(d, view(2))).toHaveLength(1);
  });
  it('skips segments shorter than the text', () => {
    expect(run(data({ roads: [road('Langer Name', [0, 0, 10, 0])] }), view(1))).toHaveLength(0);
  });
  it('labels the midpoint of a collinear run', () => {
    const l = run(data({ roads: [road('Ab', [0, 0, 20, 0, 120, 0])] }), view(1));
    expect(l[0]!.sx).toBeCloseTo(1200 + 60);
  });
  it('labels a gently curved road made of many short segments', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 15; i++) { const a = i * 0.03; pts.push(Math.sin(a) * 667, 667 - Math.cos(a) * 667); }
    const l = run(data({ roads: [road('Kurvenstrasse', pts)] }), view(1));
    expect(l).toHaveLength(1);
    expect(Number.isFinite(l[0]!.angle)).toBe(true);
  });
  it('skips a road with a sharp corner whose legs are shorter than the text', () => {
    expect(run(data({ roads: [road('Eckstrasse Lang', [0, 0, 60, 0, 60, 60])] }), view(1))).toHaveLength(0);
  });
  it('ignores roads with fewer than two points', () => {
    expect(run(data({ roads: [road('Punkt', [5, 5]), road('Leer', [])] }), view(1))).toHaveLength(0);
  });
  it('same name repeats only far apart', () => {
    const roads = [];
    for (let i = 0; i < 20; i++) roads.push(road('Hauptstr', [i * 100 - 1000, 0, i * 100 - 900, 0]));
    const l = run(data({ roads }), view(1));
    expect(l.length).toBeGreaterThan(1);
    const xs = l.map((x) => x.sx).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(300);
  });
  it('unnamed squares get no label', () => {
    const sq = { name: '', pts: [0, 0, 50, 0, 50, 50, 0, 50] };
    expect(run(data({ squares: [sq] }), view(1))).toHaveLength(0);
  });
  it('labels named squares at the centroid and tram stops, by zoom', () => {
    const d = data({ squares: [{ name: 'Platz', pts: [0, 0, 50, 0, 50, 50, 0, 50] }], tramStops: [{ name: 'Haltestelle', x: -300, z: 0 }] });
    const l = run(d, view(1));
    expect(l.map((x) => x.kind).sort()).toEqual(['square', 'stop']);
    const sq = l.find((x) => x.kind === 'square')!;
    expect(sq.sx).toBeCloseTo(1225);
    expect(sq.sy).toBeCloseTo(425);
    expect(run(d, view(0.7))).toHaveLength(0);
    expect(run(d, view(0.9)).map((x) => x.kind)).toEqual(['square']);
  });
  it('primary roads come before minor ones when they collide', () => {
    const l = run(data({ roads: [road('Klein', [-100, 0, 100, 0], 'residential'), road('Gross', [-100, 2, 100, 2], 'primary')] }), view(1));
    expect(l.map((x) => x.text)).toEqual(['Gross']);
  });
});

describe('minScaleFor', () => {
  it('follows the rank table', () => {
    expect(minScaleFor('primary')).toBe(0);
    expect(minScaleFor('secondary')).toBe(0);
    expect(minScaleFor('residential')).toBe(0.6);
    expect(minScaleFor('footway')).toBe(1.5);
    expect(minScaleFor('square')).toBe(0.8);
    expect(minScaleFor('stop')).toBe(1.0);
  });
});
