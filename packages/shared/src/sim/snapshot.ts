import type {
  Snapshot, SnapshotBike, SnapshotCar, SnapshotEvent, SnapshotLamp, SnapshotOwn, SnapshotRider, SnapshotWalker, WalkerState,
} from '../net/codec';
import { INTEREST_RADIUS } from '../net/constants';
import type { Interest, InterestEntity } from '../net/interest';
import type { PlayerId } from './cars';
import type { SimEvent, WorldSim } from './world-sim';

/** Below this ground speed (m/s) a person on foot counts as standing. */
const WALK_MIN_SPEED = 0.3;

const ENGINE = { off: 0, starting: 1, running: 2 } as const;
const MODE = { walk: 0, drive: 1, down: 2, ride: 3 } as const;

type Entry<T> = { key: string; x: number; z: number; v: T };

/**
 * What all snapshots of one round share, built once per round instead of once per client: people on foot or down,
 * riders, moving unridden bikes, cars that are driven or awake, tipping lamps, and the round's events. `owner`/`car`
 * let each client's snapshot leave out its own entries.
 */
export type SnapshotRound = {
  tick: number;
  walkers: (Entry<SnapshotWalker> & { owner: PlayerId })[];
  riders: (Entry<SnapshotRider> & { owner: PlayerId })[];
  bikes: Entry<SnapshotBike>[];
  cars: Entry<SnapshotCar>[];
  lamps: Entry<SnapshotLamp>[];
  events: SimEvent[];
  slotOf: (id: PlayerId) => number;
};

/** The shared part of a snapshot round (see SnapshotRound); pass it to snapshotFor for each client. */
export function snapshotRound(sim: WorldSim, events: SimEvent[], slotOf: (id: PlayerId) => number): SnapshotRound {
  const walkers: SnapshotRound['walkers'] = [];
  for (const other of sim.players()) {
    const p = sim.player(other);
    if (p.mode === 'drive' || p.mode === 'ride') continue; // represented by the car or the rider entry
    const slot = slotOf(other);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const state: WalkerState = p.falling ? 3 : p.mode === 'down' ? 2 : speed > WALK_MIN_SPEED ? 1 : 0;
    walkers.push({ key: `p${slot}`, x: p.pos.x, z: p.pos.z, owner: other, v: { slot, x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.facing, speed, state } });
  }

  const riders: SnapshotRound['riders'] = [];
  for (const { id: other, bike } of sim.riders()) {
    const slot = slotOf(other);
    const s = bike.state();
    const p = sim.player(other);
    riders.push({
      key: `r${slot}`, x: s.x, z: s.z, owner: other,
      v: { slot, bikeId: p.bikeId!, x: s.x, y: s.y, z: s.z, heading: s.heading, speed: s.speed, steer: s.steer, pedalling: p.pedalling, airborne: !s.grounded },
    });
  }

  const bikes: SnapshotRound['bikes'] = [];
  // (a body that just appeared settles for a moment at its spot: only bikes away from it count as moving)
  for (const i of sim.bikes.awake()) {
    if (!sim.bikes.isMoved(i)) continue;
    const p = sim.bikes.poses[i]!;
    bikes.push({ key: `b${i}`, x: p.x, z: p.z, v: { id: i, x: p.x, y: p.y, z: p.z, heading: p.heading } });
  }

  const cars: SnapshotRound['cars'] = [];
  const carIds = new Set(sim.cars.awake());
  sim.cars.driver.forEach((d, i) => { if (d !== null) carIds.add(i); });
  for (const i of [...carIds].sort((a, b) => a - b)) {
    const v = sim.cars.vehicle(i);
    if (!v) continue;
    const s = v.saveState();
    cars.push({
      key: `c${i}`, x: s.x, z: s.z,
      v: {
        id: i, x: s.x, y: s.y, z: s.z, qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw, vx: s.vx, vy: s.vy, vz: s.vz,
        steer: s.steer, brakeLight: sim.braking(i), hasDriver: sim.cars.driver[i] !== null, horn: sim.horning(i),
      },
    });
  }

  const lamps: SnapshotRound['lamps'] = [];
  for (const i of sim.lampsDown()) {
    if (sim.lampState(i) !== 'tipping') continue;
    const p = sim.props.lampPose(i);
    lamps.push({ key: `l${i}`, x: p.x, z: p.z, v: { i, ...p } });
  }

  return { tick: sim.tick, walkers, riders, bikes, cars, lamps, events, slotOf };
}

/**
 * Snapshot of `round` for player `id`: own state in full, and what the interest set of that client contains:
 * other people on foot or down, cars that are driven or awake (not the player's own), other riders, unridden bikes
 * that move (away from their manifest spot), tipping lamps, and events with a position in range (a `knock` on the player themself always; the own
 * bell never). `interest` is that client's persistent state.
 */
export function snapshotFor(round: SnapshotRound, sim: WorldSim, id: PlayerId, interest: Interest, ackSeq: number): Snapshot {
  const { slotOf } = round;
  const me = sim.player(id);
  const focus = me.pos;

  const entities: InterestEntity[] = [];
  const add = (es: Entry<unknown>[]) => { for (const e of es) entities.push(e); };
  for (const w of round.walkers) if (w.owner !== id) entities.push(w);
  for (const r of round.riders) if (r.owner !== id) entities.push(r);
  add(round.bikes);
  const ownCar = me.carId === null ? null : `c${me.carId}`;
  for (const c of round.cars) if (c.key !== ownCar) entities.push(c);
  add(round.lamps);

  const inside = interest.update(focus, entities);
  const near = (x: number, z: number): boolean => Math.hypot(x - focus.x, z - focus.z) <= INTEREST_RADIUS;

  const out: SnapshotEvent[] = [];
  for (const e of round.events) {
    if (e.t === 'knock') {
      if (e.id === id) out.push({ t: 'knock', slot: slotOf(id) });
      else if (inside.has(`p${slotOf(e.id)}`)) out.push({ t: 'knock', slot: slotOf(e.id) });
    } else if (e.t === 'impact') {
      if (near(e.x, e.z)) out.push({ t: 'impact', x: e.x, z: e.z, strength: e.strength });
    } else if (e.t === 'lamp') {
      const p = sim.props.lampPose(e.i);
      if (near(p.x, p.z)) out.push({ t: 'lamp', i: e.i });
    } else if (e.t === 'bell') {
      if (e.id !== id && near(e.x, e.z)) out.push({ t: 'bell', slot: slotOf(e.id), x: e.x, z: e.z });
    }
  }

  const own: SnapshotOwn = {
    mode: MODE[me.mode], engine: ENGINE[me.engine], carId: me.carId ?? 0, char: me.char, car: me.car,
    bikeId: me.bikeId ?? 0, fallTicks: me.fallTicks, bike: me.bike,
  };
  // (own entries never got into `inside`)
  const pick = <T>(es: Entry<T>[]): T[] => { const r: T[] = []; for (const e of es) if (inside.has(e.key)) r.push(e.v); return r; };
  return {
    serverTick: round.tick, ackSeq, own, walkers: pick(round.walkers), cars: pick(round.cars), riders: pick(round.riders),
    bikes: pick(round.bikes), lamps: pick(round.lamps), events: out,
  };
}

/** Snapshot of the world for player `id` (one client; a server with many builds the round once, see snapshotRound). */
export function buildSnapshot(
  sim: WorldSim, id: PlayerId, interest: Interest, ackSeq: number, events: SimEvent[], slotOf: (id: PlayerId) => number,
): Snapshot {
  return snapshotFor(snapshotRound(sim, events, slotOf), sim, id, interest, ackSeq);
}
