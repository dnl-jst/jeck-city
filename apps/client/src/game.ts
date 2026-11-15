import { Quaternion, type PerspectiveCamera, type Scene } from 'three';
import {
  Character, FixedStepper, staticWorldFilter, TUNING, VEHICLE_REST_Y, type PhysicsWorld, type Vehicle, type WorldManifest,
} from '@nn/shared';
import type { GameAudio } from './audio/game-audio';
import { WheelControl, type WheelState } from './audio/wheel-control';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { canGetOut, DrivenCar, exitSpot, headingOf, nearestEnterableCar, ParkedCars, type CarPose } from './car';
import { PlayerFigure } from './player';
import { FollowCamera, FreeFly } from './camera';
import { Ignition } from './ignition';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;
const DT = TUNING.world.dt;

/** What the game needs from the page: scene and camera, input, HUD, the dev URL parameters and (optionally) sound. */
export type GameContext = {
  scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; debug: boolean; devCam: DevCam | null; audio?: GameAudio;
};

const STATIC_ONLY = staticWorldFilter();

/** Height of the first static surface below (x, fromY, z), or null. */
export function surfaceY(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), fromY + 5, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
  return hit ? fromY - hit.timeOfImpact : null;
}

/** The playable game: walking figure, cars, follow camera; built once world and physics are ready. */
export class Game {
  mode: 'walk' | 'drive' = 'walk';
  flying = false;
  readonly char: Character;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  readonly follow: FollowCamera;
  readonly fly: FreeFly;
  /** Door, starter, engine: throttle, radio and lights wait for it. */
  readonly ignition = new Ignition();
  /** Hold R in the car: radio wheel (tap R = next station). */
  readonly wheel = new WheelControl();
  wheelState: WheelState = { open: false, highlighted: null };
  private readonly stepper = new FixedStepper(DT, 5);
  private vehicle: Vehicle | null = null;
  private carColor = 0;
  /** Physics state before and after the last step, blended by stepper.alpha for rendering. */
  private prevPos: Vec3;
  private currPos: Vec3;
  private prevPose: CarPose | null = null;
  private currPose: CarPose | null = null;
  private proximityAge = Infinity;
  /** Space pressed on foot: jump in the next fixed step. */
  private jumpPending = false;
  /** Seconds in the air on foot (for landing sounds). */
  private airTime = 0;
  private readonly tramStops: WorldManifest['tramStops'];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(readonly pw: PhysicsWorld, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam } = ctx;
    this.tramStops = m.tramStops;
    this.figure = new PlayerFigure(scene);
    this.driven = new DrivenCar(scene);
    this.fly = new FreeFly(camera, input);
    const spawn = devCam ? { x: devCam.x, z: devCam.z, heading: devCam.yawDeg * DEG } : m.spawn;
    const y = surfaceY(pw, spawn.x, spawn.z, 3) ?? 0;
    this.char = new Character(pw, { x: spawn.x, y: y + 0.02, z: spawn.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = spawn.heading;
    this.cars = new ParkedCars(scene, pw, m.parked);
    this.follow = new FollowCamera(camera, pw);
    this.follow.yaw = spawn.heading;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
  }

  /** Where the player is: feet while walking, chassis centre while driving. */
  focus(): Vec3 {
    return this.mode === 'drive' && this.currPose ? this.currPose : this.currPos;
  }

  /** Ground speed (m/s) of the player or the car. */
  speed(): number {
    if (this.vehicle) return Math.abs(this.vehicle.speed());
    const v = this.char.velocity();
    return Math.hypot(v.x, v.z);
  }

  /** One rendered frame: input, fixed physics steps, poses for rendering. night 0..1 drives the car lights. */
  frame(dt: number, night: number): void {
    const { input, debug, audio } = this.ctx;
    const mouse = input.takeMouse();
    const notches = input.takeWheel();
    if (debug && input.consume('KeyF')) this.toggleFly();
    if (input.consume('KeyN')) audio?.toggleMute();
    if (this.flying) {
      this.fly.turn(mouse.dx, mouse.dy);
      this.fly.update(dt);
    } else {
      input.consume('KeyR'); // the wheel reads the held key; a stale press must not act later
      if (this.mode === 'drive') {
        this.wheelState = this.wheel.update({ held: input.held('KeyR'), dx: mouse.dx, dy: mouse.dy, dt, current: audio?.station ?? null });
        if (this.wheelState.tap) audio?.radioStep(1);
        if (this.wheelState.commit !== undefined) audio?.radioSelect(this.wheelState.commit);
      }
      // while the wheel is open the mouse points at a station instead of turning the camera
      if (!this.wheelState.open) this.follow.turn(mouse.dx, mouse.dy);
      if (input.consume('Space') && this.mode === 'walk') this.jumpPending = true;
      if (input.consume('KeyE')) {
        if (this.mode === 'walk') this.getIn();
        else this.getOut();
      }
      if (this.mode === 'drive') for (let i = 0; i < Math.abs(notches); i++) audio?.radioStep(notches > 0 ? 1 : -1);
    }
    const steer = this.flying ? { forward: 0, right: 0 } : input.axes();
    for (const e of this.ignition.update(dt)) {
      if (e === 'doorClose') audio?.doorClosed();
      else if (e === 'crank') audio?.crank();
      else audio?.engineRunning();
    }
    const throttle = this.ignition.state === 'running' ? steer.forward : 0;
    this.stepper.advance(dt, () => {
      if (this.mode === 'walk') {
        this.char.applyInput({ forward: steer.forward, right: steer.right, run: input.run() && !this.flying, yaw: this.follow.yaw, jump: this.jumpPending });
        this.jumpPending = false;
      } else {
        this.vehicle!.applyInput({ throttle, steer: steer.right, brake: input.brake() && !this.flying });
      }
      this.pw.step();
      this.prevPos = this.currPos;
      this.currPos = this.char.position();
      if (this.vehicle) {
        this.prevPose = this.currPose;
        this.currPose = this.vehicle.pose();
      }
    });
    this.cars.sync();
    this.proximityAge += dt;
    if (this.proximityAge > 0.5) {
      this.proximityAge = 0;
      const f = this.focus();
      this.cars.updateProximity(f.x, f.z);
    }
    this.render(dt, night);
  }

  private render(dt: number, night: number): void {
    const { input, audio } = this.ctx;
    const a = this.stepper.alpha;
    if (this.mode === 'walk') {
      const p = lerp3(this.prevPos, this.currPos, a);
      const v = this.char.velocity();
      this.figure.update(p.x, p.y, p.z, v, dt);
      if (!this.flying) this.follow.update(p, 0, dt);
      const grounded = this.char.isGrounded();
      if (!grounded) this.airTime += dt;
      audio?.walk({ speed: Math.hypot(v.x, v.z), grounded, airTime: this.airTime }, dt);
      if (grounded) this.airTime = 0;
    } else if (this.currPose) {
      const prev = this.prevPose ?? this.currPose;
      const pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      this.driven.setPose(pose);
      const braking = input.brake() || (input.axes().forward < 0 && this.vehicle!.speed() > 1);
      this.driven.setLights(night, braking && !this.flying, this.ignition.lightPower(Math.random));
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt);
      if (audio) {
        // velocity along / across the car's heading (forward = (sin h, cos h))
        const h = headingOf(pose), v = this.vehicle!.chassis.linvel();
        const s = Math.sin(h), c = Math.cos(h);
        audio.drive({
          forward: v.x * s + v.z * c, lateral: v.x * c - v.z * s, vx: v.x, vz: v.z,
          throttle: this.flying ? 0 : input.axes().forward, handbrake: input.brake() && !this.flying,
        }, dt);
      }
    }
    if (audio) {
      const f = this.focus();
      audio.listener(f.x, f.z, this.follow.yaw, nearestStop(this.tramStops, f.x, f.z), dt);
    }
  }

