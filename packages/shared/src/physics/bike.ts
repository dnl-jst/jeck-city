import type RAPIER from '@dimforge/rapier3d-compat';
import { BIKE_SPECS, type BikeSpec, type BikeType } from './biketypes';
import { TUNING } from './tuning';
import { BIKE_GROUPS, type PhysicsWorld } from './world';

/** pedal −1..1 (negative = brake, at a standstill push backwards), steer −1..1 (positive = right). */
export type BikeInput = { pedal: number; steer: number; sprint: boolean; hop: boolean };

/**
 * Everything the bike needs to continue from a point in time (client prediction / server rewind later).
 * x/y/z = ground under the wheels (y), heading h faces (sin h, cos h); speed signed along the heading (m/s);
 * steer = front wheel angle (rad, + = right); crank = pedal phase (rad).
 */
export type BikeState = { x: number; y: number; z: number; heading: number; speed: number; steer: number; vy: number; grounded: boolean; crank: number };

export type BikeStepResult = { crashed: boolean; landed: boolean };

const T = TUNING.bike;
const DT = TUNING.world.dt;
const KMH = 1 / 3.6;
const G = 9.81;
/** Front wheel angle follows the input at this rate (rad/s). */
const STEER_RATE = 4;
/** Pedal revolutions per wheel revolution are 1/GEAR; with a 0.35 m wheel. */
const GEAR = 2.5;
const WHEEL_R = 0.35;

/** Half width of the bike's frame collider for a type (wide trikes get a wider one). */
export function bikeColliderRadius(spec: BikeSpec): number {
  return Math.max(T.colliderRadius, spec.width / 2);
}

/** Wheel capsule (upright, like the walking character): radius and half height of its straight part. */
const FOOT_R = 0.3;
const FOOT_HALF = 0.12;
/** Frame box: from FRAME_BOTTOM above the ground (clear of kerbs) to FRAME_TOP; ~0.3 m past the axles. */
const FRAME_BOTTOM = 0.3;
const FRAME_TOP = 1.2;
const OFFSET = 0.02;
/** Dynamic bodies lighter than this are shoved, not stopped at (kg). */
const LIGHT_BODY_KG = 100;

/**
 * Ridden bike (approach A of the bike design): a kinematic body with arcade bike logic on top.
 * Two colliders: a small upright capsule moved by Rapier's KinematicCharacterController (ground, kerbs by autostep,
 * slopes – the proven setup of the walking character; a long box on the ground catches on triangle seams), and a
 * frame box in the bike's length, raised above kerb height, that is shape-cast ahead each step for walls, posts,
 * cars and racks. The bike never tips; lean is visual (lean()). Call applyInput once per fixed step, before
 * PhysicsWorld.step().
 */
export class RiddenBike {
  readonly body: RAPIER.RigidBody;
  readonly spec: BikeSpec;
  private readonly foot: RAPIER.Collider;
  private readonly frame: RAPIER.Collider;
  private readonly frameShape: RAPIER.Cuboid;
  /** Frame box centre above the body origin. */
  private readonly frameY: number;
  private readonly kcc: RAPIER.KinematicCharacterController;
  /** Body origin (capsule centre) above the ground. */
  private readonly centre = FOOT_R + FOOT_HALF + OFFSET;
  private readonly notMe: (c: RAPIER.Collider) => boolean;
  private s: BikeState;

