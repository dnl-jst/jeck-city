import type { BikeState } from '../physics/bike';
import type { CharacterState } from '../physics/character';
import type { VehicleState } from '../physics/vehicle';
import { MAX_INPUTS_PER_PACKET, PROTOCOL_VERSION } from './constants';
import { dqAngle, dqPos, dqVel, packQuat, qAngle, qPos, qVel, unpackQuat } from './quant';

// ---------------------------------------------------------------- inputs

/**
 * One tick of a player's input. horn: H held (in a car); bell: H pressed (on a bike; a one-tick pulse like use/jump).
 * horn and bell are optional (absent = false).
 */
export type PlayerInput = {
  forward: number; right: number; run: boolean; jump: boolean; brake: boolean; use: boolean; yaw: number;
  horn?: boolean; bell?: boolean;
};
export const NEUTRAL_INPUT = (yaw: number): PlayerInput => ({ forward: 0, right: 0, run: false, jump: false, brake: false, use: false, yaw });

/** `seq` is the sequence number of inputs[0]; the following ones are seq+1, seq+2. */
export type InputPacket = { seq: number; tick: number; inputs: PlayerInput[] };

const INPUT_HEADER = 9; // seq u32, tick u32, count u8
const INPUT_SIZE = 5; // forward i8, right i8, flags u8, yaw u16

const axisToI8 = (v: number): number => (!Number.isNaN(v) ? Math.round(Math.max(-1, Math.min(1, v)) * 127) : 0);
const i8ToAxis = (v: number): number => Math.max(-1, Math.min(1, v / 127));

export function encodeInputs(p: InputPacket): Uint8Array {
  const inputs = p.inputs.slice(0, MAX_INPUTS_PER_PACKET);
  const out = new Uint8Array(INPUT_HEADER + inputs.length * INPUT_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, p.seq >>> 0);
  dv.setUint32(4, p.tick >>> 0);
  dv.setUint8(8, inputs.length);
  inputs.forEach((i, n) => {
    const o = INPUT_HEADER + n * INPUT_SIZE;
    dv.setInt8(o, axisToI8(i.forward));
    dv.setInt8(o + 1, axisToI8(i.right));
    dv.setUint8(o + 2, (i.run ? 1 : 0) | (i.jump ? 2 : 0) | (i.brake ? 4 : 0) | (i.use ? 8 : 0) | (i.horn ? 16 : 0) | (i.bell ? 32 : 0));
    dv.setUint16(o + 3, qAngle(i.yaw));
  });
  return out;
}

/** Untrusted input: returns null for wrong length or a count outside 1..MAX_INPUTS_PER_PACKET. */
export function decodeInputs(b: Uint8Array): InputPacket | null {
  if (b.byteLength < INPUT_HEADER) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const count = dv.getUint8(8);
  if (count < 1 || count > MAX_INPUTS_PER_PACKET) return null;
  if (b.byteLength !== INPUT_HEADER + count * INPUT_SIZE) return null;
  const inputs: PlayerInput[] = [];
  for (let n = 0; n < count; n++) {
    const o = INPUT_HEADER + n * INPUT_SIZE;
    const f = dv.getUint8(o + 2);
    inputs.push({
      forward: i8ToAxis(dv.getInt8(o)),
      right: i8ToAxis(dv.getInt8(o + 1)),
      run: (f & 1) !== 0,
      jump: (f & 2) !== 0,
      brake: (f & 4) !== 0,
      use: (f & 8) !== 0,
      horn: (f & 16) !== 0,
      bell: (f & 32) !== 0,
      yaw: dqAngle(dv.getUint16(o + 3)),
    });
  }
  return { seq: dv.getUint32(0), tick: dv.getUint32(4), inputs };
}

// -------------------------------------------------------------- snapshot

export type OwnMode = 0 | 1 | 2 | 3; // walk / drive / down / ride
export type EngineState = 0 | 1 | 2; // off / starting / running
/** standing / walking / down (knocked over by a car) / fallen (off a bike: lying and getting up). */
export type WalkerState = 0 | 1 | 2 | 3;

