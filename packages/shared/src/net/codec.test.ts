import { describe, expect, it } from 'vitest';
import {
  decodeInputs, decodeSnapshot, encodeInputs, encodeSnapshot, NEUTRAL_INPUT,
  type Snapshot, type SnapshotBike, type SnapshotCar, type SnapshotRider, type SnapshotWalker,
} from './codec';
import { PROTOCOL_VERSION, parseStationId } from './constants';
import { ownStateOf } from '../sim/replay';


const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const makeSnapshot = (nWalkers: number, nCars: number, nLamps: number, withEvents: boolean, nRiders = 0, nBikes = 0): Snapshot => {
  const rnd = prng(7);
  const pos = (r: number) => (rnd() * 2 - 1) * r;
  const unitQuat = () => {
    const a = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const l = Math.hypot(...a);
    return { qx: a[0]! / l, qy: a[1]! / l, qz: a[2]! / l, qw: a[3]! / l };
  };
  return {
    serverTick: 123456, ackSeq: 4000000000,
    own: {
      mode: 1, engine: 2, carId: 17, seat: 0,
      char: { x: 1.5, y: 40.25, z: -300, vx: 1, vy: -2, vz: 3, grounded: true, downTicks: 42 },
      car: { x: 5, y: 41, z: -299, qx: 0, qy: 0.7071, qz: 0, qw: 0.7071, vx: 1, vy: 0, vz: 2, ax: 0.1, ay: 0.2, az: 0.3, steer: -0.25 },
      bikeId: 0, fallTicks: 0, bike: null,
    },
    walkers: Array.from({ length: nWalkers }, (_, i): SnapshotWalker => ({
      slot: i, x: pos(3000), y: 30 + rnd() * 30, z: pos(3000), yaw: rnd() * 6.28, speed: rnd() * 6, state: (i % 3) as 0 | 1 | 2,
    })),
    cars: Array.from({ length: nCars }, (_, i): SnapshotCar => ({
      id: 1000 + i, x: pos(3000), y: 30 + rnd() * 30, z: pos(3000), ...unitQuat(),
      vx: pos(30), vy: pos(2), vz: pos(30), steer: pos(1), brakeLight: i % 2 === 0, hasDriver: i % 3 === 0, horn: i % 4 === 1,
    })),
    riders: Array.from({ length: nRiders }, (_, i): SnapshotRider => ({
      slot: 50 + i, bikeId: 300 + i, x: pos(3000), y: 30 + rnd() * 30, z: pos(3000), heading: pos(3), speed: pos(12), steer: pos(0.6),
      pedalling: i % 2 === 0, airborne: i % 3 === 0,
    })),
    bikes: Array.from({ length: nBikes }, (_, i): SnapshotBike => ({ id: 10 + i, x: pos(3000), y: 30 + rnd() * 30, z: pos(3000), heading: pos(3), fall: (i % 3) - 1 })),
    lamps: Array.from({ length: nLamps }, (_, i) => ({ i: 500 + i, x: pos(3000), y: 40, z: pos(3000), ...unitQuat() })),
    events: withEvents ? [
      { t: 'knock', slot: 3 }, { t: 'impact', x: -12.34, z: 56.78, strength: 200 }, { t: 'lamp', i: 501 }, { t: 'bell', slot: 7, x: 1.25, z: -2.5 },
    ] : [],
  };
};

const quatAngle = (a: { qx: number; qy: number; qz: number; qw: number }, b: typeof a): number =>
  2 * Math.acos(Math.min(1, Math.abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw)));