  constructor(private readonly pw: PhysicsWorld, readonly type: BikeType, pose: { x: number; y: number; z: number; heading: number }, speed = 0) {
    const { rapier: R, world } = pw;
    this.spec = BIKE_SPECS[type];
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.foot = world.createCollider(R.ColliderDesc.capsule(FOOT_HALF, FOOT_R).setCollisionGroups(BIKE_GROUPS), this.body);
    const hx = bikeColliderRadius(this.spec), hy = (FRAME_TOP - FRAME_BOTTOM) / 2, hz = this.spec.wheelbase / 2 + 0.3;
    this.frameY = FRAME_BOTTOM + hy - this.centre;
    this.frameShape = new R.Cuboid(hx, hy, hz);
    this.frame = world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, this.frameY, 0).setCollisionGroups(BIKE_GROUPS), this.body);
    const me = this.body.handle;
    // light dynamic bodies (parked bikes) are not obstacles for the frame cast: the kinematic frame shoves them
    this.notMe = (c) => {
      if (c.isSensor()) return false;
      const b = c.parent();
      return !b || (b.handle !== me && !(b.isDynamic() && b.mass() < LIGHT_BODY_KG));
    };
    this.kcc = world.createCharacterController(OFFSET);
    this.kcc.enableAutostep(T.stepMaxHeight, T.stepMinWidth, true);
    this.kcc.enableSnapToGround(T.snapToGround);
    this.kcc.setSlideEnabled(true);
    this.kcc.setMaxSlopeClimbAngle(T.maxSlope);
    this.kcc.setMinSlopeSlideAngle(T.maxSlope);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(90);
    this.s = { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading, speed, steer: 0, vy: 0, grounded: true, crank: 0 };
    this.place();
  }

  /** One fixed step. */
  applyInput(i: BikeInput): BikeStepResult {
    const s = this.s, sp = this.spec;
    const pedal = Math.max(-1, Math.min(1, i.pedal));
    const steerIn = Math.max(-1, Math.min(1, i.steer));
    const wasGrounded = s.grounded;

    // speed along the heading
    if (s.grounded) {
      const top = (i.sprint ? sp.sprintKmh : sp.cruiseKmh) * KMH;
      if (pedal > 0) {
        const target = top * pedal;
        if (s.speed < target) {
          let a = i.sprint ? sp.sprintAccel : sp.accel;
          if (sp.assistKmh !== undefined) {
            if (s.speed > sp.assistKmh * KMH) a *= 0.3;
          } else a *= 1 - 0.4 * (Math.max(0, s.speed) / top) ** 2;
          if (s.speed < 0) a = sp.brake;
          s.speed = Math.min(target, s.speed + a * DT);
        } else s.speed = Math.max(target, s.speed - T.rollDecel * 2 * DT);
      } else if (pedal < 0) {
        if (s.speed > 0.05) s.speed = Math.max(0, s.speed + pedal * sp.brake * DT);
        else s.speed = Math.max(-T.reverseKmh * KMH, s.speed + pedal * 1.5 * DT);
      } else {
        s.speed = s.speed > 0 ? Math.max(0, s.speed - T.rollDecel * DT) : Math.min(0, s.speed + T.rollDecel * 4 * DT);
      }
    }

    // steering: lock tapers with speed; front wheel eases towards it
    const kmh = Math.abs(s.speed) / KMH;
    const k = Math.max(0, Math.min(1, (kmh - T.steerLowKmh) / (T.steerHighKmh - T.steerLowKmh)));
    const lock = sp.steerLowLock + (sp.steerHighLock - sp.steerLowLock) * k;
    const target = steerIn * lock * (s.grounded ? 1 : T.airSteer);
    const md = STEER_RATE * DT;
    s.steer += Math.max(-md, Math.min(md, target - s.steer));
    // turning right lowers the heading (forward (sin h, cos h), right (−cos h, sin h))
    s.heading -= (s.speed * Math.tan(s.steer) / sp.wheelbase) * DT;
    s.heading = Math.atan2(Math.sin(s.heading), Math.cos(s.heading));

    // vertical
    if (i.hop && s.grounded) {
      s.vy = sp.hopSpeed;
      s.grounded = false;
    }
    s.vy += T.gravity * DT;

    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    const q = yawQuat(s.heading);
    let dx = fx * s.speed * DT, dz = fz * s.speed * DT;
    /** How head-on the frame hits something this step (0 none/glancing … 1 straight into it). */
    let frontal = 0;
    // frame box ahead: walls, posts, cars, racks; slide along what it hits
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      const ux = dx / len, uz = dz / len;
      const origin = { x: s.x, y: s.y + this.centre + this.frameY, z: s.z };
      const hit = this.pw.world.castShape(origin, q, { x: ux, y: 0, z: uz }, this.frameShape, 0.01, len, false,
        undefined, undefined, undefined, undefined, this.notMe);
      if (hit) {
        const toi = hit.time_of_impact;
        // normal1: the hit collider's outward normal (Rapier 0.21 castShape; normal2 is the cast box's)
        const n = hit.normal1, nl = Math.hypot(n.x, n.z);
        const rx = dx - ux * toi, rz = dz - uz * toi; // the part of the move behind the obstacle
        let sx = 0, sz = 0;
        if (nl > 1e-6) {
          const nx = n.x / nl, nz = n.z / nl, d = rx * nx + rz * nz;
          frontal = Math.max(0, -(ux * nx + uz * nz));
          if (d < 0) { sx = rx - d * nx; sz = rz - d * nz; } else { sx = rx; sz = rz; }
        }
        dx = ux * toi + sx;
        dz = uz * toi + sz;
      }
    }
    const want = { x: dx, y: s.vy * DT, z: dz };
    this.kcc.computeColliderMovement(this.foot, want, this.pw.rapier.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.notMe);
    const m = this.kcc.computedMovement();
    this.s.grounded = this.kcc.computedGrounded() && s.vy <= 0;
    if (s.grounded) s.vy = 0;

    // forward movement blocked by the frame cast (not by the controller, which now and then returns a zero move on
    // flat ground for one step): crash when fast and head-on, otherwise lose the blocked speed
    let crashed = false;
    const wantF = s.speed * DT;
    if (Math.abs(wantF) > 1e-6) {
      const got = (dx * fx + dz * fz) / wantF;
      if (frontal > T.crashBlocked && s.speed > T.crashKmh * KMH) {
        crashed = true;
        s.speed = 0;
      } else if (got < 0.999) s.speed *= Math.max(0, got);
    }

    s.x += m.x;
    s.y += m.y;
    s.z += m.z;
    if (pedal > 0 && s.speed > 0) s.crank += (s.speed / WHEEL_R / GEAR) * DT;
    this.body.setNextKinematicTranslation({ x: s.x, y: s.y + this.centre, z: s.z });
    this.body.setNextKinematicRotation(q);
    return { crashed, landed: !wasGrounded && s.grounded };
  }

  state(): BikeState {
    return { ...this.s };
  }

  restore(st: BikeState): void {
    this.s = { ...st };
    this.place();
  }

  /** Visual lean (rad, + = to the right) from speed and steering, limited to the type's maxLeanDeg. */
  lean(): number {
    const max = (this.spec.maxLeanDeg * Math.PI) / 180;
    if (max === 0) return 0;
    const curv = Math.tan(this.s.steer) / this.spec.wheelbase;
    const a = Math.atan((this.s.speed * this.s.speed * curv) / G);
    return Math.max(-max, Math.min(max, a));
  }

  /** Removes the bike from the world. The instance must not be used afterwards. */
  dispose(): void {
    this.pw.world.removeCharacterController(this.kcc);
    this.pw.world.removeRigidBody(this.body);
  }

  private place(): void {
    const t = { x: this.s.x, y: this.s.y + this.centre, z: this.s.z };
    const q = yawQuat(this.s.heading);
    this.body.setTranslation(t, true);
    this.body.setRotation(q, true);
    this.body.setNextKinematicTranslation(t);
    this.body.setNextKinematicRotation(q);
    this.pw.world.propagateModifiedBodyPositionsToColliders();
  }
}

function yawQuat(h: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) };
}
