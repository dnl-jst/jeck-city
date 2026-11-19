import { Quaternion, Vector3, type Object3D, type PerspectiveCamera, type Scene } from 'three';
import { WATER_TIME } from './materials/street';
import {
  BIKE_SPECS, bikeGroundPose, CHARACTER_VARIANTS, headingOf, headingPose, KNOCKDOWN_S, staticWorldFilter, TUNING, type BikeState, type BikeType, type CarPose, type CharacterVariant, type PlayerInput,
  type PlayerSnapshot, type SimEvent, type SnapshotCar, type StationId, type WorldManifest,
  plateText, boardingPath, CAR_SEATS, CAR_SPECS, DRIVER_SEAT, fromCarPoint, standPoint, toCarPoint, VEHICLE_REST_Y, type CarPoint,
} from '@nn/shared';
import { enterStage, leaveStage } from './boarding';
import { poseOccupant, shutDoors } from './occupant';
import { BikeLights, BikeRig, RIDER_POSTURE } from './bikes/rig';
import { BikeView } from './bikes/parked';
import { DRIVE_HINT, PASSENGER_HINT, RIDE_HINT, SCOOTER_RIDE_HINT, SOUND_RIDE_HINT } from './hud';
import type { GameAudio } from './audio/game-audio';
import { WheelControl, type WheelState } from './audio/wheel-control';
import type { DevCam } from './devparams';
import type { Hud } from './hud';
import type { Input } from './input';
import { DrivenCar, lampPower, ParkedCars, setMirrorNight, type CarModels } from './car';
import { sitOnBench, TransitView } from './transit';

/** The camera's target is this much lower for someone sitting on a bench (m): the cushion they are on, and sitting instead of standing. */
const SIT_DROP = 0.95;
import { angleDelta, PlayerFigure } from './player';
import { storeCharacter, storedCharacter, type CharacterModels } from './characters';
import { FollowCamera, FreeFly } from './camera';
import { MapMode, type DriveControls } from './map/map-mode';
import type { Session } from './session';
import { RemotePlayers, streamedWheels } from './remote/remote-players';
import { RemoteCarFeed } from './audio/remote-audio';
import { CRASH_SPIN, KNOCK_SPIN, RagdollWorld, ragSpin } from './ragdoll';
import type { Quality } from './quality';

type Vec3 = { x: number; y: number; z: number };
const DEG = Math.PI / 180;

