import type RAPIER from '@dimforge/rapier3d-compat';
import { CAR_SPECS, type CarSpec, type CarType } from './cartypes';
import { TUNING } from './tuning';
import { CAR_GROUPS, onBeforeStep, type PhysicsWorld } from './world';

/** throttle −1..1 (negative = reverse / brake while rolling forward), steer −1..1 (positive = right). */
export type VehicleInput = {
  throttle: number; steer: number; brake: boolean;
  /** Helicopters only: −1 (sink) … 1 (climb); 0 or absent holds the height. */
  lift?: number;
};

/** Pose, velocities (linear, angular) and front-wheel steering angle: enough to replay the car from this instant. */
export type VehicleState = {
  x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number;
  vx: number; vy: number; vz: number; ax: number; ay: number; az: number; steer: number;
};

const T = TUNING.vehicle;
const KMH = 1 / 3.6;
/** Chassis centre height at rest (approx.: mount height + loaded suspension + wheel radius). */
export const VEHICLE_REST_Y = -T.wheelY + T.suspensionRest - 9.81 / (4 * T.suspensionStiffness) + T.wheelRadius;
/** Suspension length at rest (the ray length minus the wheel radius, loaded). */
export const SUSPENSION_REST_LENGTH = T.suspensionRest - 9.81 / (4 * T.suspensionStiffness);
/** Underside of the chassis collider above the ground (m). */
export const CHASSIS_CLEARANCE = 0.22;

/**
 * Chassis layout of a car type in the chassis frame (origin VEHICLE_REST_Y above the ground at the axle midpoint):
 * collider box centre and half sizes, wheel mount points. The mount height is chosen per wheel radius so every
 * type rests at the same VEHICLE_REST_Y.
 */
export function chassisLayout(spec: CarSpec): { centre: { x: number; y: number; z: number }; half: { x: number; y: number; z: number }; wheels: { x: number; y: number; z: number }[] } {
  const y = SUSPENSION_REST_LENGTH + spec.wheelRadius - VEHICLE_REST_Y;
  const x = spec.track / 2, z = spec.wheelbase / 2;
  return {
    centre: { x: 0, y: (CHASSIS_CLEARANCE + spec.height) / 2 - VEHICLE_REST_Y, z: spec.bodyZ },
    half: { x: spec.width / 2, y: (spec.height - CHASSIS_CLEARANCE) / 2, z: spec.length / 2 },
    // Rapier order (and wheel index): front right, front left, rear right, rear left (+x = left)
    wheels: [{ x: -x, y, z }, { x, y, z }, { x: -x, y, z: -z }, { x, y, z: -z }],
  };
}

/**
 * Car: a dynamic box on Rapier's DynamicRayCastVehicleController (4 ray-cast wheels).
 * The chassis' local +z is forward, so heading h faces (sin h, cos h) in x/z.
 * Unoccupied cars start asleep with the parking brake on; the vehicle controller only
 * runs while the chassis is awake, so ~300 parked cars cost almost nothing until hit.
 */
export class Vehicle {
  readonly chassis: RAPIER.RigidBody;
  private readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  private readonly unsubscribe: () => void;
  private occupied = false;
  private steerAngle = 0;
  readonly type: CarType;
  readonly spec: CarSpec;
  /** Engine and brake forces scale with the mass, so every type accelerates and stops alike. */
  private readonly force: number;