/** Walker position range on the wire: x/z int24 cm (±83 km), y int16 cm (±327 m); values are clamped. */
export type SnapshotWalker = { slot: number; x: number; y: number; z: number; yaw: number; speed: number; state: WalkerState };
/** horn: the driver holds the horn. */
export type SnapshotCar = {
  id: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number; steer: number; brakeLight: boolean; hasDriver: boolean; horn: boolean;
};
/**
 * Another player on a bike: slot, bike id, ground under the wheels, heading, speed along it (m/s, signed), front wheel
 * angle (rad), pedalling (crank turns), airborne (hop).
 */
export type SnapshotRider = {
  slot: number; bikeId: number; x: number; y: number; z: number; heading: number; speed: number; steer: number;
  pedalling: boolean; airborne: boolean;
};
/** An unridden bike that moves (shoved, rolling out): ground under it and heading. */
export type SnapshotBike = { id: number; x: number; y: number; z: number; heading: number };
export type SnapshotLamp = { i: number; x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };
export type SnapshotEvent =
  | { t: 'knock'; slot: number }
  | { t: 'impact'; x: number; z: number; strength: number }
  | { t: 'lamp'; i: number }
  | { t: 'bell'; slot: number; x: number; z: number };

/**
 * The own player in full (for reconciliation). carId: the car while driving (0 otherwise; car null), bikeId: the bike
 * while riding (0 otherwise; bike null), fallTicks: ticks left lying after falling off a bike.
 */
export type SnapshotOwn = {
  mode: OwnMode; engine: EngineState; carId: number; char: CharacterState; car: VehicleState | null;
  bikeId: number; fallTicks: number; bike: BikeState | null;
};
export type Snapshot = {
  serverTick: number;
  ackSeq: number;
  own: SnapshotOwn;
  walkers: SnapshotWalker[];
  cars: SnapshotCar[];
  riders: SnapshotRider[];
  bikes: SnapshotBike[];
  lamps: SnapshotLamp[];
  events: SnapshotEvent[];
};

const CHAR_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const;
const CAR_FIELDS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'steer'] as const;
const BIKE_FIELDS = ['x', 'y', 'z', 'heading', 'speed', 'steer', 'vy', 'crank'] as const;

const SNAP_HEADER = 18; // version u8, tick u32, ack u32, walkers u8, cars u16, riders u8, bikes u16, lamps u16, events u8
const OWN_BASE = 10 + 4 * CHAR_FIELDS.length; // mode, engine, carId u16, flags, downTicks u16, bikeId u16, fallTicks u8, char float32s
// (the own bike's state follows as float64s: the ridden bike's controller reacts to millimetres – a float32 position
// makes the prediction miss a whole step of travel now and then)
const WALKER_SIZE = 13;
const CAR_SIZE = 24;
const RIDER_SIZE = 17;
const BIKE_SIZE = 12;
const LAMP_SIZE = 17;
const EVENT_SIZE = { knock: 2, impact: 8, lamp: 3, bell: 8 } as const;

const clampInt = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);
const I24 = 8388607;
const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

class Writer {
  readonly buf: Uint8Array;
  readonly dv: DataView;
  o = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  u8(v: number): void { this.dv.setUint8(this.o++, clampInt(v, 0, 255)); }
  i8(v: number): void { this.dv.setInt8(this.o++, clampInt(v, -127, 127)); }
  u16(v: number): void { this.dv.setUint16(this.o, clampInt(v, 0, 65535)); this.o += 2; }
  i16(v: number): void { this.dv.setInt16(this.o, clampInt(v, -32768, 32767)); this.o += 2; }
  u32(v: number): void { this.dv.setUint32(this.o, v >>> 0); this.o += 4; }
  f32(v: number): void { this.dv.setFloat32(this.o, finite(v)); this.o += 4; }
  f64(v: number): void { this.dv.setFloat64(this.o, finite(v)); this.o += 8; }
  i24(v: number): void {
    const n = clampInt(v, -I24, I24) & 0xffffff;
    this.dv.setUint8(this.o, n >> 16);
    this.dv.setUint16(this.o + 1, n & 0xffff);
    this.o += 3;
  }
}

