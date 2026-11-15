import type {
  Snapshot, SnapshotCar, SnapshotEvent, SnapshotLamp, SnapshotOwn, SnapshotWalker, WalkerState,
} from '../net/codec';
import { INTEREST_RADIUS } from '../net/constants';
import type { Interest, InterestEntity } from '../net/interest';
import type { PlayerId } from './cars';
import type { SimEvent, WorldSim } from './world-sim';

/** Below this ground speed (m/s) a person on foot counts as standing. */
const WALK_MIN_SPEED = 0.3;

const ENGINE = { off: 0, starting: 1, running: 2 } as const;
const MODE = { walk: 0, drive: 1, down: 2 } as const;

/**
 * Snapshot of the world for player `id`: own state in full, and what the interest set of that client contains:
 * other people on foot or down, cars that are driven or awake (not the player's own), tipping lamps, and events with
 * a position in range (a `knock` on the player themself always). `interest` is that client's persistent state.
 */
export function buildSnapshot(
  sim: WorldSim, id: PlayerId, interest: Interest, ackSeq: number, events: SimEvent[], slotOf: (id: PlayerId) => number,
): Snapshot {
  const me = sim.player(id);
  const focus = me.pos;

  const entities: InterestEntity[] = [];
  const walkers = new Map<string, SnapshotWalker>();
  for (const other of sim.players()) {
    if (other === id) continue;
    const p = sim.player(other);
    if (p.mode === 'drive') continue; // represented by the car
    const slot = slotOf(other);
    const key = `p${slot}`;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const state: WalkerState = p.mode === 'down' ? 2 : speed > WALK_MIN_SPEED ? 1 : 0;
    walkers.set(key, { slot, x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, speed, state });
    entities.push({ key, x: p.pos.x, z: p.pos.z });
  }

  const cars = new Map<string, SnapshotCar>();
  const carIds = new Set(sim.cars.awake());
  sim.cars.driver.forEach((d, i) => { if (d !== null) carIds.add(i); });
  for (const i of [...carIds].sort((a, b) => a - b)) {
    if (i === me.carId) continue;
    const v = sim.cars.vehicle(i);
    if (!v) continue;
    const s = v.saveState();
    const key = `c${i}`;
    const hasDriver = sim.cars.driver[i] !== null;
    cars.set(key, {
      id: i, x: s.x, y: s.y, z: s.z, qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw, vx: s.vx, vy: s.vy, vz: s.vz,
      steer: s.steer, brakeLight: sim.braking(i), hasDriver,
    });
    entities.push({ key, x: s.x, z: s.z });
  }

  const lamps = new Map<string, SnapshotLamp>();
  for (let i = 0; i < sim.props.count; i++) {
    if (sim.lampState(i) !== 'tipping') continue;
    const key = `l${i}`;
    lamps.set(key, { i, ...sim.props.lampPose(i) });
    entities.push({ key, x: sim.props.lampPose(i).x, z: sim.props.lampPose(i).z });
  }

  const inside = interest.update(focus, entities);
  const near = (x: number, z: number): boolean => Math.hypot(x - focus.x, z - focus.z) <= INTEREST_RADIUS;

  const out: SnapshotEvent[] = [];
  for (const e of events) {
    if (e.t === 'knock') {
      if (e.id === id) out.push({ t: 'knock', slot: slotOf(id) });
      else if (inside.has(`p${slotOf(e.id)}`)) out.push({ t: 'knock', slot: slotOf(e.id) });
    } else if (e.t === 'impact') {
      if (near(e.x, e.z)) out.push({ t: 'impact', x: e.x, z: e.z, strength: e.strength });
    } else if (e.t === 'lamp') {
      const p = sim.props.lampPose(e.i);
      if (near(p.x, p.z)) out.push({ t: 'lamp', i: e.i });
    }
  }

  const own: SnapshotOwn = { mode: MODE[me.mode], engine: ENGINE[me.engine], carId: me.carId ?? 0, char: me.char, car: me.car };
  const pick = <T>(m: Map<string, T>): T[] => [...m].filter(([k]) => inside.has(k)).map(([, v]) => v);
  return { serverTick: sim.tick, ackSeq, own, walkers: pick(walkers), cars: pick(cars), lamps: pick(lamps), events: out };
}