  private toggleFly(): void {
    this.flying = !this.flying;
    this.ctx.input.clearPresses();
    this.closeWheel();
    if (this.flying) this.fly.setHeading(this.follow.yaw, this.follow.pitch);
    else this.follow.snap();
  }

  private getIn(): void {
    const id = nearestEnterableCar(this.currPos, this.cars.candidates());
    if (id === null) return;
    this.vehicle = this.cars.enter(id);
    this.jumpPending = false;
    this.carColor = this.cars.colors[id]!;
    this.currPose = this.prevPose = this.vehicle.pose();
    this.char.setEnabled(false);
    this.figure.visible = false;
    this.driven.setPose(this.currPose);
    this.driven.show(this.carColor);
    this.follow.setDriving(true, headingOf(this.currPose));
    this.mode = 'drive';
    this.ignition.start();
    this.ctx.audio?.enterCar();
  }

  private getOut(): void {
    if (!canGetOut(this.vehicle!.speed())) {
      this.ctx.hud.flash('Erst anhalten');
      return;
    }
    const pose = this.vehicle!.pose();
    const heading = headingOf(pose);
    const spot = exitSpot({ x: pose.x, z: pose.z, heading }, (x, z) => this.exitFree(pose, x, z));
    if (!spot) {
      this.ctx.hud.flash('Hier kannst du nicht aussteigen');
      return;
    }
    this.cars.exit();
    this.vehicle = null;
    this.currPose = this.prevPose = null;
    this.driven.hide();
    this.char.setEnabled(true);
    this.char.teleport({ x: spot.x, y: (surfaceY(this.pw, spot.x, spot.z, pose.y + 1) ?? 0) + 0.02, z: spot.z });
    this.prevPos = this.currPos = this.char.position();
    this.figure.heading = heading;
    this.figure.visible = true;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.ignition.stop();
    this.closeWheel();
    this.ctx.audio?.exitCar();
  }

  private closeWheel(): void {
    this.wheel.cancel();
    this.wheelState = { open: false, highlighted: null };
  }

  /**
   * Exit spot test: nothing static or dynamic between the car's centre and the spot (ray at 1 m, so no
   * stepping out through a wall into a building), and a standing capsule at the spot touches nothing.
   */
  private exitFree(car: CarPose, x: number, z: number): boolean {
    const { rapier: R, world: w } = this.pw;
    const chassis = this.vehicle!.chassis;
    const solid = staticWorldFilter(true, chassis); // city and other cars, not this car or the player
    const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz);
    const y = car.y + 0.1;
    const reach = d + TUNING.character.radius;
    if (w.castRay(new R.Ray({ x: car.x, y, z: car.z }, { x: dx / d, y: 0, z: dz / d }), reach, true, undefined, undefined, undefined, undefined, solid)) return false;
    const T = TUNING.character;
    const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
    // bottom 0.3 m above the road: clears kerbs, touches walls, posts and other cars
    const centre = { x, y: car.y - VEHICLE_REST_Y + 0.3 + T.height / 2, z };
    return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, solid) === null;
  }
}

/** The tram stop closest to (x, z) and its distance, or null if there is none. */
function nearestStop(stops: WorldManifest['tramStops'], x: number, z: number): { x: number; z: number; dist: number } | null {
  let best: { x: number; z: number; dist: number } | null = null;
  for (const st of stops) {
    const dist = Math.hypot(st.x - x, st.z - z);
    if (!best || dist < best.dist) best = { x: st.x, z: st.z, dist };
  }
  return best;
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}
