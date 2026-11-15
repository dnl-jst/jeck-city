import { describe, expect, it } from 'vitest';
import { createStreetMaterials, STREET_RENDER_ORDER } from './street';

describe('street materials', () => {
  const mats = createStreetMaterials();
  it('has materials for the markings and parking meshes of a chunk', () => {
    expect(mats.markings).toBeDefined();
    expect(mats.parking).toBeDefined();
  });
  it('layers markings above road and parking strips but below the track bed and rails', () => {
    const o = STREET_RENDER_ORDER;
    expect(o.road!).toBeLessThan(o.parking!);
    expect(o.parking!).toBeLessThan(o.markings!);
    expect(o.markings!).toBeLessThan(o.trackbed!);
    const f = (n: string) => (mats[n]!.polygonOffset ? mats[n]!.polygonOffsetFactor : 0);
    expect(f('road')).toBeGreaterThan(f('parking'));
    expect(f('parking')).toBeGreaterThan(f('markings'));
    expect(f('markings')).toBeGreaterThan(f('trackbed'));
  });
});
