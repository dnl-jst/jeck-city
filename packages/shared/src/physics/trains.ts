import type RAPIER from '@dimforge/rapier3d-compat';
import { BENCH, SECTION_STRIDE, sectionBenches, sectionQuat, sectionStates, TRAIN, TRAIN_SECTIONS, transitModel, type Transit, type TransitModel } from '../transit';
import { TRAIN_FLOOR_GROUPS, TRAIN_GROUPS, type PhysicsWorld } from './world';

/** Where idle sections wait (far below the world). */
const PARKED_Y = -500, PARK_SPACING = 20;
/** Sections within this distance (m, per axis) of a player have a body in the world. */
const NEAR = 250;
type XZ = { x: number; z: number };

type Section = { body: RAPIER.RigidBody; left: RAPIER.Collider; right: RAPIER.Collider; active: boolean };

/**
 * The trains as kinematic bodies, one per section: a floor, a roof, side walls with a door opening each side (closed
 * by a collider unless the door is open) and end walls at a unit's ends. People walk in and are carried along
 * (Character: the floor carries, the walls stay solid). Poses come from sectionStates(tick) alone.
 */
export class Trains {
  readonly model: TransitModel;
  private readonly sections: Section[] = [];
  private readonly state: Float64Array;
  /** The points trains are simulated around (the players), or null: everywhere. */
  private near: readonly XZ[] | null = null;

  constructor(private readonly pw: PhysicsWorld, transit: Transit) {
    this.model = transitModel(transit);
    this.state = new Float64Array(this.model.count * SECTION_STRIDE);
    const { rapier: R, world } = pw;
    const floors = new Set<number>();
    const L = TRAIN.sectionLength / 2, W = TRAIN.halfWidth, wall = TRAIN.wall / 2, door = TRAIN.doorWidth / 2;
    const wallH = (TRAIN.ceiling - TRAIN.floor) / 2, wallY = TRAIN.floor + wallH;
    for (let i = 0; i < this.model.count; i++) {
      const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(i * PARK_SPACING, PARKED_Y, 0));
      const box = (hx: number, hy: number, hz: number, x: number, y: number, z: number, groups = TRAIN_GROUPS): RAPIER.Collider =>
        world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setCollisionGroups(groups), body);
      // (a little longer than the body: the floors of two sections meet over the joint. Over a gap nobody would be
      // carried for a few steps, and at speed that throws a person back onto the section they came from)
      floors.add(box(W, 0.1, L + TRAIN.joint / 2 + 0.03, 0, TRAIN.floor - 0.1, 0, TRAIN_FLOOR_GROUPS).handle);
      box(W, 0.05, L, 0, TRAIN.ceiling + 0.05, 0);
      const seg = (L - door) / 2;
      for (const side of [1, -1]) {
        for (const end of [1, -1]) box(wall, wallH, seg, side * (W - wall), wallY, end * (door + seg));
      }
      const k = i % TRAIN.sections;
      // a unit's ends: the end wall, and the back wall of the driver's cab
      if (k === 0) { box(W, wallH, wall, 0, wallY, -L + wall); box(W, wallH, wall, 0, wallY, -L + TRAIN.cab); }
      if (k === TRAIN.sections - 1) { box(W, wallH, wall, 0, wallY, L - wall); box(W, wallH, wall, 0, wallY, L - TRAIN.cab); }
      // the benches: the seat as a block from the floor, and its back
      for (const b of sectionBenches(k)) {
        const cx = (b.x0 + b.x1) / 2, hx = (b.x1 - b.x0) / 2, cz = (b.z0 + b.z1) / 2;
        box(hx, BENCH.seat / 2, (b.z1 - b.z0) / 2, cx, TRAIN.floor + BENCH.seat / 2, cz);
        const back = b.facing > 0 ? b.z0 - BENCH.backThick / 2 : b.z1 + BENCH.backThick / 2;
        if (b.facing > 0) box(hx, BENCH.back / 2, BENCH.backThick / 2, cx, TRAIN.floor + BENCH.back / 2, back);
      }
      const left = box(wall, wallH, door, W - wall, wallY, 0), right = box(wall, wallH, door, -(W - wall), wallY, 0);
      this.sections.push({ body, left, right, active: false });
    }
    this.place(0);
    pw.trainFloors = floors;
  }

  /** The sections' states as last placed or advanced (see sectionStates). */
  get states(): Float64Array {
    return this.state;
  }

  /**
   * Puts every section where it is at `tick`, at once (start, replay). near: only sections within NEAR of one of these
   * points get a body in the world (the others wait parked): hundreds of moving bodies cost the step far more than
   * the few trains anyone can reach.
   */
  place(tick: number, near?: readonly XZ[]): void {
    if (near) this.near = near;
    this.apply(tick, true);
    this.pw.world.propagateModifiedBodyPositionsToColliders();
  }

  /** Before a physics step: the sections move to where they are at `tick` during it (near: see place). */
  advance(tick: number, near?: readonly XZ[]): void {
    if (near) this.near = near;
    this.apply(tick, false);
  }

  private apply(tick: number, jump: boolean): void {
    const s = sectionStates(this.model, tick, this.state);
    for (let i = 0; i < this.sections.length; i++) {
      const sec = this.sections[i]!, o = i * SECTION_STRIDE;
      let active = s[o] === 1;
      if (active && this.near) {
        const x = s[o + 1]!, z = s[o + 3]!;
        active = this.near.some((p) => Math.abs(p.x - x) < NEAR && Math.abs(p.z - z) < NEAR);
      }
      if (!active) {
        if (sec.active || jump) {
          // (each in a place of its own: hundreds of bodies in one spot would all overlap in the broad phase)
          sec.body.setTranslation({ x: i * PARK_SPACING, y: PARKED_Y, z: 0 }, false);
          sec.body.setNextKinematicTranslation({ x: i * PARK_SPACING, y: PARKED_Y, z: 0 });
        }
        sec.active = false;
        continue;
      }
      const t = { x: s[o + 1]!, y: s[o + 2]!, z: s[o + 3]! }, q = sectionQuat(s[o + 4]!, s[o + 5]!);
      if (jump || !sec.active) {
        // appearing (or put somewhere): no sweep from where it was
        sec.body.setTranslation(t, true);
        sec.body.setRotation(q, true);
      }
      sec.body.setNextKinematicTranslation(t);
      sec.body.setNextKinematicRotation(q);
      sec.active = true;
      const openL = s[o + 6]! > 0.5, openR = s[o + 7]! > 0.5;
      if (sec.left.isEnabled() === openL) sec.left.setEnabled(!openL);
      if (sec.right.isEnabled() === openR) sec.right.setEnabled(!openR);
    }
  }
}

export { TRAIN_SECTIONS };
