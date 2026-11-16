import { describe, expect, it } from 'vitest';
import { CATCHUP_BLEND_S, CatchUp, SnapshotBuffer, poseOps, type PoseLike } from './interp';

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

describe('CatchUp', () => {
  /**
   * A car at 10 m/s along x, snapshots every 3 ticks (each arriving 75 ms late), drawn at 60 fps 100 ms behind. From
   * t = 1 s no snapshot arrives for 300 ms (the sample extrapolates 150 ms, then freezes), then all of them at once.
   */
  function run(smooth: boolean) {
    const V = 10;
    const b = buf();
    const c = new CatchUp<P>();
    const steps: { t: number; step: number; dt: number; drawn: number; raw: number }[] = [];
    let prev: number | null = null, prevT = 0, sent = 0;
    for (let t = 0; t <= 2500; t += 1000 / 60) {
      const stalled = t >= 1000 && t < 1300;
      // every snapshot whose arrival time (tick time + 75 ms) has passed
      while (!stalled && sent * 50 + 75 <= t) {
        b.push(sent * 3, new Map([['car', pose(V * sent * 0.05, V)]]));
        sent++;
      }
      const raw = b.sample((t * 60) / 1000 - 6).get('car');
      if (!raw) continue;
      const drawn = smooth ? c.apply(new Map([['car', raw]]), t).get('car')! : raw;
      if (prev !== null) steps.push({ t, step: drawn.x - prev, dt: (t - prevT) / 1000, drawn: drawn.x, raw: raw.x });
      prev = drawn.x;
      prevT = t;
    }
    return { steps, V };
  }

  it('without it, the sample snaps forward after a 300 ms freeze', () => {
    const { steps, V } = run(false);
    expect(Math.max(...steps.map((s) => s.step - V * s.dt))).toBeGreaterThan(1);
  });

  it('after a 300 ms freeze the drawn pose moves on continuously and meets the sample within ~150 ms', () => {
    const { steps, V } = run(true);
    for (const s of steps) expect(s.step).toBeLessThanOrEqual(V * s.dt + 0.3);
    // the snapshots arrive again at t = 1300: drawn and sampled agree once the blend is over
    const after = steps.filter((s) => s.t >= 1300 + CATCHUP_BLEND_S * 1000 + 20);
    expect(after.length).toBeGreaterThan(30);
    for (const s of after) expect(Math.abs(s.drawn - s.raw)).toBeLessThan(0.01);
    // nothing moved backwards
    expect(Math.min(...steps.map((s) => s.step))).toBeGreaterThanOrEqual(-1e-9);
  });

  it('a car keeps its rotation continuous through a catch-up and then turns to the sample', () => {
    const c = new CatchUp<P>();
    const q = (h: number) => ({ qx: 0, qy: Math.sin(h / 2), qz: 0, qw: Math.cos(h / 2) });
    c.apply(new Map([['car', pose(0, 0, q(0))]]), 0);
    c.apply(new Map([['car', pose(0, 0, q(0))]]), 16);
    // a catch-up: 2 m and 0.5 rad at once
    const d = c.apply(new Map([['car', pose(2, 0, q(0.5))]]), 32).get('car')!;
    expect(d.x).toBeCloseTo(0, 5);
    expect(2 * Math.asin(d.qy!)).toBeCloseTo(0, 5);
    const mid = c.apply(new Map([['car', pose(2, 0, q(0.5))]]), 32 + 75).get('car')!;
    expect(mid.x).toBeCloseTo(1, 1);
    expect(2 * Math.asin(mid.qy!)).toBeGreaterThan(0.2);
    expect(2 * Math.asin(mid.qy!)).toBeLessThan(0.3);
    const end = c.apply(new Map([['car', pose(2, 0, q(0.5))]]), 32 + 160).get('car')!;
    expect(end.x).toBe(2);
    expect(2 * Math.asin(end.qy!)).toBeCloseTo(0.5, 5);
  });

  it('a teleport (beyond 20 m) is drawn at once', () => {
    const c = new CatchUp<P>();
    c.apply(new Map([['w', pose(0)]]), 0);
    expect(c.apply(new Map([['w', pose(50)]]), 16).get('w')!.x).toBe(50);
  });
});