/** What the game needs from the page: scene and camera, input, HUD, the dev URL parameters and (optionally) sound. */
export type GameContext = {
  scene: Scene; camera: PerspectiveCamera; input: Input; hud: Hud; /** F toggles free-fly. */ flyAllowed: boolean; devCam: DevCam | null;
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
 * and mouse into the local player's input. Sound, radio wheel, map and camera live here; the simulation does not.
 */
export class Game {
  /** 'sit': riding along in a car as a passenger. */
  mode: 'walk' | 'drive' | 'ride' | 'sit' = 'walk';
  flying = false;
  readonly figure: PlayerFigure;
  readonly cars: ParkedCars;
  readonly driven: DrivenCar;
  /** Parked bikes and rack hoops (instanced; the sim's ParkedBikes), the rig of the ridden bike. */
  private readonly bikeView: BikeView | null = null;
  private readonly rigs = new Map<BikeType, BikeRig>();
  private rig: BikeRig | null = null;
  /** The ridden bike's spotlights: always in the scene (constant light count), lent to the rig while riding. */
  private readonly bikeLights: BikeLights;
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
  /**
   * Getting into the driven car (walking to the door, the door, sitting down) or out of the car just left; null
   * otherwise. While it runs the player's controls rest.
   */
  private boarding: { kind: 'in'; car: number; seat: number; path: CarPoint[]; t: number } | { kind: 'out'; car: number; seat: number; t: number } | null = null;
  /** The car and seat ridden along in as a passenger (mode 'sit'), else null. */
  private pass: { car: number; seat: number } | null = null;
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
  /** The way the body faces after the last step (the sim's; others see the same). */
  private facing = 0;
  /** Knocked down after the last step (the figure lies, input is ignored). */
  private down = false;
  /** Knocked down at the last rendered frame (the ragdoll starts on the change). */
  private wasDown = false;
  /** The own car's or bike's pose as drawn this frame (while driving or riding; others on it are drawn on it). */
  private drawnPose: CarPose | null = null;
  /** Tumbling figures (own and other players') fall in a physics world of their own. */
  readonly ragdolls: RagdollWorld;
  /** Seconds in the air on foot (for landing sounds). */
  private airTime = 0;
  /** Radio station last given to the sim for the own car (undefined: none yet in this car). */
  private sentRadio: StationId | null | undefined = undefined;
  /** Lamps knocked over since the last takeFallenLamps(). */
  private fallen: number[] = [];
  private readonly tramStops: WorldManifest['tramStops'];
  /** The stop last announced to the player in a train (station index; −1 the end of the line, −2 none yet). */
  private announced = -2;
  /** 0..1: sitting on a bench in a train (eased; lowers the camera). */
  private sitDrop = 0;
  /** 0..1: how far the player is underground (set by the frame loop; fades the city's sounds, see GameAudio.transit). */
  underground = 0;
  /** The underground trains (null in a world without them). */
  private readonly transit: TransitView | null;
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();
  private readonly qc = new Quaternion();
  /** Other players' character templates by variant: loaded, being loaded, or failed (null). */
  private readonly figureTemplates = new Map<CharacterVariant, Object3D | null | 'loading'>();
  /** Remote cars for the sound (accel estimated from their speed). */
  private readonly carFeed = new RemoteCarFeed();

  constructor(readonly session: Session, m: WorldManifest, private readonly ctx: GameContext) {
    const { scene, camera, input, devCam } = ctx;
    const { sim } = session;
    this.tramStops = m.tramStops;
    this.figure = new PlayerFigure(scene);
    this.ragdolls = new RagdollWorld(sim.pw);
    this.character = storedCharacter();
    this.figure.setModel(ctx.character ?? null);
    this.driven = new DrivenCar(scene, ctx.carModels);
    this.bikeLights = new BikeLights(scene);
    this.fly = new FreeFly(camera, input);
    const heading = devCam ? devCam.yawDeg * DEG : m.spawn.heading;
    this.figure.heading = heading;
    this.cars = new ParkedCars(scene, sim.cars, ctx.carModels);
    this.transit = m.transit ? new TransitView(scene, m.transit, ctx.characters, sim.trains?.model) : null;
    if (ctx.bikeModels) this.bikeView = new BikeView(scene, ctx.bikeModels.bikes, ctx.bikeModels.racks, sim.bikes, m.bikeRacks, sim.racks.ys);
    this.follow = new FollowCamera(camera, sim.pw);
    this.follow.yaw = heading;
    this.remotes = session.remote ? new RemotePlayers(scene, this.cars, {
      me: session.me, colorOf: (i) => sim.cars.colors[i]!, typeOf: (i) => sim.cars.types[i]!,
      carModels: ctx.carModels, figureModel: ctx.character ?? null, figureFor: (v) => this.figureFor(v),
      bikeModels: ctx.bikeModels?.bikes, bikeTypeOf: (i) => sim.bikes.types[i]!, bikeColorOf: (i) => sim.bikes.colors[i]!,
      // other riders have no physics bike here: their wheels are probed against the static city and terrain
      bikeGroundPose: (type, s) => bikeGroundPose(sim.pw, BIKE_SPECS[type].wheelbase, s, STATIC_ONLY),
      ragdolls: this.ragdolls,
      aboard: (x, y, z) => this.transit?.aboard(x, y, z, this.session.remoteTick ?? this.session.sim.transitTick) ?? null,
      // (also the car still being got out of: the game keeps drawing it, with its door, until the figure is out)
      localCar: () => (this.mode !== 'walk' && this.drawnPose ? { id: this.carId ?? this.pass?.car ?? -1, pose: this.drawnPose }
        : this.boarding?.kind === 'out' ? { id: this.boarding.car, pose: this.leavingPose(this.boarding.car) } : null),
      ownCarView: () => this.driven,
      carPose: (i) => sim.cars.poses[i],
      onOwnRoof: (slot) => session.onOwnRoof?.(slot) ?? null,
    }) : null;
    if (devCam) this.follow.pitch = devCam.pitchDeg * DEG;
    this.sample();
    session.onStep = () => this.sample();
    session.onCorrection = () => this.resample();
  }

  /** The own car's and bike's lights and the parked cars' draw radius at a quality level. */
  setQuality(q: Quality): void {
    this.driven.setQuality(q);
    this.bikeLights.setDiscoDots(q.discoDots);
    this.cars.setRadius(q.carRadius);
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
    return (this.mode === 'drive' || this.mode === 'sit') && this.currPose ? this.currPose : this.currPos;
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
    this.ctx.hud.flash(`Figur ${CHARACTER_VARIANTS.indexOf(next) + 1}`);
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

  /** Key hint for the current mode: car, bike, sound Long John, or none on foot. */
  get modeHint(): string {
    if (this.mode === 'drive') return DRIVE_HINT;
    if (this.mode === 'sit') return PASSENGER_HINT;
    if (this.mode === 'ride') {
      const t = this.bikeType();
      return t === 'soundjohn' ? SOUND_RIDE_HINT : t === 'escooter' ? SCOOTER_RIDE_HINT : RIDE_HINT;
    }
    return '';
  }

  /** One rendered frame: input, the session's fixed steps, poses for rendering. night 0..1 drives the car lights. */
  frame(dt: number, night: number): void {
    const { input, flyAllowed, audio } = this.ctx;
    const mouse = input.takeMouse();
    const notches = input.takeWheel();
    if (flyAllowed && input.consume('KeyF')) this.toggleFly();
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
      if (input.consume('Space') && !busy && this.mode !== 'drive' && this.mode !== 'sit') jump = true;
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
      if (input.consume('KeyE') && !busy && !this.boarding) use = true;
      if (this.radioOn) for (let i = 0; i < Math.abs(notches); i++) audio?.radioStep(notches > 0 ? 1 : -1);
    }
    audio?.horn(honk, dt);
    const still = this.flying || this.figure.busy || this.boarding !== null; // getting in or out: the controls rest
    const raw = still ? { forward: 0, right: 0, brake: false, run: false } : { ...input.axes(), brake: input.brake(), run: input.run() };
    const ctl = this.ctl = this.map.gate(raw);
    const cmd: PlayerInput = { forward: ctl.forward, right: ctl.right, run: ctl.run, brake: ctl.brake, jump, use, yaw: this.follow.yaw, horn: honk, bell };
    // online, a server correction can put the ignition straight to 'running' without the event: the state counts too
    if (this.mode === 'drive' && this.engine === 'running') audio?.engineRunning();
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
    if (p.carId !== null || p.pass) {
      // (a passenger's car: its physics stand-in where it has one, else where it rests)
      const id = p.carId ?? p.pass!.car;
      const pose = sim.cars.vehicle(id)?.pose() ?? sim.cars.poses[id]!;
      this.prevPose = changed ? pose : this.currPose;
      this.currPose = pose;
    } else if (p.bike) {
      this.prevBike = changed ? p.bike : this.currBike;
      this.currBike = p.bike;
    } else {
      this.prevPos = changed ? p.pos : this.currPos;
      this.currPos = p.pos;
      this.vel = p.vel;
      this.facing = p.facing;
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
    const inCar = p.carId ?? p.pass?.car ?? null;
    if (inCar !== null && this.currPose && this.prevPose) {
      const now = sim.cars.vehicle(inCar)?.pose() ?? sim.cars.poses[inCar]!, was = this.currPose, prev = this.prevPose;
      // rotation the correction applied: now · was⁻¹, applied to the previous sample as well
      const d = this.qa.set(now.qx, now.qy, now.qz, now.qw).multiply(this.qb.set(was.qx, was.qy, was.qz, was.qw).invert());
      const q = d.multiply(this.qc.set(prev.qx, prev.qy, prev.qz, prev.qw));
      this.prevPose = { x: prev.x + now.x - was.x, y: prev.y + now.y - was.y, z: prev.z + now.z - was.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
      this.currPose = now;
    } else if (inCar === null) {
      const was = this.currPos;
      this.prevPos = { x: this.prevPos.x + p.pos.x - was.x, y: this.prevPos.y + p.pos.y - was.y, z: this.prevPos.z + p.pos.z - was.z };
      this.currPos = p.pos;
      this.vel = p.vel;
      this.facing = p.facing;
      this.grounded = p.char.grounded;
      this.down = p.mode === 'down';
    }
  }

  /** The own player's sim events (getting in and out, ignition sounds, refusals) and knocked-over lamps. */
  private handle(events: SimEvent[]): void {
    const { hud, audio } = this.ctx;
    const me = this.session.me;
    // a car knocked the own player off the bike: the dismount comes with a knock in the same batch
    const hitByCar = events.some((e) => e.t === 'knock' && e.id === me);
    for (const e of events) {
      if (e.t === 'lamp') this.fallen.push(e.i);
      else if (e.t === 'bell') { if (e.id !== me) audio?.bellAt(e.x, e.z); }
      else if (e.t === 'impact') audio?.impactAt(e.x, e.z, e.strength);
      else if (e.t === 'knock') this.knockSound(e.id);
      else if (e.t === 'enter' && e.id === me) this.enteredCar(e.car, e.seat);
      else if (e.t === 'exit' && e.id === me) this.leftCar(e.car, e.seat);
      else if (e.t === 'exitDenied' && e.id === me) hud.flash(e.reason === 'speed' ? 'Erst anhalten' : 'Hier kannst du nicht aussteigen');
      else if (e.t === 'enterDenied' && e.id === me) hud.flash('Das Auto ist besetzt');
      else if (e.t === 'mountDenied' && e.id === me) hud.flash('Das Fahrrad ist besetzt');
      else if (e.t === 'mount' && e.id === me) this.mountedBike(e.bike);
      else if (e.t === 'dismount' && e.id === me) this.leftBike(e.heading, e.crash, hitByCar);
      else if (e.t === 'dismountDenied' && e.id === me) hud.flash('Hier kannst du nicht absteigen');
      else if (e.t === 'ignition' && e.car === this.carId) {
        if (e.e === 'doorClose') audio?.doorClosed();
        else if (e.e === 'crank') audio?.crank();
        else audio?.engineRunning();
      }
    }
  }

  /** The sound of a person knocked down, where they are (the own player, or a remote walker or rider). */
  private knockSound(id: number): void {
    const audio = this.ctx.audio;
    if (!audio) return;
    if (id === this.session.me) {
      const f = this.focus();
      audio.knockAt(f.x, f.z);
      return;
    }
    const r = this.session.remote?.();
    const at = r?.walkers.get(`p${id}`) ?? r?.riders.get(`r${id}`);
    if (at) audio.knockAt(at.x, at.z);
  }

  /** Got into car `car` on `seat` (0: driving it). */
  private enteredCar(car: number, seat: number): void {
    const pose = this.currPose ?? this.session.sim.cars.poses[car]!;
    if (this.boarding?.kind === 'out') this.finishLeave(); // straight into the next car
    const driver = seat === DRIVER_SEAT;
    this.carId = driver ? car : null;
    this.pass = driver ? null : { car, seat };
    this.sentRadio = undefined;
    this.cars.setOwn(car);
    this.driven.setPose(pose);
    const type = this.session.sim.cars.types[car]!;
    this.driven.show(type, this.session.sim.cars.colors[car]!, plateText(car));
    // the figure walks to its door from where it stands, gets in and shuts the door
    const at = this.figure.group.position;
    const from = toCarPoint({ x: pose.x, z: pose.z, heading: headingOf(pose) }, at.x, at.z);
    this.boarding = { kind: 'in', car, seat, path: boardingPath(CAR_SPECS[type], CAR_SEATS[type], seat, from), t: 0 };
    this.follow.setDriving(true, headingOf(pose));
    this.mode = driver ? 'drive' : 'sit';
    this.ctx.hud.setHint(this.modeHint);
    if (driver) this.ctx.audio?.enterCar();
  }

  private leftCar(car: number, seat: number): void {
    const wasIn = this.boarding?.kind === 'in';
    const wasDriver = this.carId !== null;
    this.carId = null;
    this.pass = null;
    this.currPose = this.prevPose = null;
    this.figure.heading = headingOf(this.session.sim.cars.poses[car]!);
    this.figure.visible = true;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.closeWheel();
    this.ctx.hud.setHint('');
    if (wasDriver) this.ctx.audio?.exitCar();
    else this.ctx.audio?.leaveRide();
    if (wasIn) {
      // not in yet (a server correction took the seat away): no getting-out to show
      this.boarding = { kind: 'out', car, seat, t: Infinity };
      this.finishLeave();
    } else {
      this.boarding = { kind: 'out', car, seat, t: 0 }; // the car stays drawn with its door until the figure is out
    }
  }

  /** Car `id` as the server streams it, sampled for this frame; null offline or while it rests (not in the snapshots). */
  private streamedCar(id: number): SnapshotCar | null {
    for (const c of this.session.remote?.().cars.values() ?? []) if (c.id === id) return c;
    return null;
  }

  /** Where the car just left is now (somebody else may still sit in it, and drive on). */
  private leavingPose(car: number): CarPose {
    const { cars } = this.session.sim;
    return cars.vehicle(car)?.pose() ?? cars.poses[car]!;
  }

  /** Getting out is over (or cut short): the car goes back to the parked ones, the figure walks again. */
  private finishLeave(): void {
    const b = this.boarding;
    if (b?.kind !== 'out') return;
    shutDoors(this.driven, this.session.sim.cars.types[b.car]!);
    this.ctx.scene.add(this.figure.group);
    this.boarding = null;
    if (this.carId === null && !this.pass) {
      this.cars.setOwn(null);
      this.driven.hide();
    }
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
      this.rig.attachLights(this.bikeLights);
      this.rig.leanGroup.add(this.figure.group);
    }
    this.follow.setDriving(true, s.heading, 'bike');
    this.mode = 'ride';
    this.ctx.hud.setHint(this.modeHint);
    this.ctx.audio?.mountBike(ridden.type === 'soundjohn');
  }

  /** Off the bike (heading: the bike's): stepped off, or crashed (into something, or hit by a car) and fell. */
  private leftBike(heading: number, crash: boolean, hitByCar = false): void {
    this.currBike = this.prevBike = null;
    if (this.rig) {
      this.rig.detachLights();
      this.ctx.scene.remove(this.rig.root);
    }
    this.rig = null;
    if (!crash) this.ctx.scene.add(this.figure.group); // (crashing: the ragdoll takes it off the rig itself)
    this.figure.heading = heading;
    this.follow.setDriving(false);
    this.mode = 'walk';
    this.airTime = 0;
    this.closeWheel();
    this.ctx.hud.setHint('');
    this.ctx.audio?.dismountBike();
    if (crash) {
      // from the riding pose, thrown as the sim throws the player (WorldSim.crash): over the handlebar with the bike's
      // speed, or with the car's push and half of its own
      const v = this.knockVelocity();
      this.figure.ragdoll(this.ragdolls, v, ragSpin(v, hitByCar ? KNOCK_SPIN : CRASH_SPIN), TUNING.bike.getUpSeconds);
      this.ctx.audio?.crashBike();
    }
  }

  /** The velocity the sim knocked the own player down with (the character's knock velocity). */
  private knockVelocity(): Vec3 {
    const c = this.session.sim.player(this.session.me).char;
    return { x: c.vx, y: Math.max(0, c.vy), z: c.vz };
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
    setMirrorNight(night);
    const { audio } = this.ctx;
    const a = this.session.alpha;
    const off = this.session.renderOffset();
    WATER_TIME.value = (WATER_TIME.value + dt) % 3600;
    // the trains between the last two steps, as the own figure
    this.transit?.update(this.session.sim.transitTick - 1 + a, this.ctx.camera.position.x, this.ctx.camera.position.z);
    this.ragdolls.step(dt);
    if (this.mode === 'walk') {
      // hit by a car: limp from the walking pose, thrown with the car's push
      if (this.down && !this.wasDown && !this.figure.busy) {
        const v = this.knockVelocity();
        this.figure.ragdoll(this.ragdolls, v, ragSpin(v, KNOCK_SPIN), KNOCKDOWN_S);
      }
      this.wasDown = this.down;
      const p = lerp3(this.prevPos, this.currPos, a);
      p.x += off.x; p.y += off.y; p.z += off.z;
      const v = this.vel;
      this.figure.setDown(this.down ? 1 : 0);
      const out = this.boarding?.kind === 'out' ? this.boarding : null;
      if (out) {
        // still getting out of the car just left: it stands where it is, its door open
        out.t += dt;
        const st = leaveStage(out.t), at = this.leavingPose(out.car);
        this.driven.setPose(at);
        poseOccupant(this.figure, this.ctx.scene, this.driven, this.session.sim.cars.types[out.car]!, out.seat, at, st, dt);
        if (st.done) this.finishLeave();
      } else {
        const seat = this.transit?.seated(p.x, p.y, p.z);
        if (seat) sitOnBench(this.figure, seat);
        else this.figure.update(p.x, p.y, p.z, v, dt, !this.grounded, this.facing);
      }
      // sitting on a bench: the feet are on its cushion and the head is lower than standing; the camera eases down with it
      const sit = this.transit?.seated(p.x, p.y, p.z) ? 1 : 0;
      this.sitDrop += (sit - this.sitDrop) * Math.min(1, dt * 6);
      if (!this.flying) this.follow.update(this.sitDrop > 0.001 ? { x: p.x, y: p.y - SIT_DROP * this.sitDrop, z: p.z } : p, 0, dt, Math.hypot(this.vel.x, this.vel.z));
      const grounded = this.grounded;
      if (!grounded) this.airTime += dt;
      audio?.walk({ speed: Math.hypot(v.x, v.z), grounded, airTime: this.airTime }, dt);
      if (grounded) this.airTime = 0;
    } else if (this.mode === 'ride' && this.currBike) {
      const prev = this.prevBike ?? this.currBike, cur = this.currBike;
      const s: BikeState = { ...cur, ...lerp3(prev, cur, a), heading: prev.heading + angleDelta(prev.heading, cur.heading) * a };
      // server correction still fading out (online)
      s.x += off.x; s.y += off.y; s.z += off.z;
      this.drawnPose = headingPose(s);
      const rig = this.rig;
      if (rig) {
        const ridden = this.session.sim.riddenBike(this.session.me);
        rig.update(s, ridden?.lean() ?? 0, dt, ridden?.groundPose(s));
        rig.setLights(night);
        this.figure.ride(rig.localPoint('seat'), [rig.localPoint('grip_l'), rig.localPoint('grip_r')],
          [rig.localPoint('pedal_l'), rig.localPoint('pedal_r')], RIDER_POSTURE[rig.type]);
      }
      if (!this.flying) this.follow.update(s, s.heading, dt, Math.abs(s.speed));
      // a scooter has no freewheel: never ticks
      audio?.ride({ speed: Math.abs(s.speed), pedalling: (this.ctl.forward > 0 && s.speed > 0.3) || BIKE_SPECS[this.rig?.type ?? 'dutch'].motor === true, grounded: s.grounded }, dt);
    } else if (this.currPose && (this.carId !== null || this.pass)) {
      const { sim } = this.session;
      const car = this.carId ?? this.pass!.car, seat = this.pass?.seat ?? DRIVER_SEAT;
      const prev = this.prevPose ?? this.currPose;
      let pose = { ...lerp3(prev, this.currPose, a), ...slerpQ(this.qa, this.qb, prev, this.currPose, a) };
      // riding along, the car is somebody else's: drawn straight from the server's stream as sampled for this frame
      // (as every other player's car is). Its stand-in in the own simulation only follows that stream step by step –
      // blending between those steps on top makes it stutter.
      const streamed = this.pass ? this.streamedCar(car) : null;
      if (streamed) {
        pose = { x: streamed.x, y: streamed.y, z: streamed.z, qx: streamed.qx, qy: streamed.qy, qz: streamed.qz, qw: streamed.qw };
      } else {
        // server correction still fading out: offset on top (rotation first)
        pose.x += off.x; pose.y += off.y; pose.z += off.z;
        if (off.qw !== 1) {
          const q = this.qc.set(off.qx, off.qy, off.qz, off.qw).multiply(this.qa.set(pose.qx, pose.qy, pose.qz, pose.qw));
          pose.qx = q.x; pose.qy = q.y; pose.qz = q.z; pose.qw = q.w;
        }
      }
      this.driven.setPose(pose);
      this.drawnPose = pose;
      const vehicle = sim.cars.vehicle(car);
      if (streamed) this.driven.setWheels(streamedWheels(streamed), dt);
      else if (vehicle) this.driven.setWheels(vehicle, dt);
      const into = this.boarding?.kind === 'in' ? this.boarding : null;
      if (into) into.t += dt;
      const st = into ? enterStage(into.path, into.t) : null;
      poseOccupant(this.figure, this.ctx.scene, this.driven, sim.cars.types[car]!, seat, pose, st, dt);
      if (st?.done) this.boarding = null;
      // the lamps: the own ignition when driving; riding along, what the server says about the car
      const level = this.carId !== null ? sim.ignition(car).lightLevel() : this.session.roster?.().cars.get(car)?.level ?? 0;
      // (the brake lights of somebody else's car come with the stream, as for every other car)
      this.driven.setLights(night, streamed ? streamed.brakeLight : sim.braking(car), lampPower(level, Math.random));
      const v = streamed ? { x: streamed.vx, y: streamed.vy, z: streamed.vz } : vehicle?.chassis.linvel() ?? { x: 0, y: 0, z: 0 };
      if (!this.flying) this.follow.update(pose, headingOf(pose), dt, Math.hypot(v.x, v.z));
      // riding along: the car's radio, as the driver hears it
      if (this.pass) audio?.rideAlong(this.session.roster?.().cars.get(car)?.radio ?? null);
      if (audio && this.carId !== null) {
        // velocity along / across the car's heading (forward = (sin h, cos h))
        const h = headingOf(pose);
        const s = Math.sin(h), c = Math.cos(h);
        audio.drive({
          forward: v.x * s + v.z * c, lateral: v.x * c - v.z * s, vx: v.x, vz: v.z,
          throttle: this.ctl.forward, handbrake: this.ctl.brake,
        }, dt);
      }
    }
    if (this.remotes) {
      const { walkers, cars, riders } = this.session.remote!();
      const { names, variants, cars: info, seats } = this.session.roster!();
      this.remotes.update({ walkers, cars, riders }, names, info, this.ctx.camera, night, dt, variants, seats);
      audio?.remoteCars(this.focus(), this.carFeed.build(cars, info, this.session.me, dt, this.pass?.car ?? null), dt);

    }
    if (audio) {
      const f = this.focus();
      const train = this.transit?.nearest(f.x, f.y, f.z) ?? null;
      audio.transit(this.underground, train);
      // riding: about half way to the next stop, it is announced
      if (train?.inside && this.transit) {
        if (train.speed > 1.5 && train.way >= 0.5 && train.next !== this.announced) {
          this.announced = train.next;
          audio.announceStop(train.next < 0 ? null : this.transit.stationName(train.next));
        }
      } else this.announced = -2;
      for (const e of this.transit?.takeDoorEvents() ?? []) audio.trainDoors(e.opening, e.x, e.z);
      audio.listener(f.x, f.z, this.follow.yaw, nearestStop(this.tramStops, f.x, f.z), dt);
    }
  }

  private toggleFly(): void {
    this.flying = !this.flying;
    this.ctx.input.clearPresses();
    this.closeWheel();
    if (this.flying) {
      this.fly.setHeading(this.follow.yaw, this.follow.pitch);
      this.follow.resetFov();
    }
    else this.follow.snap();
  }

  /** The radio can be tuned: in a car with the engine running, or on the sound Long John. */
  get radioOn(): boolean {
    return (this.mode === 'drive' && this.engine === 'running') || (this.mode === 'ride' && this.bikeType() === 'soundjohn');
  }

  /** On the sound Long John with its disco ball (L). */
  get discoAvailable(): boolean {
    return this.mode === 'ride' && this.rig?.hasDisco === true;
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
  if (p.pass) return `s${p.pass.car}:${p.pass.seat}`;
  return p.bikeId !== null ? `b${p.bikeId}` : 'w';
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function slerpQ(qa: Quaternion, qb: Quaternion, a: CarPose, b: CarPose, t: number): { qx: number; qy: number; qz: number; qw: number } {
  qa.set(a.qx, a.qy, a.qz, a.qw).slerp(qb.set(b.qx, b.qy, b.qz, b.qw), t);
  return { qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w };
}
