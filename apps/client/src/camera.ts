import { Euler, Vector3, type PerspectiveCamera } from 'three';
import { staticWorldFilter, VEHICLE_REST_Y, type PhysicsWorld } from '@nn/shared';
import type { Input } from './input';
import { angleDelta } from './player';

/** Third-person offsets (m): behind and above the feet on foot; behind and above the road in the car. */
export const CAMERA_WALK = { back: 5, up: 2.3, pivot: 1.5 };
/** Vertical field of view (degrees). */
export const CAMERA_FOV = 60;
export const CAMERA_DRIVE = { back: 7, up: 2.5, pivot: 1.7 };
/** On a bike: closer and lower than on foot; target y is the ground under the wheels. */
export const CAMERA_RIDE = { back: 4.2, up: 1.9, pivot: 1.3 };
const MOUSE = 0.0025;
const PITCH_MIN = -1.1, PITCH_MAX = 0.55;
/** Speed (m/s) where the speed effects start (15 km/h) and where the field of view is fully widened (30 km/h). */
const SPEED_FX_START = 15 / 3.6, SPEED_FOV_FULL = 30 / 3.6;
/** Speed (m/s) where the shake reaches full strength (40 km/h). */
const SPEED_SHAKE_FULL = 40 / 3.6;
/** Extra field of view at full speed (degrees): 60° → 69°. */
export const FOV_SPEED_EXTRA = 9;
/** Extra camera distance at full speed (m). */
const BACK_SPEED_EXTRA = 0.5;
/** Time constant (s) the field of view / distance follow the speed with. */
const SPEED_FX_TAU = 0.3;
/** Shake at full strength: offset (m) and roll (rad). Bike and scooter shake more than the car, walking not at all. */
const SHAKE = { bike: { m: 0.03, roll: 0.004 }, car: { m: 0.018, roll: 0.0025 } };
/** Closest the camera may get to the pivot when a wall is in the way (m). */
const MIN_DIST = 0.9;
/** The camera only collides with the static city (not cars, not the player). */
const STATIC_ONLY = staticWorldFilter();

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** 0 below 15 km/h, eased up to 1 at 30 km/h: how far the speed-dependent widening (FOV, distance) has gone. */
export function speedWiden(speed: number): number {
  return smooth01((Math.abs(speed) - SPEED_FX_START) / (SPEED_FOV_FULL - SPEED_FX_START));
}

/** Vertical field of view (degrees) for a speed (m/s): 60° up to 15 km/h, eased to 69° at 30 km/h and above. */
export function speedFov(speed: number): number {
  return CAMERA_FOV + FOV_SPEED_EXTRA * speedWiden(speed);
}

export type ShakeKind = 'walk' | 'bike' | 'car';

/** Shake strength 0..1 for a speed (m/s): nothing on foot or below 15 km/h, rising to 1 at 40 km/h. */
export function shakeAmount(speed: number, kind: ShakeKind): number {
  if (kind === 'walk') return 0;
  return smooth01((Math.abs(speed) - SPEED_FX_START) / (SPEED_SHAKE_FULL - SPEED_FX_START));
}

/**
 * Screen-space camera shake at time t (s) for a strength 0..1: sideways / vertical offset (m, camera-local)
 * and roll (rad). Overlaid sines at unrelated frequencies, so it is smooth and never repeats visibly.
 */
export function shakeOffset(t: number, amount: number, kind: ShakeKind): { x: number; y: number; roll: number } {
  if (amount <= 0 || kind === 'walk') return { x: 0, y: 0, roll: 0 };
  const a = SHAKE[kind];
  const n = (f1: number, f2: number, f3: number, p: number) =>
    (Math.sin(t * f1 + p) * 0.5 + Math.sin(t * f2 + p * 1.7) * 0.3 + Math.sin(t * f3 + p * 2.3) * 0.2);
  return {
    x: a.m * amount * n(7.1, 13.3, 23.9, 0.4),
    y: a.m * amount * n(9.7, 17.9, 29.3, 1.9),
    roll: a.roll * amount * n(5.3, 11.1, 19.7, 3.1),
  };
}

/**
 * Third-person follow camera. yaw uses the heading convention (looks along (sin yaw, cos yaw));
 * pitch < 0 looks down. The camera orbits a pivot above the target and is pulled in front of walls
 * found by a ray cast against the physics world (dynamic and kinematic bodies are ignored).
 */
export class FollowCamera {
  yaw = 0;
  pitch = -0.12;
  private readonly pivot = new Vector3();
  private placed = false;
  private dist: number = CAMERA_WALK.back;
  /** In the car: smoothed car heading the camera trails, plus a mouse offset that drifts back to 0. */
  private carYaw = 0;
  private lookOffset = 0;
  private idle = 0;
  private driving = false;
  /** While driving: a car (target = chassis centre) or a bike (target = ground under the wheels). */
  private vehicle: 'car' | 'bike' = 'car';
  private readonly look = new Vector3();
  /** Smoothed speed widening (0..1) and shake strength, and the shake clock. */
  private widen = 0;
  private shake = 0;
  private shakeT = 0;

  constructor(private readonly cam: PerspectiveCamera, private readonly pw: PhysicsWorld) {}

