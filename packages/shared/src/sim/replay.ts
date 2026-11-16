import type RAPIER from '@dimforge/rapier3d-compat';
import type { BikeState } from '../physics/bike';
import type { CharacterState } from '../physics/character';
import type { VehicleState } from '../physics/vehicle';
import type { SnapshotOwn } from '../net/codec';
import type { IgnitionSave, IgnitionState } from './ignition';

/**
 * A player's own state as the server had it after the input `ackSeq` (client reconciliation): where WorldSim.replay
 * starts. carId is the car while driving (null otherwise); car the car's state while driving; bikeId / bike the same
 * while riding. fallTicks: ticks left lying after falling off a bike.
 */
export type OwnState = {
  mode: 'walk' | 'drive' | 'down' | 'ride';
  carId: number | null;
  char: CharacterState;
  car: VehicleState | null;
  bikeId?: number | null;
  bike?: BikeState | null;
  fallTicks?: number;
  /** Engine of the car while driving (the server's ignition state). */
  engine?: IgnitionState;
  /** Exact ignition of that car at that instant if known (the client's prediction for the same input); wins over engine. */
  ignition?: IgnitionSave;
  /** use/jump of the input applied at that instant: the first replayed input acts on a rising edge against them. */
  use?: boolean;
  jump?: boolean;
};

const MODES = ['walk', 'drive', 'down', 'ride'] as const;
const ENGINES = ['off', 'starting', 'running'] as const;

/** The own state a snapshot carries, as replay takes it (carId only while driving, bikeId only while riding). */
export function ownStateOf(o: SnapshotOwn): OwnState {
  const mode = MODES[o.mode];
  const drive = mode === 'drive' && o.car !== null;
  const ride = mode === 'ride' && o.bike !== null;
  return {
    mode, carId: drive ? o.carId : null, char: o.char, car: drive ? o.car : null, engine: drive ? ENGINES[o.engine] : 'off',
    bikeId: ride ? o.bikeId : null, bike: ride ? o.bike : null, fallTicks: o.fallTicks,
  };
}

type BodySave = {
  body: RAPIER.RigidBody; sleeping: boolean;
  t: RAPIER.Vector; r: RAPIER.Rotation; lv: RAPIER.Vector; av: RAPIER.Vector;
};

/**
 * Pose, velocities and sleep state of every dynamic body except `exclude` (handles): what WorldSim.replay puts back
 * after re-simulating the own entity, so that nothing else advances twice.
 */
export function saveDynamicBodies(world: RAPIER.World, exclude: ReadonlySet<number>): BodySave[] {
  const out: BodySave[] = [];
  world.forEachRigidBody((body) => {
    if (!body.isDynamic() || exclude.has(body.handle)) return;
    out.push({ body, sleeping: body.isSleeping(), t: body.translation(), r: body.rotation(), lv: body.linvel(), av: body.angvel() });
  });
  return out;
}

/**
 * Puts the bodies back into the saved state (bodies that were removed from `world`, turned non-dynamic or are in
 * `skip` meanwhile are left alone).
 */
export function restoreDynamicBodies(world: RAPIER.World, saved: readonly BodySave[], skip: ReadonlySet<number>): void {
  for (const s of saved) {
    const b = s.body;
    if (skip.has(b.handle) || world.getRigidBody(b.handle) !== b || !b.isDynamic()) continue;
    // slept through the replay (asleep, same pose): unchanged. Setting its pose anyway marks its colliders modified,
    // and the next step wakes it (contacts recomputed): every nearby parked car and bike would wake on every replay.
    if (s.sleeping && b.isSleeping() && samePose(b, s)) continue;

    b.setTranslation(s.t, !s.sleeping);
    b.setRotation(s.r, !s.sleeping);
    b.setLinvel(s.lv, !s.sleeping);
    b.setAngvel(s.av, !s.sleeping);
    if (s.sleeping) b.sleep();
  }
}

function samePose(b: RAPIER.RigidBody, s: BodySave): boolean {
  const t = b.translation(), r = b.rotation();
  return t.x === s.t.x && t.y === s.t.y && t.z === s.t.z && r.x === s.r.x && r.y === s.r.y && r.z === s.r.z && r.w === s.r.w;
}
