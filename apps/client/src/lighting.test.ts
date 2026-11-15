import { describe, expect, it } from 'vitest';
import { bodyDirection, moodAt, nearestLamps } from './lighting';

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
