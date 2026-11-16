import type RAPIER from '@dimforge/rapier3d-compat';
import { CHARACTER_CENTRE } from '../physics/character';
import type { BikePose, ParkedBikes } from '../physics/parkedbikes';
import { TUNING } from '../physics/tuning';
import { CHARACTER_GROUPS, type PhysicsWorld } from '../physics/world';
import type { CarPool, PlayerId } from './cars';
import type { CarPose } from './rules';

type Vec3 = { x: number; y: number; z: number };

/**
 * Other players in the client's prediction world: people on foot as kinematic capsules (the own character walks
 * into them like on the server), cars someone else drives or the server streams as kinematic cars on their pose
 * (CarPool.follow), bikes someone else rides or the server streams the same way (ParkedBikes.follow). Nothing here is
 * simulated; the poses come from the snapshots.
 */
export class Proxies {
  private readonly walkers = new Map<PlayerId, RAPIER.RigidBody>();

  constructor(private readonly pw: PhysicsWorld, private readonly cars: CarPool, private readonly bikes: ParkedBikes) {}

  /** Number of walker capsules (tests, debug). */
  get walkerCount(): number {
    return this.walkers.size;
  }

  /** Feet positions of the other people on foot: capsules are created, moved (in the next step) and removed. */
  setWalkers(feet: ReadonlyMap<PlayerId, Vec3>): void {
    const { rapier: R, world } = this.pw;
    for (const [id, body] of this.walkers) {
      if (feet.has(id)) continue;
      world.removeRigidBody(body);
      this.walkers.delete(id);
    }
    for (const [id, p] of feet) {
      const t = { x: p.x, y: p.y + CHARACTER_CENTRE, z: p.z };
      let body = this.walkers.get(id);
      if (!body) {
        body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(t.x, t.y, t.z));
        const T = TUNING.character;
        world.createCollider(R.ColliderDesc.capsule(T.height / 2 - T.radius, T.radius).setCollisionGroups(CHARACTER_GROUPS), body);
        this.walkers.set(id, body);
      }
      body.setNextKinematicTranslation(t);
    }
  }

  /**
   * Streamed car poses: each is followed (kinematic). A followed car missing from `poses` comes to rest, dynamic and
   * asleep, at `rest(i)` (the server's pose of the parked car) or else where it was last followed. Cars for which
   * `skip(i)` holds (driven by a local player) are left alone.
   */
  setCars(poses: ReadonlyMap<number, CarPose>, skip: (i: number) => boolean, rest?: (i: number) => CarPose | null): void {
    for (const i of [...this.cars.following()]) {
      if (poses.has(i) || skip(i)) continue;
      this.cars.release(i, rest?.(i) ?? this.cars.vehicle(i)!.pose());
    }
    for (const [i, pose] of poses) if (!skip(i)) this.cars.follow(i, pose);
  }

  /** Streamed bike poses, as setCars: followed; one missing from `poses` rests at rest(i) or where it was last followed. */
  setBikes(poses: ReadonlyMap<number, BikePose>, skip: (i: number) => boolean, rest?: (i: number) => BikePose | null): void {
    for (const i of [...this.bikes.following()]) {
      if (poses.has(i) || skip(i)) continue;
      this.bikes.release(i, rest?.(i) ?? this.bikes.poses[i]!);
    }
    for (const [i, pose] of poses) if (!skip(i)) this.bikes.follow(i, pose);
  }

}
