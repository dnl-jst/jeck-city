import type RAPIER from '@dimforge/rapier3d-compat';
import { CAR_SPECS, CAR_TYPES } from '../physics/cartypes';
import { CHARACTER_CENTRE } from '../physics/character';
import { TUNING } from '../physics/tuning';
import { CAR_GROUPS, CHARACTER_GROUPS, type PhysicsWorld } from '../physics/world';
import type { NpcBody } from './npc-director';

/** Where NPCs near the players are: the director on the server, the plan feed on the client. */
export interface NpcSource {
  bodiesNear(tick: number, points: readonly { x: number; z: number }[], r: number): NpcBody[];
}

/** The road clearance of an NPC car's box (m). */
const CLEARANCE = 0.25;

/**
 * Kinematic stand-ins for the NPCs near players: a box per car (car collision groups: player cars bounce off it),
 * a capsule per walker, cyclist or sitter (character groups: people do not walk through them). Lying NPCs have none.
 * Nothing here is simulated: sync() puts each body where its plan says for the coming step.
 */
export class NpcBodies {
  private readonly bodies = new Map<number, RAPIER.RigidBody>();

  constructor(private readonly pw: PhysicsWorld) {}

  get count(): number {
    return this.bodies.size;
  }

  sync(list: readonly NpcBody[]): void {
    const { rapier: R, world } = this.pw;
    const want = new Map<number, NpcBody>();
    for (const b of list) if (!b.lying) want.set(b.id, b);
    for (const [id, body] of this.bodies) {
      if (want.has(id)) continue;
      world.removeRigidBody(body);
      this.bodies.delete(id);
    }
    for (const b of want.values()) {
      const car = b.kind === 'driver';
      const spec = CAR_SPECS[CAR_TYPES[b.vehicleType] ?? CAR_TYPES[0]!];
      const y = car ? b.y + CLEARANCE + (spec.height - CLEARANCE) / 2 : b.y + CHARACTER_CENTRE;
      const t = { x: b.x, y, z: b.z };
      const q = { x: 0, y: Math.sin(b.heading / 2), z: 0, w: Math.cos(b.heading / 2) };
      let body = this.bodies.get(b.id);
      if (!body) {
        body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(t.x, t.y, t.z).setRotation(q));
        const shape = car
          ? R.ColliderDesc.cuboid(spec.width / 2, (spec.height - CLEARANCE) / 2, spec.length / 2).setCollisionGroups(CAR_GROUPS)
          : R.ColliderDesc.capsule(TUNING.character.height / 2 - TUNING.character.radius, TUNING.character.radius).setCollisionGroups(CHARACTER_GROUPS);
        world.createCollider(shape, body);
        this.bodies.set(b.id, body);
      }
      body.setNextKinematicTranslation(t);
      body.setNextKinematicRotation(q);
    }
  }

  dispose(): void {
    for (const body of this.bodies.values()) this.pw.world.removeRigidBody(body);
    this.bodies.clear();
  }
}