class Reader {
  readonly dv: DataView;
  o = 0;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get left(): number { return this.b.byteLength - this.o; }
  u8(): number { return this.dv.getUint8(this.o++); }
  i8(): number { return this.dv.getInt8(this.o++); }
  u16(): number { const v = this.dv.getUint16(this.o); this.o += 2; return v; }
  i16(): number { const v = this.dv.getInt16(this.o); this.o += 2; return v; }
  u32(): number { const v = this.dv.getUint32(this.o); this.o += 4; return v; }
  f32(): number { const v = this.dv.getFloat32(this.o); this.o += 4; return v; }
  f64(): number { const v = this.dv.getFloat64(this.o); this.o += 8; return v; }
  i24(): number {
    const n = (this.dv.getUint8(this.o) << 16) | this.dv.getUint16(this.o + 1);
    this.o += 3;
    return n & 0x800000 ? n - 0x1000000 : n;
  }
}

const writePose = (w: Writer, x: number, y: number, z: number, q: { x: number; y: number; z: number; w: number }): number => {
  w.i24(qPos(x));
  w.i16(qPos(y));
  w.i24(qPos(z));
  const p = packQuat(q);
  w.i16(p.a);
  w.i16(p.b);
  w.i16(p.c);
  return p.idx;
};


/**
 * Entity and event counts are u8 (walkers, riders, events) or u16 (cars, bikes, lamps) on the wire: longer lists are
 * cut to that bound, so the counts always match what follows.
 */
export function encodeSnapshot(full: Snapshot): Uint8Array {
  const s: Snapshot = {
    ...full,
    walkers: full.walkers.slice(0, 255), riders: full.riders.slice(0, 255), events: full.events.slice(0, 255),
    cars: full.cars.slice(0, 65535), bikes: full.bikes.slice(0, 65535), lamps: full.lamps.slice(0, 65535),
  };
  const own = s.own;
  const size =
    SNAP_HEADER + OWN_BASE + (own.car ? 4 * CAR_FIELDS.length : 0) + (own.bike ? 8 * BIKE_FIELDS.length : 0) +
    s.walkers.length * WALKER_SIZE + s.cars.length * CAR_SIZE + s.riders.length * RIDER_SIZE + s.bikes.length * BIKE_SIZE +
    s.lamps.length * LAMP_SIZE + s.events.reduce((n, e) => n + EVENT_SIZE[e.t], 0);
  const w = new Writer(size);
  w.u8(PROTOCOL_VERSION);
  w.u32(s.serverTick);
  w.u32(s.ackSeq);
  w.u8(s.walkers.length);
  w.u16(s.cars.length);
  w.u8(s.riders.length);
  w.u16(s.bikes.length);
  w.u16(s.lamps.length);
  w.u8(s.events.length);

  w.u8(own.mode);
  w.u8(own.engine);
  w.u16(own.carId);
  w.u8((own.char.grounded ? 1 : 0) | (own.car ? 2 : 0) | (own.bike ? 4 : 0) | (own.bike?.grounded ? 8 : 0));
  w.u16(own.char.downTicks);
  w.u16(own.bikeId);
  w.u8(own.fallTicks);
  for (const k of CHAR_FIELDS) w.f32(own.char[k]);
  if (own.car) for (const k of CAR_FIELDS) w.f32(own.car[k]);
  if (own.bike) for (const k of BIKE_FIELDS) w.f64(own.bike[k]);

  for (const k of s.walkers) {
    w.u8(k.slot);
    w.i24(qPos(k.x));
    w.i16(qPos(k.y));
    w.i24(qPos(k.z));
    w.u16(qAngle(k.yaw));
    w.u8(clampInt(k.speed * 10, 0, 255));
    w.u8(k.state);
  }
  for (const c of s.cars) {
    w.u16(c.id);
    // pose layout: pos 8 bytes + quat 6 bytes; the quaternion index rides in the flags byte
    const idx = writePose(w, c.x, c.y, c.z, { x: c.qx, y: c.qy, z: c.qz, w: c.qw });
    w.i16(qVel(c.vx));
    w.i16(qVel(c.vy));
    w.i16(qVel(c.vz));
    w.i8(finite(c.steer) * 127);
    w.u8((c.brakeLight ? 1 : 0) | (c.hasDriver ? 2 : 0) | (idx << 2) | (c.horn ? 16 : 0));
  }
  for (const r of s.riders) {
    w.u8(r.slot);
    w.u16(r.bikeId);
    w.i24(qPos(r.x));
    w.i16(qPos(r.y));
    w.i24(qPos(r.z));
    w.u16(qAngle(r.heading));
    w.i16(qVel(r.speed));
    w.i8(finite(r.steer) * 127);
    w.u8((r.pedalling ? 1 : 0) | (r.airborne ? 2 : 0));
  }
  for (const b of s.bikes) {
    w.u16(b.id);
    w.i24(qPos(b.x));
    w.i16(qPos(b.y));
    w.i24(qPos(b.z));
    w.u16(qAngle(b.heading));
  }
  for (const l of s.lamps) {
    w.u16(l.i);
    const idx = writePose(w, l.x, l.y, l.z, { x: l.qx, y: l.qy, z: l.qz, w: l.qw });
    w.u8(idx);
  }
  for (const e of s.events) {
    if (e.t === 'knock') { w.u8(0); w.u8(e.slot); }
    else if (e.t === 'impact') { w.u8(1); w.i24(qPos(e.x)); w.i24(qPos(e.z)); w.u8(e.strength); }
    else if (e.t === 'lamp') { w.u8(2); w.u16(e.i); }
    else { w.u8(3); w.u8(e.slot); w.i24(qPos(e.x)); w.i24(qPos(e.z)); }
  }
  return w.buf;
}

