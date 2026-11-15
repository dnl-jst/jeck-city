import { describe, expect, it } from 'vitest';
import { dqAngle, dqPos, dqVel, packQuat, qAngle, qPos, qVel, unpackQuat } from './quant';

/** mulberry32: small seeded PRNG for deterministic test data. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('quant', () => {
  it('quant round-trips', () => {
    for (const m of [-3000, -1234.567, 0, 0.004, 3000]) expect(Math.abs(dqPos(qPos(m)) - m)).toBeLessThanOrEqual(0.005 + 1e-9);
    for (const a of [0, 0.5, 3, 6.2, -1, 100]) {
      const back = dqAngle(qAngle(a));
      const d = Math.abs(((back - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(Math.min(d, 2 * Math.PI - d)).toBeLessThanOrEqual((2 * Math.PI) / 65536);
    }
    expect(qAngle(NaN)).toBe(0);
    expect(qAngle(2 * Math.PI)).toBe(0);
    expect(qVel(1000)).toBe(32700);
    expect(qVel(-1000)).toBe(-32700);
    expect(dqVel(qVel(12.34))).toBeCloseTo(12.34, 2);

    const rnd = prng(42);
    let worst = 0;
    for (let n = 0; n < 1000; n++) {
      const g = () => {
        const u = Math.max(rnd(), 1e-12);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
      };
      const raw = [g(), g(), g(), g()];
      const len = Math.hypot(...raw);
      const q = { x: raw[0]! / len, y: raw[1]! / len, z: raw[2]! / len, w: raw[3]! / len };
      const r = unpackQuat(packQuat(q));
      const dot = Math.min(1, Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w));
      worst = Math.max(worst, 2 * Math.acos(dot));
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('packQuat survives degenerate input', () => {
    expect(unpackQuat(packQuat({ x: NaN, y: 0, z: 0, w: 0 }))).toMatchObject({ w: 1 });
  });
});
