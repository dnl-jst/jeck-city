import { Quaternion, type Object3D, type PerspectiveCamera, type Scene } from 'three';
import {
  CHARACTER_VARIANTS, headingOf, staticWorldFilter, type BikeState, type BikeType, type CarPose, type CharacterVariant, type PlayerInput,
  type PlayerSnapshot, type SimEvent, type StationId, type WorldManifest,
} from '@nn/shared';
import { BikeRig, RIDER_POSTURE } from './bikes/rig';
import { BikeView } from './bikes/parked';
import { RIDE_HINT, SOUND_RIDE_HINT } from './hud';
import type { GameAudio } from './audio/game-audio';
import { WheelControl, type WheelState } from './audio/wheel-control';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { DrivenCar, lampPower, ParkedCars, type CarModels } from './car';
import { angleDelta, PlayerFigure } from './player';
import { storeCharacter, storedCharacter, type CharacterModels } from './characters';
import { FollowCamera, FreeFly } from './camera';
import { MapMode, type DriveControls } from './map/map-mode';
import type { Session } from './session';
import { RemotePlayers } from './remote/remote-players';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;

/** What the game needs from the page: scene and camera, input, HUD, the dev URL parameters and (optionally) sound. */
export type GameContext = {
  scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; debug: boolean; devCam: DevCam | null;
  audio?: GameAudio;
  /** Bike and rack model templates (WorldLoader.loadBikeModels); without them bikes still ride, just unseen. */
  bikeModels?: { bikes: ReadonlyMap<BikeType, Object3D>; racks: ReadonlyMap<0 | 1, Object3D> };
  /** Car model templates (WorldLoader.loadCarModels); without them cars still drive, just unseen. */
  carModels?: CarModels;
  /** Player character models (WorldLoader.characterModels) and the stored choice's template, if it loaded. */
  characters?: CharacterModels;
  character?: Object3D | null;
};


const STATIC_ONLY = staticWorldFilter();

/**
 * The playable game: renders the session's WorldSim (walking figure, cars, bikes, follow camera) and turns keyboard
 * and mouse into the local player's input. Sound, radio wheel, map, camera and glare live here; the simulation does not.
 */
export class Game {
  mode: 'walk' | 'drive' | 'ride' = 'walk';
  flying = false;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  /** Parked bikes and rack hoops (instanced; the sim's ParkedBikes), the rig of the ridden bike. */
  private readonly bikeView: BikeView | null = null;
  private readonly rigs = new Map<BikeType, BikeRig>();
  private rig: BikeRig | null = null;
  /** Player character shown (CHARACTER_VARIANTS); C switches to the next one that has a model. */
  character: CharacterVariant;
  readonly follow: FollowCamera;
  /** Other players (online only). */
  private readonly remotes: RemotePlayers | null;
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
  /** Vehicle the last sampled step had the player in ('w' on foot; undefined before the first sample). */
  private sampledKey: string | undefined = undefined;
  /** Sim state before and after the last step, blended by session.alpha for rendering. */
  private prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  private currPos: Vec3 = { x: 0, y: 0, z: 0 };
  private prevPose: CarPose | null = null;
  private currPose: CarPose | null = null;
  private prevBike: BikeState | null = null;
  private currBike: BikeState | null = null;
  /** On foot after the last step: velocity and ground contact (figure animation, footsteps). */
  private vel: Vec3 = { x: 0, y: 0, z: 0 };
  private grounded = true;
  /** Knocked down after the last step (the figure lies, input is ignored). */
  private down = false;
  /** Seconds in the air on foot (for landing sounds). */
  private airTime = 0;
  /** Radio station last given to the sim for the own car (undefined: none yet in this car). */
  private sentRadio: StationId | null | undefined = undefined;
  /** Lamps knocked over since the last takeFallenLamps(). */
  private fallen: number[] = [];
  private readonly tramStops: WorldManifest['tramStops'];
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  private readonly qc = new Quaternion();
  /** Other players' character templates by variant: loaded, being loaded, or failed (null). */
  private readonly figureTemplates = new Map<CharacterVariant, Object3D | null | 'loading'>();

