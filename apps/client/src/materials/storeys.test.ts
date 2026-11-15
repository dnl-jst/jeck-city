import { describe, expect, it } from 'vitest';
import { SIGN_Y } from '@nn/shared';
import { SIGN_H } from '../props';
import { SHOP, storeyLayout, STOREY, windowRows } from './storeys';

describe('storeyLayout', () => {
  it('17 m eave: ground floor 4.5 m, three storeys of ~3.7 m, the rest as attic/cornice', () => {
    const l = storeyLayout(17, 0.5, false);
    expect(l.ground).toBeCloseTo(4.5);
    expect(l.storey).toBeCloseTo(3.7);
    expect(l.count).toBe(3);
    expect(17 - (l.ground + l.count * l.storey)).toBeCloseTo(1.4); // attic under the eave
    expect(l.corniceBottom).toBeCloseTo(17 - STOREY.cornice);
  });

  it('storey height per building seed between 3.5 and 3.9 m; shopfront ground floor 4.6 m', () => {
    expect(storeyLayout(20, 0, false).storey).toBeCloseTo(3.5);
    expect(storeyLayout(20, 0.999, false).storey).toBeCloseTo(3.9, 2);
    expect(storeyLayout(20, 0.5, true).ground).toBeCloseTo(4.6);
  });

  it('count = floor((eave − ground) / storey)', () => {
    for (const [eave, rnd] of [[8, 0.5], [8.2, 0.5], [12, 0.2], [21, 0.5], [24.3, 0.9]] as const) {
      const l = storeyLayout(eave, rnd, false);
      expect(l.count).toBe(Math.floor((eave - l.ground) / l.storey));
    }
  });

  it('windows 1.9 m high on a 0.9 m parapet', () => {
    const rows = windowRows(storeyLayout(17, 0.5, false));
    const upper = rows.slice(1);
    expect(upper).toHaveLength(3);
    for (const [i, r] of upper.entries()) {
      expect(r.sill - (4.5 + i * 3.7)).toBeCloseTo(0.9);
      expect(r.height).toBeCloseTo(1.9);
    }
  });

  it('no window row (with its lintel) reaches into the cornice or over the eave', () => {
    for (let eave = 2.5; eave <= 32; eave += 0.13) {
      for (const rnd of [0, 0.25, 0.5, 0.75, 0.999]) {
        for (const shop of [false, true]) {
          const l = storeyLayout(eave, rnd, shop);
          expect(l.corniceBottom).toBeLessThanOrEqual(eave);
          for (const r of windowRows(l)) {
            expect(r.height).toBeGreaterThan(0);
            expect(r.sill + r.height + STOREY.lintel).toBeLessThanOrEqual(l.corniceBottom + 1e-6);
          }
          if (l.count > 0) expect(l.ground + l.count * l.storey).toBeLessThanOrEqual(eave + 1e-6);
        }
      }
    }
  });

  it('shop sign band sits inside the shop ground floor above the shop windows', () => {
    expect(SHOP.glassTop).toBeLessThan(SHOP.signBottom);
    expect(SHOP.signTop).toBeLessThan(SHOP.ground);
  });

  it('sign boards (props.ts) hang on the sign band of the shader', () => {
    expect(SIGN_Y - SIGN_H / 2).toBeGreaterThanOrEqual(SHOP.signBottom);
    expect(SIGN_Y + SIGN_H / 2).toBeLessThanOrEqual(SHOP.signTop);
    // the pipeline places sign.y = building base + SIGN_Y: the middle of the band
    expect(SIGN_Y).toBeCloseTo((SHOP.signBottom + SHOP.signTop) / 2, 6);
  });
});