describe('snapshot', () => {
  it('snapshot round-trip', () => {
    const s = makeSnapshot(40, 30, 2, true, 5, 4);
    const bytes = encodeSnapshot(s);
    expect(bytes[0]).toBe(PROTOCOL_VERSION);
    const d = decodeSnapshot(bytes)!;
    expect(d).not.toBeNull();
    expect(d.serverTick).toBe(s.serverTick);
    expect(d.ackSeq).toBe(s.ackSeq);
    expect(d.own.mode).toBe(1);
    expect(d.own.engine).toBe(2);
    expect(d.own.carId).toBe(17);
    expect(d.own.char).toEqual(s.own.char); // exactly float32-representable values
    expect(d.own.car!.steer).toBeCloseTo(-0.25, 6);
    expect(d.own.car!.qy).toBeCloseTo(0.7071, 5);
    expect(d.walkers).toHaveLength(40);
    d.walkers.forEach((w, i) => {
      const o = s.walkers[i]!;
      expect(w.slot).toBe(o.slot);
      expect(Math.abs(w.x - o.x)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(w.y - o.y)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(w.z - o.z)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(w.speed).toBeCloseTo(o.speed, 1);
      expect(w.state).toBe(o.state);
    });
    expect(d.cars).toHaveLength(30);
    d.cars.forEach((c, i) => {
      const o = s.cars[i]!;
      expect(c.id).toBe(o.id);
      expect(Math.abs(c.x - o.x)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(c.vx - o.vx)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(c.steer - o.steer)).toBeLessThan(0.005);
      expect(c.brakeLight).toBe(o.brakeLight);
      expect(c.hasDriver).toBe(o.hasDriver);
      expect(c.horn).toBe(o.horn);
      expect(quatAngle(c, o)).toBeLessThan(0.002);
    });
    expect(d.riders).toHaveLength(5);
    d.riders.forEach((r, i) => {
      const o = s.riders[i]!;
      expect([r.slot, r.bikeId, r.pedalling, r.airborne]).toEqual([o.slot, o.bikeId, o.pedalling, o.airborne]);
      expect(Math.abs(r.x - o.x)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(r.z - o.z)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(r.heading - o.heading)).toBeLessThan(1e-3);
      expect(Math.abs(r.speed - o.speed)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(r.steer - o.steer)).toBeLessThan(0.005);
    });
    expect(d.bikes).toHaveLength(4);
    d.bikes.forEach((b, i) => {
      const o = s.bikes[i]!;
      expect(b.id).toBe(o.id);
      expect(Math.abs(b.y - o.y)).toBeLessThanOrEqual(0.005 + 1e-9);
      expect(Math.abs(b.heading - o.heading)).toBeLessThan(1e-3);
    });
    expect(d.lamps).toHaveLength(2);
    expect(d.lamps[1]!.i).toBe(501);
    expect(quatAngle(d.lamps[0]!, s.lamps[0]!)).toBeLessThan(0.002);
    expect(d.events).toEqual([
      { t: 'knock', slot: 3 },
      { t: 'impact', x: -12.34, z: 56.78, strength: 200 },
      { t: 'lamp', i: 501 },
      { t: 'bell', slot: 7, x: 1.25, z: -2.5 },
    ]);
  });

  it('encodeSnapshot with 300 events round-trips (truncated to 255)', () => {
    const s = makeSnapshot(2, 1, 0, false, 1, 1);
    s.events = Array.from({ length: 300 }, (_, i) => ({ t: 'bell' as const, slot: i % 100, x: i, z: -i }));
    const d = decodeSnapshot(encodeSnapshot(s))!;
    expect(d).not.toBeNull();
    expect(d.events).toHaveLength(255);
    expect(d.events[254]).toEqual({ t: 'bell', slot: 54, x: 254, z: -254 });
    expect(d.walkers).toHaveLength(2);
    // walkers and riders (u8 counts) are cut the same way
    const many = makeSnapshot(300, 0, 0, false, 300, 0);
    const m = decodeSnapshot(encodeSnapshot(many))!;
    expect([m.walkers.length, m.riders.length]).toEqual([255, 255]);
  });

  it('own riding state round-trips', () => {
    const s = makeSnapshot(0, 0, 0, false);
    s.own = {
      mode: 3, engine: 0, carId: 0, seat: 0, char: s.own.char, car: null, bikeId: 301, fallTicks: 0,
      bike: { x: 1.5, y: 40.25, z: -300, heading: -2.5, speed: 6.5, steer: 0.125, vy: -0.5, grounded: false, crank: 12.75 },
    };
    const d = decodeSnapshot(encodeSnapshot(s))!;
    expect(d.own.mode).toBe(3);
    expect(d.own.bikeId).toBe(301);
    expect(d.own.bike).toEqual(s.own.bike); // exactly float32-representable values
    expect(d.own.car).toBeNull();
    s.own = { ...s.own, mode: 0, bike: null, bikeId: 0, fallTicks: 66 };
    const w = decodeSnapshot(encodeSnapshot(s))!;
    expect(w.own.bike).toBeNull();
    expect(w.own.fallTicks).toBe(66);
  });

  it('own state riding along round-trips: the car and the seat', () => {
    const snap = makeSnapshot(0, 0, 0, false);
    snap.own = { ...snap.own, mode: 4, engine: 0, carId: 321, seat: 3, car: null };
    const back = decodeSnapshot(encodeSnapshot(snap))!;
    expect(back.own).toMatchObject({ mode: 4, engine: 0, carId: 321, seat: 3, car: null });
    expect(ownStateOf(back.own)).toMatchObject({ mode: 'sit', carId: null, pass: { car: 321, seat: 3 } });
  });

  it('snapshot without own car round-trips', () => {
    const s = makeSnapshot(1, 0, 0, false);
    s.own.car = null;
    s.own.char.grounded = false;
    const d = decodeSnapshot(encodeSnapshot(s))!;
    expect(d.own.car).toBeNull();
    expect(d.own.char.grounded).toBe(false);
  });

  it('snapshot size stays within the bandwidth budget', () => {
    const bytes = encodeSnapshot(makeSnapshot(60, 40, 0, false));
    expect(bytes.byteLength).toBeLessThanOrEqual(60 * 13 + 40 * 26 + 120);
    // 100 players nearby, 20 of them on bikes (40 on foot, 40 driving) and 20 bikes rolling: ≤ 50 KB/s at 20 Hz
    const crowd = encodeSnapshot(makeSnapshot(40, 40, 0, true, 20, 20));
    expect(crowd.byteLength * 20).toBeLessThanOrEqual(50_000);
  });

  it('snapshot decode rejects malformed buffers', () => {
    const good = encodeSnapshot(makeSnapshot(5, 3, 1, true, 2, 2));
    expect(decodeSnapshot(good.slice(0, good.length - 1))).toBeNull();
    expect(decodeSnapshot(good.slice(0, 20))).toBeNull();
    expect(decodeSnapshot(new Uint8Array(0))).toBeNull();
    expect(decodeSnapshot(new Uint8Array([...good, 0]))).toBeNull();
    const wrongVersion = good.slice();
    wrongVersion[0] = PROTOCOL_VERSION + 1;
    expect(decodeSnapshot(wrongVersion)).toBeNull();
  });
});

describe('inputs', () => {
  const inp = (n: number) => ({ ...NEUTRAL_INPUT(1 + n), forward: 1, right: -0.5, run: true, jump: n === 1, brake: false, use: n === 2, horn: n === 0, bell: n === 1 });

  it('round-trips up to 3 inputs', () => {
    const p = { seq: 77, tick: 900, inputs: [inp(0), inp(1), inp(2)] };
    const b = encodeInputs(p);
    expect(b.byteLength).toBeLessThanOrEqual(24);
    const d = decodeInputs(b)!;
    expect(d.seq).toBe(77);
    expect(d.tick).toBe(900);
    expect(d.inputs).toHaveLength(3);
    d.inputs.forEach((x, i) => {
      expect(x.forward).toBe(1);
      expect(x.right).toBeCloseTo(-0.5, 2);
      expect(x.run).toBe(true);
      expect(x.jump).toBe(i === 1);
      expect(x.use).toBe(i === 2);
      expect(x.horn).toBe(i === 0);
      expect(x.bell).toBe(i === 1);
      expect(x.yaw).toBeCloseTo(1 + i, 3);
    });
  });

  it('decodeInputs rejects malformed', () => {
    const good = encodeInputs({ seq: 1, tick: 1, inputs: [inp(0), inp(1)] });
    expect(decodeInputs(good.slice(0, good.length - 1))).toBeNull();
    expect(decodeInputs(good.slice(0, 5))).toBeNull();
    expect(decodeInputs(new Uint8Array(0))).toBeNull();
    expect(decodeInputs(new Uint8Array(10_000))).toBeNull();
    const four = new Uint8Array(9 + 4 * 5);
    four[8] = 4;
    expect(decodeInputs(four)).toBeNull();
    const zero = new Uint8Array(9);
    expect(decodeInputs(zero)).toBeNull();
    // encoder never emits more than 3
    const many = encodeInputs({ seq: 0, tick: 0, inputs: [inp(0), inp(0), inp(0), inp(0), inp(0)] });
    expect(decodeInputs(many)!.inputs).toHaveLength(3);
  });

  it('non-finite values are clamped on encode', () => {
    const bad = { ...NEUTRAL_INPUT(NaN), forward: Infinity, right: NaN };
    const d = decodeInputs(encodeInputs({ seq: 1, tick: 1, inputs: [bad] }))!.inputs[0]!;
    expect(Number.isFinite(d.yaw)).toBe(true);
    expect(d.forward).toBe(1);
    expect(d.right).toBe(0);
    // every possible raw byte decodes into -1..1
    const raw = encodeInputs({ seq: 1, tick: 1, inputs: [NEUTRAL_INPUT(0)] });
    raw[9] = 0x80;
    expect(decodeInputs(raw)!.inputs[0]!.forward).toBe(-1);
  });
});

describe('stations', () => {
  it('parseStationId accepts only known ids', () => {
    expect(parseStationId('einslive')).toBe('einslive');
    expect(parseStationId('nope')).toBeNull();
    expect(parseStationId(5)).toBeNull();
    expect(parseStationId(null)).toBeNull();
  });
});
