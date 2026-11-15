import { describe, expect, it } from 'vitest';
import { SnapshotBuffer, poseOps, type PoseLike } from './interp';

type P = PoseLike & { tag?: string };
const pose = (x: number, vx = 0, extra: Partial<P> = {}): P => ({ x, y: 0, z: 0, vx, vy: 0, vz: 0, ...extra });
const buf = () => new SnapshotBuffer<P>(poseOps<P>());

describe('SnapshotBuffer', () => {
  it('interp between two snapshots', () => {
    const b = buf();
    b.push(0, new Map([['a', pose(0)]]));
    b.push(3, new Map([['a', pose(6)]]));
    expect(b.sample(1.5).get('a')!.x).toBeCloseTo(3);
    expect(b.sample(0.75).get('a')!.x).toBeCloseTo(1.5);
  });

  it('extrapolates up to 150 ms then freezes', () => {
    const b = buf();
    b.push(0, new Map([['a', pose(0, 10)]]));
    b.push(3, new Map([['a', pose(0.5, 10)]]));
    expect(b.sample(3 + 3).get('a')!.x).toBeCloseTo(0.5 + 10 * 0.05);
    expect(b.sample(3 + 9).get('a')!.x).toBeCloseTo(0.5 + 10 * 0.15);
    expect(b.sample(3 + 60).get('a')!.x).toBeCloseTo(0.5 + 10 * 0.15);
  });

  it('entity missing in newer snapshot disappears after it', () => {
    const b = buf();
    b.push(0, new Map([['a', pose(0)], ['gone', pose(1)]]));
    b.push(3, new Map([['a', pose(3)]]));
    b.push(6, new Map([['a', pose(6)]]));
    expect(b.sample(2).has('gone')).toBe(true);
    expect(b.sample(3).has('gone')).toBe(false);
    expect(b.sample(5).has('gone')).toBe(false);
    expect(b.sample(8).has('gone')).toBe(false);
  });

  it('a new entity appears at its first snapshot', () => {
    const b = buf();
    b.push(0, new Map([['a', pose(0)]]));
    b.push(3, new Map([['a', pose(3)], ['new', pose(9)]]));
    expect(b.sample(2).has('new')).toBe(false);
    expect(b.sample(3).get('new')!.x).toBe(9);
  });

  it('nlerp takes the short way and stays normalised', () => {
    const b = buf();
    const q = (qx: number, qy: number, qz: number, qw: number) => pose(0, 0, { qx, qy, qz, qw });
    b.push(0, new Map([['c', q(0, 0, 0, 1)]]));
    b.push(3, new Map([['c', q(0, 0, 0, -1)]])); // same rotation, opposite sign
    const m = b.sample(1.5).get('c')!;
    expect(Math.hypot(m.qx!, m.qy!, m.qz!, m.qw!)).toBeCloseTo(1);
    expect(Math.abs(m.qw!)).toBeCloseTo(1);
    b.push(6, new Map([['c', q(0, Math.SQRT1_2, 0, Math.SQRT1_2)]]));
    const h = b.sample(4.5).get('c')!;
    expect(Math.hypot(h.qx!, h.qy!, h.qz!, h.qw!)).toBeCloseTo(1);
  });

  it('ignores repeated or older ticks and clamps before the oldest', () => {
    const b = buf();
    b.push(5, new Map([['a', pose(5)]]));
    b.push(5, new Map([['a', pose(99)]]));
    b.push(2, new Map([['a', pose(98)]]));
    expect(b.sample(0).get('a')!.x).toBe(5);
    expect(b.sample(5).get('a')!.x).toBe(5);
  });
});
