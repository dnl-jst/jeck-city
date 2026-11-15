import { Quaternion, type PerspectiveCamera, type Scene } from 'three';
import { headingOf, staticWorldFilter, type CarPose, type PlayerInput, type SimEvent, type StationId, type WorldManifest } from '@nn/shared';
import type { GameAudio } from './audio/game-audio';
import { WheelControl, type WheelState } from './audio/wheel-control';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { DrivenCar, lampPower, ParkedCars } from './car';
import { PlayerFigure } from './player';
import { FollowCamera, FreeFly } from './camera';
import { MapMode, type DriveControls } from './map/map-mode';
import type { Session } from './session';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;

/** What the game needs from the page: scene and camera, input, HUD, the dev URL parameters and (optionally) sound. */
export type GameContext = {
  scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; debug: boolean; devCam: DevCam | null;
  audio?: GameAudio;
};

const STATIC_ONLY = staticWorldFilter();

/**
 * The playable game: renders the session's WorldSim (walking figure, cars, follow camera) and turns keyboard and
 * mouse into the local player's input. Sound, radio wheel, map, camera and glare live here; the simulation does not.
 */
export class Game {
  mode: 'walk' | 'drive' = 'walk';
  flying = false;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  readonly follow: FollowCamera;
  readonly fly: FreeFly;
  /** Hold R in the car: radio wheel (tap R = next station). */
  readonly wheel = new WheelControl();
  wheelState: WheelState = { open: false, highlighted: null };
  /** The M map: while open, steering input is neutral and mouse/wheel go to the map. */
  readonly map = new MapMode();
  /** Mouse movement and wheel notches for the big map this frame (zero while it is closed). */
  mapInput = { dx: 0, dy: 0, notches: 0 };
  /** Steering input of this frame after the map gate. */
  private ctl: DriveControls = { forward: 0, right: 0, brake: false, run: false };
  /** The car the player drives (null on foot). */
  private carId: number | null = null;
  /** Car the last sampled step had the player in (undefined before the first sample). */
  private sampledCar: number | null | undefined = undefined;
  /** Sim state before and after the last step, blended by session.alpha for rendering. */
  private prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  private currPos: Vec3 = { x: 0, y: 0, z: 0 };
  private prevPose: CarPose | null = null;
  private currPose: CarPose | null = null;
  /** On foot after the last step: velocity and ground contact (figure animation, footsteps). */
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private grounded = true;
  /** Seconds in the air on foot (for landing sounds). */
  private airTime = 0;
  /** Radio station last given to the sim for the own car (undefined: none yet in this car). */
  private sentRadio: StationId | null | undefined = undefined;
  /** Lamps knocked over since the last takeFallenLamps(). */
  private fallen: number[] = [];
  private readonly tramStops: WorldManifest['tramStops'];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(readonly session: Session, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam } = ctx;
    const { sim } = session;
    this.tramStops = m.tramStops;
    this.figure = new PlayerFigure(scene);
    this.driven = new DrivenCar(scene);
    this.fly = new FreeFly(camera, input);
    const heading = devCam ? devCam.yawDeg * DEG : m.spawn.heading;
    this.figure.heading = heading;
    this.cars = new ParkedCars(scene, sim.cars);
    this.follow = new FollowCamera(camera, sim.pw);
    this.follow.yaw = heading;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
    this.sample();
    session.onStep = () => this.sample();
  }

  /** Fixed steps run so far (tests wait on simulation time, not on the wall clock). */
  get steps(): number {
    return this.session.steps;
  }

  /** Engine of the own car ('off' on foot). */
  get engine(): 'off' | 'starting' | 'running' {
    return this.carId === null ? 'off' : this.session.sim.ignition(this.carId).state;
  }

  /** Where the player is: feet while walking, chassis centre while driving. */
  focus(): Vec3 {
    return this.mode === 'drive' && this.currPose ? this.currPose : this.currPos;
  }

  /** Ground speed (m/s) of the player or the car. */
  speed(): number {
    const v = this.carId !== null ? this.session.sim.cars.vehicle(this.carId) : null;
    if (v) return Math.abs(v.speed());
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Lamps knocked over since the last call (to switch their light off and tip the rendered post). */
  takeFallenLamps(): number[] {
    const out = this.fallen;
    this.fallen = [];
    return out;
  }

  /** One rendered frame: input, the session's fixed steps, poses for rendering. night 0..1 drives the car lights. */
  frame(dt: number, night: number): void {
    const { input, debug, audio } = this.ctx;
    const mouse = input.takeMouse();
    const notches = input.takeWheel();
    if (debug && input.consume('KeyF')) this.toggleFly();
    if (input.consume('KeyN')) audio?.toggleMute();
    if (!this.flying && input.consume('KeyM')) {
      this.map.toggle();
      if (this.map.open) this.closeWheel();
    }
    this.mapInput = this.map.open ? { dx: mouse.dx, dy: mouse.dy, notches } : { dx: 0, dy: 0, notches: 0 };
    if (this.map.takeClosed()) input.clearPresses();
    let use = false, jump = false;
    if (this.flying) {
      this.fly.turn(mouse.dx, mouse.dy);
      this.fly.update(dt);
    } else if (!this.map.open) {
      const rPressed = input.consume('KeyR'); // a press+release between two frames still counts as held once
      if (input.takeBlur()) this.closeWheel(); // window blur: the wheel is cancelled, not committed
      if (this.mode === 'drive' && this.engine !== 'running') this.closeWheel(); // R does nothing until the engine runs
      else if (this.mode === 'drive') {
        this.wheelState = this.wheel.update({ held: input.held('KeyR') || rPressed, dx: mouse.dx, dy: mouse.dy, dt, current: audio?.station ?? null });
        if (this.wheelState.tap) audio?.radioStep(1);
        if (this.wheelState.commit !== undefined) audio?.radioSelect(this.wheelState.commit);
      }
      // while the wheel is open the mouse points at a station instead of turning the camera
      if (!this.wheelState.open) this.follow.turn(mouse.dx, mouse.dy);
      if (input.consume('Space') && this.mode === 'walk') jump = true;
      if (input.consume('KeyE')) use = true;
      if (this.mode === 'drive') for (let i = 0; i < Math.abs(notches); i++) audio?.radioStep(notches > 0 ? 1 : -1);
    }
    const raw = this.flying ? { forward: 0, right: 0, brake: false, run: false } : { ...input.axes(), brake: input.brake(), run: input.run() };
    const ctl = this.ctl = this.map.gate(raw);
    const cmd: PlayerInput = { forward: ctl.forward, right: ctl.right, run: ctl.run, brake: ctl.brake, jump, use, yaw: this.follow.yaw };
    let radio: StationId | null | undefined;
    if (this.mode === 'drive' && audio && audio.station !== this.sentRadio) radio = this.sentRadio = audio.station;
    this.handle(this.session.frame(dt, cmd, radio));
    this.cars.update(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.render(dt, night);
  }

  /** After every fixed step: the player's position (or car pose) before and after it. */
  private sample(): void {
    const { sim, me } = this.session;
    const p = sim.player(me);
    const changed = p.carId !== this.sampledCar;
    if (p.carId !== null) {
      const pose = sim.cars.vehicle(p.carId)!.pose();
      this.prevPose = changed ? pose : this.currPose;
      this.currPose = pose;
    } else {
      this.prevPos = changed ? p.pos : this.currPos;
      this.currPos = p.pos;
      this.vel = p.vel;
      this.grounded = p.char.grounded;
    }
    this.sampledCar = p.carId;
  }

  /** The own player's sim events (getting in and out, ignition sounds, refusals) and knocked-over lamps. */
  private handle(events: SimEvent[]): void {
    const { hud, audio } = this.ctx;
    const me = this.session.me;
    for (const e of events) {
      if (e.t === 'lamp') this.fallen.push(e.i);
      else if (e.t === 'enter' && e.id === me) this.enteredCar(e.car);
      else if (e.t === 'exit' && e.id === me) this.leftCar(e.car);
      else if (e.t === 'exitDenied' && e.id === me) hud.flash(e.reason === 'speed' ? 'Erst anhalten' : 'Hier kannst du nicht aussteigen');
      else if (e.t === 'enterDenied' && e.id === me) hud.flash('Das Auto ist besetzt');
      else if (e.t === 'ignition' && e.car === this.carId) {
        if (e.e === 'doorClose') audio?.doorClosed();
        else if (e.e === 'crank') audio?.crank();
        else audio?.engineRunning();
      }
    }
  }

  private enteredCar(car: number): void {
    const pose = this.currPose ?? this.session.sim.cars.poses[car]!;
    this.carId = car;
    this.sentRadio = undefined;
    this.cars.setOwn(car);
    this.figure.visible = false;
    this.driven.setPose(pose);
    this.driven.show(this.session.sim.cars.colors[car]!);
    this.follow.setDriving(true, headingOf(pose));
    this.mode = 'drive';
    this.ctx.audio?.enterCar();
  }

  private leftCar(car: number): void {
    this.carId = null;
    this.currPose = this.prevPose = null;
    this.cars.setOwn(null);
    this.driven.hide();
    this.figure.heading = headingOf(this.session.sim.cars.poses[car]!);
    this.figure.visible = true;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.closeWheel();
    this.ctx.audio?.exitCar();
  }

  private render(dt: number, night: number): void {
    const { audio } = this.ctx;
    const a = this.session.alpha;
    if (this.mode === 'walk') {
      const p = lerp3(this.prevPos, this.currPos, a);
      const v = this.vel;
      this.figure.update(p.x, p.y, p.z, v, dt);
      if (!this.flying) this.follow.update(p, 0, dt);
      const grounded = this.grounded;
      if (!grounded) this.airTime += dt;
      audio?.walk({ speed: Math.hypot(v.x, v.z), grounded, airTime: this.airTime }, dt);
      if (grounded) this.airTime = 0;
    } else if (this.currPose && this.carId !== null) {
      const { sim } = this.session;
      const prev = this.prevPose ?? this.currPose;
      const pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      this.driven.setPose(pose);
      this.driven.setLights(night, sim.braking(this.carId), lampPower(sim.ignition(this.carId).lightLevel(), Math.random));
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt);
      this.driven.updateGlare(this.ctx.camera, this.occluded, dt);
      if (audio) {
        // velocity along / across the car's heading (forward = (sin h, cos h))
        const h = headingOf(pose), v = sim.cars.vehicle(this.carId)!.chassis.linvel();
        const s = Math.sin(h), c = Math.cos(h);
        audio.drive({
          forward: v.x * s + v.z * c, lateral: v.x * c - v.z * s, vx: v.x, vz: v.z,
          throttle: this.ctl.forward, handbrake: this.ctl.brake,
        }, dt);
      }
    }
    if (audio) {
      const f = this.focus();
      audio.listener(f.x, f.z, this.follow.yaw, nearestStop(this.tramStops, f.x, f.z), dt);
    }
  }

  /** Line of sight between two points blocked by static world geometry (lamp glare vs. camera). */
  private readonly occluded = (from: Vec3, to: Vec3): boolean => {
    const { rapier: R, world: w } = this.session.sim.pw;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return false;
    return w.castRay(new R.Ray(from, { x: dx / d, y: dy / d, z: dz / d }), d, true, undefined, undefined, undefined, undefined, STATIC_ONLY) !== null;
  };

  private toggleFly(): void {
    this.flying = !this.flying;
    this.ctx.input.clearPresses();
    this.closeWheel();
    if (this.flying) this.fly.setHeading(this.follow.yaw, this.follow.pitch);
    else this.follow.snap();
  }

  private closeWheel(): void {
    this.wheel.cancel(this.ctx.input.held('KeyR'));
    this.wheelState = { open: false, highlighted: this.wheelState.highlighted }; // keep the slot for the fade-out
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