  constructor(readonly session: Session, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam } = ctx;
    const { sim } = session;
    this.tramStops = m.tramStops;
    this.figure = new PlayerFigure(scene);
    this.character = storedCharacter();
    this.figure.setModel(ctx.character ?? null);
    this.driven = new DrivenCar(scene, ctx.carModels);
    this.fly = new FreeFly(camera, input);
    const heading = devCam ? devCam.yawDeg * DEG : m.spawn.heading;
    this.figure.heading = heading;
    this.cars = new ParkedCars(scene, sim.cars, ctx.carModels);
    if (ctx.bikeModels) this.bikeView = new BikeView(scene, ctx.bikeModels.bikes, ctx.bikeModels.racks, sim.bikes, m.bikeRacks, sim.racks.ys);
    this.follow = new FollowCamera(camera, sim.pw);
    this.follow.yaw = heading;
    this.remotes = session.remote ? new RemotePlayers(scene, this.cars, {
      me: session.me, colorOf: (i) => sim.cars.colors[i]!, typeOf: (i) => sim.cars.types[i]!, occluded: (a, b) => this.occluded(a, b),
      carModels: ctx.carModels, figureModel: ctx.character ?? null, figureFor: (v) => this.figureFor(v),
      bikeModels: ctx.bikeModels?.bikes, bikeTypeOf: (i) => sim.bikes.types[i]!, bikeColorOf: (i) => sim.bikes.colors[i]!,
    }) : null;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
    this.sample();
    session.onStep = () => this.sample();
    session.onCorrection = () => this.resample();
  }

  /** Fixed steps run so far (tests wait on simulation time, not on the wall clock). */
  get steps(): number {
    return this.session.steps;
  }

  /** Engine of the own car ('off' on foot). */
  get engine(): 'off' | 'starting' | 'running' {
    return this.carId === null ? 'off' : this.session.sim.ignition(this.carId).state;
  }

  /** Where the player is: feet while walking, chassis centre while driving, the ground under the bike while riding. */
  focus(): Vec3 {
    if (this.mode === 'ride' && this.currBike) return this.currBike;
    return this.mode === 'drive' && this.currPose ? this.currPose : this.currPos;
  }

  /** Type of the bike being ridden, else null. */
  bikeType(): BikeType | null {
    return this.session.sim.riddenBike(this.session.me)?.type ?? null;
  }

  /** Ground speed (m/s) of the player, the car or the bike. */
  speed(): number {
    const v = this.carId !== null ? this.session.sim.cars.vehicle(this.carId) : null;
    if (v) return Math.abs(v.speed());
    if (this.mode === 'ride' && this.currBike) return Math.abs(this.currBike.speed);
    return Math.hypot(this.vel.x, this.vel.z);
  }

  private switchCharacter(): void {
    const models = this.ctx.characters;
    const variants = models?.variants ?? [];
    if (!models || variants.length < 2) return;
    const next = variants[(variants.indexOf(this.character) + 1) % variants.length]!;
    this.character = next;
    storeCharacter(next);
    this.session.setVariant?.(CHARACTER_VARIANTS.indexOf(next));
    this.ctx.hud.flash(next === 'woman' ? 'Figur: Frau' : 'Figur: Mann');
    // the first switch to a figure downloads it; the old one stays until it is there
    models.load(next).then((model) => {
      if (this.character === next) this.figure.setModel(model); // unless switched on meanwhile
    }, (err: unknown) => {
      console.error(err);
      if (this.character === next) this.ctx.hud.flash('Figur konnte nicht geladen werden');
    });
  }

  /**
   * Another player's figure model for character variant v (index into CHARACTER_VARIANTS): the template once it is
   * loaded (the first request starts the download), until then (or without one) the own figure's.
   */
  private figureFor(v: number): Object3D | null {
    const models = this.ctx.characters, fallback = this.ctx.character ?? null;
    const name = CHARACTER_VARIANTS[v] ?? CHARACTER_VARIANTS[0];
    if (!models || !models.variants.includes(name)) return fallback;
    const got = this.figureTemplates.get(name);
    if (got === undefined) {
      this.figureTemplates.set(name, 'loading');
      models.load(name).then((m) => { this.figureTemplates.set(name, m); }, (err: unknown) => {
        console.error(err);
        this.figureTemplates.set(name, null);
      });
    }
    return got && got !== 'loading' ? got : fallback;
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
    if (input.consume('KeyC')) this.switchCharacter();
    if (!this.flying && input.consume('KeyM')) {
      this.map.toggle();
      if (this.map.open) this.closeWheel();
    }
    this.mapInput = this.map.open ? { dx: mouse.dx, dy: mouse.dy, notches } : { dx: 0, dy: 0, notches: 0 };
    if (this.map.takeClosed()) input.clearPresses();
    let use = false, jump = false, honk = false, bell = false;
    if (this.flying) {
      this.fly.turn(mouse.dx, mouse.dy);
      this.fly.update(dt);
    } else if (!this.map.open) {
      const rPressed = input.consume('KeyR'); // a press+release between two frames still counts as held once
      if (input.takeBlur()) this.closeWheel(); // window blur: the wheel is cancelled, not committed
      if (this.mode === 'drive' && this.engine !== 'running') this.closeWheel(); // R does nothing until the engine runs
      else if (this.radioOn) {
        this.wheelState = this.wheel.update({ held: input.held('KeyR') || rPressed, dx: mouse.dx, dy: mouse.dy, dt, current: audio?.station ?? null });
        if (this.wheelState.tap) audio?.radioStep(1);
        if (this.wheelState.commit !== undefined) audio?.radioSelect(this.wheelState.commit);
      }
      // while the wheel is open the mouse points at a station instead of turning the camera
      if (!this.wheelState.open) this.follow.turn(mouse.dx, mouse.dy);
      const busy = this.figure.busy; // fallen off: no control until up again
      // Space: jump on foot, hop on the bike
      if (input.consume('Space') && !busy && this.mode !== 'drive') jump = true;
      const hPressed = input.consume('KeyH'); // a tap between two frames still honks
      if (hPressed && this.mode === 'ride') {
        audio?.bell();
        bell = true;
      }
      if (input.consume('KeyL') && this.mode === 'ride' && this.rig?.hasDisco) {
        this.rig.setDisco(!this.rig.discoOn);
        this.ctx.hud.flash(this.rig.discoOn ? 'Diskokugel an' : 'Diskokugel aus');
      }
      honk = this.mode === 'drive' && (hPressed || input.held('KeyH'));
      if (input.consume('KeyE') && !busy) use = true;
      if (this.radioOn) for (let i = 0; i < Math.abs(notches); i++) audio?.radioStep(notches > 0 ? 1 : -1);
    }
    audio?.horn(honk, dt);
    const still = this.flying || this.figure.busy;
    const raw = still ? { forward: 0, right: 0, brake: false, run: false } : { ...input.axes(), brake: input.brake(), run: input.run() };
    const ctl = this.ctl = this.map.gate(raw);
    const cmd: PlayerInput = { forward: ctl.forward, right: ctl.right, run: ctl.run, brake: ctl.brake, jump, use, yaw: this.follow.yaw, horn: honk, bell };
    let radio: StationId | null | undefined;
    if (this.mode === 'drive' && audio && audio.station !== this.sentRadio) radio = this.sentRadio = audio.station;
    this.handle(this.session.frame(dt, cmd, radio));
    this.cars.update(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.bikeView?.update(this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.render(dt, night);
  }

  /** After every fixed step: the player's position (or car pose, or bike state) before and after it. */
  private sample(): void {
    const { sim, me } = this.session;
    const p = sim.player(me);
    const key = vehicleKey(p);
    const changed = key !== this.sampledKey;
    if (p.carId !== null) {
      const pose = sim.cars.vehicle(p.carId)!.pose();
      this.prevPose = changed ? pose : this.currPose;
      this.currPose = pose;
    } else if (p.bike) {
      this.prevBike = changed ? p.bike : this.currBike;
      this.currBike = p.bike;
    } else {
      this.prevPos = changed ? p.pos : this.currPos;
      this.currPos = p.pos;
      this.vel = p.vel;
      this.grounded = p.char.grounded;
      this.down = p.mode === 'down';
    }
    this.sampledKey = key;
  }

  /**
   * After a server correction (between steps): the last step's samples move along with the corrected state, so the
   * blend between them stays smooth; the session's render offset hides the jump itself. Getting in or out: a fresh sample.
   */
  private resample(): void {
    const { sim, me } = this.session;
    const p = sim.player(me);
    if (vehicleKey(p) !== this.sampledKey) {
      this.sample();
      return;
    }
    if (p.bike) {
      if (!this.currBike || !this.prevBike) {
        this.sample();
        return;
      }
      const now = p.bike, was = this.currBike, prev = this.prevBike;
      this.prevBike = {
        ...prev, x: prev.x + now.x - was.x, y: prev.y + now.y - was.y, z: prev.z + now.z - was.z, heading: prev.heading + angleDelta(was.heading, now.heading),
      };
      this.currBike = now;
      return;
    }
    if (p.carId !== null && this.currPose && this.prevPose) {
      const now = sim.cars.vehicle(p.carId)!.pose(), was = this.currPose, prev = this.prevPose;
      // rotation the correction applied: now · was⁻¹, applied to the previous sample as well
      const d = this.qa.set(now.qx, now.qy, now.qz, now.qw).multiply(this.qb.set(was.qx, was.qy, was.qz, was.qw).invert());
      const q = d.multiply(this.qc.set(prev.qx, prev.qy, prev.qz, prev.qw));
      this.prevPose = { x: prev.x + now.x - was.x, y: prev.y + now.y - was.y, z: prev.z + now.z - was.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
      this.currPose = now;
    } else if (p.carId === null) {
      const was = this.currPos;
      this.prevPos = { x: this.prevPos.x + p.pos.x - was.x, y: this.prevPos.y + p.pos.y - was.y, z: this.prevPos.z + p.pos.z - was.z };
      this.currPos = p.pos;
      this.vel = p.vel;
      this.grounded = p.char.grounded;
      this.down = p.mode === 'down';
    }
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
      else if (e.t === 'mountDenied' && e.id === me) hud.flash('Das Fahrrad ist besetzt');
      else if (e.t === 'mount' && e.id === me) this.mountedBike(e.bike);
      else if (e.t === 'dismount' && e.id === me) this.leftBike(e.heading, e.crash);
      else if (e.t === 'dismountDenied' && e.id === me) hud.flash('Hier kannst du nicht absteigen');
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
    this.driven.show(this.session.sim.cars.types[car]!, this.session.sim.cars.colors[car]!);
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

  private mountedBike(id: number): void {
    const { sim, me } = this.session;
    const ridden = sim.riddenBike(me)!;
    const s = this.currBike ?? ridden.state();
    this.rig = this.rigFor(ridden.type);
    if (this.rig) {
      this.rig.setColor(sim.bikes.colors[id]!);
      this.rig.snapLean();
      this.ctx.scene.add(this.rig.root);
      this.rig.leanGroup.add(this.figure.group);
    }
    this.follow.setDriving(true, s.heading, 'bike');
    this.mode = 'ride';
    this.ctx.hud.setHint(ridden.type === 'soundjohn' ? SOUND_RIDE_HINT : RIDE_HINT);
    this.ctx.audio?.mountBike(ridden.type === 'soundjohn');
  }

  /** Off the bike (heading: the bike's): stepped off, or crashed and fell. */
  private leftBike(heading: number, crash: boolean): void {
    this.currBike = this.prevBike = null;
    if (this.rig) {
      this.ctx.scene.remove(this.rig.root);
      this.rig.setLights(0);
      this.rig.setDisco(false);
    }
    this.rig = null;
    this.ctx.scene.add(this.figure.group);
    this.figure.heading = heading;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.closeWheel();
    this.ctx.hud.setHint('');
    this.ctx.audio?.dismountBike();
    if (crash) {
      this.figure.fall(heading);
      this.ctx.audio?.crashBike();
    }
  }

  /** One rig (a clone of the model) per bike type, made on first use. */
  private rigFor(type: BikeType): BikeRig | null {
    let rig = this.rigs.get(type);
    const model = this.ctx.bikeModels?.bikes.get(type);
    if (!rig && model) {
      rig = new BikeRig(model.clone(true), type);
      this.rigs.set(type, rig);
    }
    return rig ?? null;
  }

  private render(dt: number, night: number): void {
    const { audio } = this.ctx;
    const a = this.session.alpha;
    const off = this.session.renderOffset();
    if (this.mode === 'walk') {
      const p = lerp3(this.prevPos, this.currPos, a);
      p.x += off.x; p.y += off.y; p.z += off.z;
      const v = this.vel;
      this.figure.setDown(this.down ? 1 : 0);
      this.figure.update(p.x, p.y, p.z, v, dt);
      if (!this.flying) this.follow.update(p, 0, dt);
      const grounded = this.grounded;
      if (!grounded) this.airTime += dt;
      audio?.walk({ speed: Math.hypot(v.x, v.z), grounded, airTime: this.airTime }, dt);
      if (grounded) this.airTime = 0;
    } else if (this.mode === 'ride' && this.currBike) {
      const prev = this.prevBike ?? this.currBike, cur = this.currBike;
      const s: BikeState = { ...cur, ...lerp3(prev, cur, a), heading: prev.heading + angleDelta(prev.heading, cur.heading) * a };
      // server correction still fading out (online)
      s.x += off.x; s.y += off.y; s.z += off.z;
      const rig = this.rig;
      if (rig) {
        rig.update(s, this.session.sim.riddenBike(this.session.me)?.lean() ?? 0, dt);
        rig.setLights(night);
        this.figure.ride(rig.localPoint('seat'), [rig.localPoint('grip_l'), rig.localPoint('grip_r')],
          [rig.localPoint('pedal_l'), rig.localPoint('pedal_r')], RIDER_POSTURE[rig.type]);
      }
      if (!this.flying) this.follow.update(s, s.heading, dt);
      audio?.ride({ speed: Math.abs(s.speed), pedalling: this.ctl.forward > 0 && s.speed > 0.3, grounded: s.grounded }, dt);
    } else if (this.currPose && this.carId !== null) {
      const { sim } = this.session;
      const prev = this.prevPose ?? this.currPose;
      const pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      // server correction still fading out: offset on top (rotation first)
      pose.x += off.x; pose.y += off.y; pose.z += off.z;
      if (off.qw !== 1) {
        const q = this.qc.set(off.qx, off.qy, off.qz, off.qw).multiply(this.qa.set(pose.qx, pose.qy, pose.qz, pose.qw));
        pose.qx = q.x; pose.qy = q.y; pose.qz = q.z; pose.qw = q.w;
      }
      this.driven.setPose(pose);
      this.driven.setWheels(sim.cars.vehicle(this.carId)!, dt);
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
    if (this.remotes) {
      const { walkers, cars, riders } = this.session.remote!();
      const { names, variants, cars: info } = this.session.roster!();
      this.remotes.update({ walkers, cars, riders }, names, info, this.ctx.camera, night, dt, variants);

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

  /** The radio can be tuned: in a car with the engine running, or on the sound Long John. */
  private get radioOn(): boolean {
    return (this.mode === 'drive' && this.engine === 'running') || (this.mode === 'ride' && this.bikeType() === 'soundjohn');
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

/** Which vehicle a player state is in: 'c<car>', 'b<bike>' or 'w' (on foot). */
function vehicleKey(p: PlayerSnapshot): string {
  if (p.carId !== null) return `c${p.carId}`;
  return p.bikeId !== null ? `b${p.bikeId}` : 'w';
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}