  /** Mouse look (px). */
  turn(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.driving) {
      this.lookOffset -= dx * MOUSE;
      this.idle = 0;
    } else this.yaw -= dx * MOUSE;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch - dy * MOUSE));
  }

  /** Switches between walk and drive framing (car or bike); getting in starts behind the vehicle. */
  setDriving(on: boolean, carHeading = 0, vehicle: 'car' | 'bike' = 'car'): void {
    this.vehicle = vehicle;
    if (on && !this.driving) {
      this.carYaw = carHeading;
      this.lookOffset = angleDelta(carHeading, this.yaw);
    }
    this.driving = on;
  }

  /** Puts the camera right behind the target without smoothing (spawn, teleports). */
  snap(): void {
    this.placed = false;
  }

  /** Back to the resting field of view (leaving for the free-fly camera). */
  resetFov(): void {
    this.widen = 0;
    this.shake = 0;
    this.setFov(CAMERA_FOV);
  }

  private setFov(fov: number): void {
    if (Math.abs(this.cam.fov - fov) < 1e-4) return;
    this.cam.fov = fov;
    this.cam.updateProjectionMatrix();
  }

  /**
   * target = feet (walking), chassis centre (car) or ground under the wheels (bike), with the vehicle heading.
   * speed (m/s) widens the view, pulls the camera back a little and (on wheels) shakes it slightly.
   */
  update(target: { x: number; y: number; z: number }, carHeading: number, dt: number, speed = 0): void {
    const bike = this.driving && this.vehicle === 'bike';
    const base = bike ? CAMERA_RIDE : this.driving ? CAMERA_DRIVE : CAMERA_WALK;
    const kind: ShakeKind = bike ? 'bike' : this.driving ? 'car' : 'walk';
    const kfx = 1 - Math.exp(-dt / SPEED_FX_TAU);
    this.widen += (speedWiden(speed) - this.widen) * kfx;
    this.shake += (shakeAmount(speed, kind) - this.shake) * kfx;
    this.shakeT += dt;
    this.setFov(CAMERA_FOV + FOV_SPEED_EXTRA * this.widen);
    const o = { ...base, back: base.back + BACK_SPEED_EXTRA * this.widen };
    const groundY = this.driving && !bike ? target.y - VEHICLE_REST_Y : target.y;
    if (this.driving) {
      this.carYaw += angleDelta(this.carYaw, carHeading) * Math.min(1, dt * 3);
      this.idle += dt;
      if (this.idle > 1.5) this.lookOffset *= Math.exp(-dt * 1.5);
      this.yaw = this.carYaw + this.lookOffset;
    }
    const want = { x: target.x, y: groundY + o.pivot, z: target.z };
    if (!this.placed) {
      this.pivot.set(want.x, want.y, want.z);
      this.dist = o.back;
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-dt * (this.driving ? 10 : 16));
      this.pivot.x += (want.x - this.pivot.x) * k;
      this.pivot.y += (want.y - this.pivot.y) * k;
      this.pivot.z += (want.z - this.pivot.z) * k;
    }
    // orbit: back along the view direction, lifted so that at pitch 0 the camera is o.up above the ground
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw) * cp, fy = sp, fz = Math.cos(this.yaw) * cp;
    const lift = o.up - o.pivot;
    const bx = -fx * o.back, by = -fy * o.back + lift, bz = -fz * o.back;
    const len = Math.hypot(bx, by, bz);
    const allowed = this.clearDistance(this.pivot, bx / len, by / len, bz / len, len);
    if (allowed < this.dist) this.dist = allowed;
    else this.dist += (allowed - this.dist) * Math.min(1, dt * 3);
    const s = this.dist / len;
    this.cam.position.set(this.pivot.x + bx * s, this.pivot.y + by * s, this.pivot.z + bz * s);
    this.look.set(this.cam.position.x + fx, this.cam.position.y + fy, this.cam.position.z + fz);
    this.cam.lookAt(this.look);
    // shake: only the rendered view moves (after the wall check; pivot and target stay put)
    if (this.shake > 1e-3) {
      const sh = shakeOffset(this.shakeT, this.shake, kind);
      this.cam.translateX(sh.x);
      this.cam.translateY(sh.y);
      this.cam.rotateZ(sh.roll);
    }
  }

  /** How far the camera may sit from p along (dx, dy, dz) before hitting static geometry (≤ max). */
  private clearDistance(p: Vector3, dx: number, dy: number, dz: number, max: number): number {
    const { rapier: R, world } = this.pw;
    const hit = world.castRay(new R.Ray({ x: p.x, y: p.y, z: p.z }, { x: dx, y: dy, z: dz }), max + 0.3, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
    return hit ? Math.max(MIN_DIST, Math.min(max, hit.timeOfImpact - 0.3)) : max;
  }
}

/** Dev free-fly camera (`?debug=1`, toggled with F): WASD, mouse look, Q/E down/up, Shift fast. */
export class FreeFly {
  /** three.js yaw (camera looks along −z at 0). */
  yaw = 0;
  pitch = 0;

  constructor(private readonly cam: PerspectiveCamera, private readonly input: Input) {}

  /** Points the camera along a manifest heading h (forward = (sin h, cos h) in x/z). */
  setHeading(h: number, pitch = 0): void {
    // camera looks along -Z at yaw 0; rotating by yaw gives forward (-sin yaw, -cos yaw)
    this.yaw = h + Math.PI;
    this.pitch = pitch;
  }

  /** Heading (manifest convention) the camera looks along. */
  get heading(): number {
    return this.yaw - Math.PI;
  }

  turn(dx: number, dy: number): void {
    this.yaw -= dx * MOUSE;
    this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch - dy * MOUSE));
  }

  update(dt: number): void {
    this.cam.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const k = (c: string) => (this.input.held(c) ? 1 : 0);
    const a = this.input.axes();
    const speed = (this.input.run() ? 40 : 6) * dt;
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.cam.quaternion);
    const right = new Vector3(1, 0, 0).applyQuaternion(this.cam.quaternion);
    this.cam.position.addScaledVector(fwd, a.forward * speed).addScaledVector(right, a.right * speed);
    this.cam.position.y += (k('KeyE') - k('KeyQ')) * speed;
  }
}