  /** pose.y is the ground height under the car (default 0); the chassis starts at y + VEHICLE_REST_Y. */
  constructor(private readonly pw: PhysicsWorld, pose: { x: number; z: number; heading: number; y?: number }, type: CarType = 'kleinwagen') {
    const { rapier: R, world } = pw;
    this.type = type;
    this.spec = CAR_SPECS[type];
    this.force = this.spec.mass / T.mass;
    const lay = chassisLayout(this.spec);
    const h = pose.heading;
    this.chassis = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, (pose.y ?? 0) + VEHICLE_REST_Y, pose.z)
        .setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) })
        .setLinearDamping(T.linearDamping)
        .setAngularDamping(T.angularDamping)
        .setCcdEnabled(true)
        .setSleeping(true),
    );
    const [hx, hy, hz] = [lay.half.x, lay.half.y, lay.half.z];
    const m = this.spec.mass;
    world.createCollider(
      R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(lay.centre.x, lay.centre.y, lay.centre.z).setMassProperties(
        m,
        // centre of mass over the axle midpoint at comY above the ground (collider-local)
        { x: 0, y: this.spec.comY - VEHICLE_REST_Y - lay.centre.y, z: -lay.centre.z },
        { x: (m / 3) * (hy * hy + hz * hz), y: (m / 3) * (hx * hx + hz * hz), z: (m / 3) * (hx * hx + hy * hy) },
        { x: 0, y: 0, z: 0, w: 1 },
      ).setCollisionGroups(CAR_GROUPS),
      this.chassis,
    );
    const tail = this.spec.fly?.tail;
    if (tail) {
      // the tail boom: weightless, so the mass properties above stay the whole helicopter's
      world.createCollider(
        R.ColliderDesc.cuboid(tail.halfX, tail.halfY, tail.halfZ).setTranslation(0, tail.y - VEHICLE_REST_Y, tail.z).setDensity(0)
          .setCollisionGroups(CAR_GROUPS),
        this.chassis,
      );
    }

    const c = world.createVehicleController(this.chassis);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const w of lay.wheels) {
      const i = c.numWheels();
      c.addWheel(w, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, T.suspensionRest, this.spec.wheelRadius);
      c.setWheelMaxSuspensionTravel(i, T.suspensionTravel);
      c.setWheelSuspensionStiffness(i, T.suspensionStiffness);
      c.setWheelSuspensionCompression(i, T.suspensionCompression);
      c.setWheelSuspensionRelaxation(i, T.suspensionRelaxation);
      c.setWheelMaxSuspensionForce(i, T.maxSuspensionForce);
      c.setWheelFrictionSlip(i, T.frictionSlip);
      c.setWheelSideFrictionStiffness(i, T.sideFrictionStiffness);
      c.setWheelBrake(i, T.parkingBrake * this.force);
    }
    this.ctrl = c;

    // Wheel rays get no filter predicate: Rapier excludes the chassis itself, and the rays hit everything else. A JS
    // predicate cannot work here in rapier.js 0.21: update_vehicle holds the collider set, so any Collider method called
    // from the predicate throws ("recursive use of an object"), and a throwing predicate counts as "hit it". That was
    // the old staticWorldFilter's fate (same results, bit for bit), at ~0.05 ms per thrown error, 8 per car and step.
    this.unsubscribe = onBeforeStep(pw, () => {
      // a kinematic chassis (a car the server streams, see CarPool.follow) is placed, not driven
      if (!this.chassis.isSleeping() && this.chassis.isDynamic()) c.updateVehicle(TUNING.world.dt);
    });
  }

  /** Driver input for one fixed step (TUNING.world.dt); call once per step before PhysicsWorld.step(). Ignored while unoccupied. */
  applyInput(i: VehicleInput): void {
    if (!this.occupied) return;
    if (this.spec.fly) return this.flyInput(i);
    const c = this.ctrl;
    const v = this.speed();
    const kmh = Math.abs(v) / KMH;
    const throttle = Math.max(-1, Math.min(1, i.throttle));

    // Speed-sensitive steering, eased towards the target angle.
    const k = Math.max(0, Math.min(1, (kmh - T.steerLowKmh) / (T.steerHighKmh - T.steerLowKmh)));
    const lock = T.steerLowLock + (T.steerHighLock - T.steerLowLock) * k;
    const target = -Math.max(-1, Math.min(1, i.steer)) * lock; // positive wheel angle turns left
    const maxDelta = T.steerRate * TUNING.world.dt;
    this.steerAngle += Math.max(-maxDelta, Math.min(maxDelta, target - this.steerAngle));

    // Throttle against the direction of travel brakes first; only near standstill does it change gear.
    let engine = 0;
    let brake = 0;
    if ((throttle > 0 && v < -1) || (throttle < 0 && v > 1)) {
      brake = T.brake * this.force;
    } else if (throttle !== 0) {
      const topKmh = throttle > 0 ? T.maxForwardKmh : T.maxReverseKmh;
      const limiter = Math.max(0, Math.min(1, (topKmh - kmh) / T.limiterBandKmh));
      engine = throttle * T.engineForce * this.force * limiter;
    } else if (!i.brake) {
      brake = T.coastBrake * this.force;
    }
    // The handbrake holds the rear wheels only: it stops the car far less than the brakes do, and locked rear tyres
    // lose their side grip, so at speed the tail swings out when steering (wheels 2 and 3 are the rear ones).
    const sliding = i.brake && Math.abs(v) > T.handbrakeSlideAbove;
    for (let w = 0; w < 4; w++) {
      const rear = w >= 2, held = rear && i.brake;
      c.setWheelEngineForce(w, held ? 0 : engine / 4);
      c.setWheelBrake(w, held ? Math.max(brake, T.handbrake * this.force) : brake);
      c.setWheelSteering(w, w < 2 ? this.steerAngle : 0);
      c.setWheelFrictionSlip(w, rear && sliding ? T.frictionSlip * T.handbrakeGrip : T.frictionSlip);
      c.setWheelSideFrictionStiffness(w, rear && sliding ? T.sideFrictionStiffness * T.handbrakeSideGrip : T.sideFrictionStiffness);
    }
    if (throttle !== 0 || i.steer !== 0 || i.brake) this.chassis.wakeUp();
  }

  /**
   * The helicopter's step. On its skids with no lift it just stands (gravity, braked). Otherwise it flies: gravity is
   * off and the velocity is steered directly – along the heading towards throttle × top speed (so it stops and hovers
   * when let go), up or down with `lift`, turning about the vertical with `steer`. The body is held level except for a
   * nose-down pitch with the forward speed and a bank into the turn. Everything derives from the body's state and
   * steerAngle (here the eased turn input, −1..1, positive = left), so a saved state replays exactly.
   */
  private flyInput(i: VehicleInput): void {
    const H = TUNING.heli, dt = TUNING.world.dt, b = this.chassis;
    const clamp = (x: number, lo = -1, hi = 1): number => Math.max(lo, Math.min(hi, x));
    const lift = clamp(i.lift ?? 0), throttle = clamp(i.throttle);
    if (this.wheelsInContact() >= 2 && lift <= 0) {
      b.setGravityScale(1, false);
      this.steerAngle = 0;
      return;
    }
    b.setGravityScale(0, true);

    const turn = -clamp(i.steer);
    this.steerAngle += clamp(turn - this.steerAngle, -H.yawEase * dt, H.yawEase * dt);

    const q = b.rotation(), p = b.translation(), v = b.linvel();
    const h = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const fx = Math.sin(h), fz = Math.cos(h);
    // horizontal: towards the wanted speed along the heading; whatever goes sideways is braked away
    const want = throttle * (throttle > 0 ? H.maxSpeed : H.maxReverse);
    const dx = fx * want - v.x, dz = fz * want - v.z, d = Math.hypot(dx, dz);
    const step = (throttle !== 0 ? H.accel : H.drag) * dt, k = d > step ? step / d : 1;
    // vertical: climb or sink, hold the height otherwise; no climbing above the ceiling
    let up = lift * (lift > 0 ? H.climb : H.sink);
    if (p.y >= H.ceiling) up = Math.min(up, 0);
    const vy = v.y + clamp(up - v.y, -H.liftAccel * dt, H.liftAccel * dt);
    b.setLinvel({ x: v.x + dx * k, y: vy, z: v.z + dz * k }, true);
    b.setAngvel({ x: 0, y: this.steerAngle * H.yawRate, z: 0 }, true);

    // attitude: yaw as it is, nose down with the forward speed, banked into the turn (more at speed)
    const along = clamp((v.x * fx + v.z * fz) / H.maxSpeed);
    const pitch = along * H.maxPitch, roll = -this.steerAngle * H.maxRoll * (0.25 + 0.75 * Math.abs(along));
    const sy = Math.sin(h / 2), cy = Math.cos(h / 2), sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2), sr = Math.sin(roll / 2), cr = Math.cos(roll / 2);
    // yaw(y) · pitch(x) · roll(z)
    const ax = cy * sp, ay = sy * cp, az = -sy * sp, aw = cy * cp;
    let tx = ax * cr + ay * sr, ty = ay * cr - ax * sr, tz = aw * sr + az * cr, tw = aw * cr - az * sr;
    if (tx * q.x + ty * q.y + tz * q.z + tw * q.w < 0) { tx = -tx; ty = -ty; tz = -tz; tw = -tw; }
    const e = 1 - Math.exp(-H.tiltRate * dt);
    const nx = q.x + (tx - q.x) * e, ny = q.y + (ty - q.y) * e, nz = q.z + (tz - q.z) * e, nw = q.w + (tw - q.w) * e;
    const n = Math.hypot(nx, ny, nz, nw);
    b.setRotation({ x: nx / n, y: ny / n, z: nz / n, w: nw / n }, true);
  }

  /** Chassis centre and orientation. */
  pose(): { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number } {
    const p = this.chassis.translation();
    const q = this.chassis.rotation();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  /** Current steering angle of the front wheels (rad, positive turns left). */
  steer(): number {
    return this.steerAngle;
  }

  saveState(): VehicleState {
    const p = this.chassis.translation(), q = this.chassis.rotation(), v = this.chassis.linvel(), a = this.chassis.angvel();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, vx: v.x, vy: v.y, vz: v.z, ax: a.x, ay: a.y, az: a.z, steer: this.steerAngle };
  }

  /** Puts the car back into a saved state and wakes it. */
  restoreState(s: VehicleState): void {
    const b = this.chassis;
    b.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
    b.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, true);
    b.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true);
    b.setAngvel({ x: s.ax, y: s.ay, z: s.az }, true);
    this.steerAngle = s.steer;
    if (!this.spec.fly) for (let w = 0; w < 2; w++) this.ctrl.setWheelSteering(w, s.steer);
    b.wakeUp();
  }

  /** Number of wheels whose ray currently touches something (0–4). */
  wheelsInContact(): number {
    let n = 0;
    for (let w = 0; w < 4; w++) if (this.ctrl.wheelIsInContact(w)) n++;
    return n;
  }

  /** Signed speed along the heading (m/s); negative when reversing. */
  speed(): number {
    return this.ctrl.currentVehicleSpeed();
  }

  /** Occupied: driver input is applied. Unoccupied: engine off, parking brake on, allowed to fall asleep. */
  setOccupied(on: boolean): void {
    this.occupied = on;
    if (on) {
      this.chassis.wakeUp();
      return;
    }
    this.steerAngle = 0;
    if (this.spec.fly) this.chassis.setGravityScale(1, true); // left in the air: it falls
    for (let w = 0; w < 4; w++) {
      this.ctrl.setWheelEngineForce(w, 0);
      this.ctrl.setWheelSteering(w, 0);
      this.ctrl.setWheelBrake(w, T.parkingBrake * this.force);
    }
  }

  /** Front wheel angle (rad, positive = left) and suspension length of wheel w (0 fr, 1 fl, 2 rr, 3 rl), for the view. */
  wheelSteering(w: number): number {
    return this.ctrl.wheelSteering(w) ?? 0;
  }

  wheelSuspension(w: number): number {
    return this.ctrl.wheelSuspensionLength(w) ?? SUSPENSION_REST_LENGTH;
  }

  /** Removes the car from the world. The instance must not be used afterwards. */
  dispose(): void {
    this.unsubscribe();
    this.pw.world.removeVehicleController(this.ctrl);
    this.pw.world.removeRigidBody(this.chassis);
  }
}