const readPose = (r: Reader): { x: number; y: number; z: number; a: number; b: number; c: number } => ({
  x: dqPos(r.i24()), y: dqPos(r.i16()), z: dqPos(r.i24()), a: r.i16(), b: r.i16(), c: r.i16(),
});

/** Heading on the wire is a turn fraction in [0, 2π); back to (−π, π] like the sim's. */
const dqHeading = (v: number): number => {
  const a = dqAngle(v);
  return a > Math.PI ? a - 2 * Math.PI : a;
};

/** Returns null for a wrong protocol version, truncated data or trailing bytes. */
export function decodeSnapshot(b: Uint8Array): Snapshot | null {
  if (b.byteLength < SNAP_HEADER + OWN_BASE) return null;
  const r = new Reader(b);
  if (r.u8() !== PROTOCOL_VERSION) return null;
  const serverTick = r.u32();
  const ackSeq = r.u32();
  const nWalkers = r.u8();
  const nCars = r.u16();
  const nRiders = r.u8();
  const nBikes = r.u16();
  const nLamps = r.u16();
  const nEvents = r.u8();

  const mode = r.u8();
  const engine = r.u8();
  const carId = r.u16();
  const flags = r.u8();
  const downTicks = r.u16();
  const bikeId = r.u16();
  const fallTicks = r.u8();
  if (mode > 3 || engine > 2) return null;
  const hasCar = (flags & 2) !== 0, hasBike = (flags & 4) !== 0;
  const need = (hasCar ? 4 * CAR_FIELDS.length : 0) + (hasBike ? 8 * BIKE_FIELDS.length : 0) + 4 * CHAR_FIELDS.length +
    nWalkers * WALKER_SIZE + nCars * CAR_SIZE + nRiders * RIDER_SIZE + nBikes * BIKE_SIZE + nLamps * LAMP_SIZE + nEvents * 2;
  if (r.left < need) return null;

  const cv = {} as Record<(typeof CHAR_FIELDS)[number], number>;
  for (const k of CHAR_FIELDS) cv[k] = r.f32();
  const char: CharacterState = { ...cv, grounded: (flags & 1) !== 0, downTicks };
  let car: VehicleState | null = null;
  if (hasCar) {
    const v = {} as Record<(typeof CAR_FIELDS)[number], number>;
    for (const k of CAR_FIELDS) v[k] = r.f32();
    car = v;
  }
  let bike: BikeState | null = null;
  if (hasBike) {
    const v = {} as Record<(typeof BIKE_FIELDS)[number], number>;
    for (const k of BIKE_FIELDS) v[k] = r.f64();
    bike = { ...v, grounded: (flags & 8) !== 0 };
  }

  const walkers: SnapshotWalker[] = [];
  for (let n = 0; n < nWalkers; n++) {
    const slot = r.u8();
    const x = dqPos(r.i24());
    const y = dqPos(r.i16());
    const z = dqPos(r.i24());
    const yaw = dqAngle(r.u16());
    const speed = r.u8() / 10;
    const state = r.u8();
    if (state > 3) return null;
    walkers.push({ slot, x, y, z, yaw, speed, state: state as WalkerState });
  }
  const cars: SnapshotCar[] = [];
  for (let n = 0; n < nCars; n++) {
    const id = r.u16();
    const p = readPose(r);
    const vx = dqVel(r.i16());
    const vy = dqVel(r.i16());
    const vz = dqVel(r.i16());
    const steer = r.i8() / 127;
    const f = r.u8();
    const q = unpackQuat({ a: p.a, b: p.b, c: p.c, idx: ((f >> 2) & 3) as 0 | 1 | 2 | 3 });
    cars.push({
      id, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx, vy, vz, steer,
      brakeLight: (f & 1) !== 0, hasDriver: (f & 2) !== 0, horn: (f & 16) !== 0,
    });
  }
  const riders: SnapshotRider[] = [];
  for (let n = 0; n < nRiders; n++) {
    const slot = r.u8();
    const bikeId = r.u16();
    const x = dqPos(r.i24());
    const y = dqPos(r.i16());
    const z = dqPos(r.i24());
    const heading = dqHeading(r.u16());
    const speed = dqVel(r.i16());
    const steer = r.i8() / 127;
    const f = r.u8();
    riders.push({ slot, bikeId, x, y, z, heading, speed, steer, pedalling: (f & 1) !== 0, airborne: (f & 2) !== 0 });
  }
  const bikes: SnapshotBike[] = [];
  for (let n = 0; n < nBikes; n++) {
    const id = r.u16();
    bikes.push({ id, x: dqPos(r.i24()), y: dqPos(r.i16()), z: dqPos(r.i24()), heading: dqHeading(r.u16()) });
  }
  const lamps: SnapshotLamp[] = [];
  for (let n = 0; n < nLamps; n++) {
    const i = r.u16();
    const p = readPose(r);
    const q = unpackQuat({ a: p.a, b: p.b, c: p.c, idx: (r.u8() & 3) as 0 | 1 | 2 | 3 });
    lamps.push({ i, x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w });
  }
  const events: SnapshotEvent[] = [];
  for (let n = 0; n < nEvents; n++) {
    if (r.left < 2) return null;
    const t = r.u8();
    if (t === 0) events.push({ t: 'knock', slot: r.u8() });
    else if (t === 1) {
      if (r.left < 7) return null;
      events.push({ t: 'impact', x: dqPos(r.i24()), z: dqPos(r.i24()), strength: r.u8() });
    } else if (t === 2) {
      if (r.left < 2) return null;
      events.push({ t: 'lamp', i: r.u16() });
    } else if (t === 3) {
      if (r.left < 7) return null;
      events.push({ t: 'bell', slot: r.u8(), x: dqPos(r.i24()), z: dqPos(r.i24()) });
    } else return null;
  }
  if (r.left !== 0) return null;
  return {
    serverTick, ackSeq,
    own: { mode: mode as OwnMode, engine: engine as EngineState, carId, char, car, bikeId, fallTicks, bike },
    walkers, cars, riders, bikes, lamps, events,
  };
}
