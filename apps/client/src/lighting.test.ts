import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { bodyDirection, moodAt, nearestLamps, weatherFog, weatherMood } from './lighting';

describe('nearestLamps', () => {
  it('returns the n nearest lamp indices, nearest first', () => {
    const lamps: [number, number][] = [[100, 0], [3, 4], [0, 1], [-50, -50], [10, 0]];
    expect(nearestLamps(lamps, 0, 0, 3)).toEqual([2, 1, 4]);
  });
  it('leaves out knocked-down lamps', () => {
    const lamps: [number, number][] = [[100, 0], [3, 4], [0, 1], [-50, -50], [10, 0]];
    expect(nearestLamps(lamps, 0, 0, 3, new Set([1]))).toEqual([2, 4, 3]);
  });
  it('returns fewer when there are fewer lamps', () => {
    expect(nearestLamps([[1, 1]], 0, 0, 8)).toEqual([0]);
  });
});

describe('moodAt', () => {
  const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  it('has no direct sun below the horizon and full sun at noon', () => {
    expect(moodAt(-10).sunI).toBe(0);
    expect(moodAt(60).sunI).toBeGreaterThan(2.5);
  });
  it('darkens the sky monotonically as the sun sinks', () => {
    const alts = [25, 10, 2, -2, -6, -18];
    const z = alts.map((a) => lum(moodAt(a).zenith));
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeLessThan(z[i - 1]!);
  });
  it('keeps some blue ambient light at deep night (street not pitch black)', () => {
    const m = moodAt(-30);
    expect(m.hemiI * lum(m.hemiSky)).toBeGreaterThan(0.03);
    expect(m.hemiSky.b).toBeGreaterThan(m.hemiSky.r);
  });
  it('is continuous at key altitudes', () => {
    expect(lum(moodAt(2.0001).horizon)).toBeCloseTo(lum(moodAt(1.9999).horizon), 3);
  });
});

describe('bodyDirection', () => {
  it('uses the heading convention (sin az, cos az) in x/z and altitude as elevation', () => {
    const d = bodyDirection(0, Math.PI / 2);
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(0);
    expect(bodyDirection(Math.PI / 2, 0).y).toBeCloseTo(1);
  });
});

describe('weatherMood', () => {
  const sat = (c: Color) => c.getHSL({ h: 0, s: 0, l: 0 }).s;
  const maxDiff = (a: Color, b: Color) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
  it('leaves the mood unchanged without clouds', () => {
    const m = moodAt(30);
    expect(weatherMood(m, 0, 0.3)).toEqual(m);
  });
  it('dims the sun, greys the horizon and raises the ambient light at overcast noon', () => {
    const clear = moodAt(60);
    const w = weatherMood(moodAt(60), 1, 0);
    expect(w.sunI).toBeLessThanOrEqual(clear.sunI * 0.25);
    expect(sat(w.horizon)).toBeLessThan(sat(clear.horizon));
    expect(w.hemiI).toBeGreaterThanOrEqual(clear.hemiI);
  });
  it('does not touch the input mood', () => {
    const m = moodAt(60);
    const before = m.horizon.clone();
    weatherMood(m, 1, 0);
    expect(m.horizon.equals(before)).toBe(true);
  });
  it('keeps the deep night sky as it is', () => {
    const clear = moodAt(-18);
    const w = weatherMood(moodAt(-18), 1, 1);
    expect(maxDiff(w.zenith, clear.zenith)).toBeLessThan(0.02);
    expect(maxDiff(w.horizon, clear.horizon)).toBeLessThan(0.02);
  });
  it('fades the sky effect out with night', () => {
    const clear = moodAt(10);
    const d = (night: number) => maxDiff(weatherMood(moodAt(10), 1, night).horizon, clear.horizon);
    expect(d(0.5)).toBeLessThan(d(0));
    expect(d(1)).toBeLessThan(d(0.5));
  });
});

describe('weatherFog', () => {
  it('keeps the fog unchanged at clear visibility', () => {
    expect(weatherFog(150, 650, 50000)).toEqual({ near: 150, far: 650 });
  });
  it('pulls the fog in to the visibility', () => {
    const f = weatherFog(150, 650, 200);
    expect(f.far).toBeLessThanOrEqual(200);
    expect(f.near).toBeLessThan(f.far);
  });
  it('never brings far below 60 m', () => {
    for (const v of [0, 10, 59, 60, 61]) {
      const f = weatherFog(150, 650, v);
      expect(f.far).toBeGreaterThanOrEqual(60);
      expect(f.near).toBeLessThan(f.far);
    }
  });
});
