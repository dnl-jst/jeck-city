import { heightAt } from '../assets/terrain';
import type { BikeState, RiddenBike } from '../physics/bike';
import { CAR_SPECS } from '../physics/cartypes';
import { Character, type CharacterState } from '../physics/character';
import { BikeRacks, dismountSpot, ParkedBikes, type BikePose } from '../physics/parkedbikes';
import { StreetProps } from '../physics/props';
import { surfaceY } from '../physics/surface';
import { TUNING } from '../physics/tuning';
import type { VehicleState } from '../physics/vehicle';
import { createPhysicsWorld, timeSlicer, type PhysicsWorld } from '../physics/world';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import { ENTER_MAX_DIST, TICK_HZ, type StationId } from '../net/constants';
import type { WorldAssets } from './assets';
import { CarPool, type PlayerId } from './cars';
import { carHitsPeople, separatePeople } from './collisions';
import { NpcBodies, type NpcSource } from './npc-bodies';
import { NPC_BODY_RADIUS } from '../net/constants';
import { Ignition, type IgnitionEvent, type IgnitionState } from './ignition';
import { pickVehicle } from './pick';
import { Proxies } from './proxies';
import { restoreDynamicBodies, saveDynamicBodies, type OwnState } from './replay';
import { ResetTimers } from './resets';
import type { LeftVehicle } from './npc-director';
import { canGetOut, exitFree, exitSpot, headingOf, nearestEnterableCar, type CarPose } from './rules';
import { findSpawn } from './spawn';

type Vec3 = { x: number; y: number; z: number };
type XZ = { x: number; z: number };

export type SimEvent =
  | { t: 'enter'; id: PlayerId; car: number }
  /** E on foot next to a car someone else drives (and no free car in reach). */
  | { t: 'enterDenied'; id: PlayerId }
  /** E on foot next to a bike someone else rides (and nothing free in reach). */
  | { t: 'mountDenied'; id: PlayerId }
  | { t: 'exit'; id: PlayerId; car: number }
  | { t: 'exitDenied'; id: PlayerId; reason: 'speed' | 'blocked' }
  | { t: 'mount'; id: PlayerId; bike: number }
  /**
   * Off the bike: stepped (or jumped) off, or `crash`ed into something or hit by a car (the rider falls and lies for
   * TUNING.bike.getUpSeconds without control). heading: the bike's heading at that moment.
   */
  | { t: 'dismount'; id: PlayerId; bike: number; heading: number; crash: boolean }
  /** E on the bike with no free spot to step off to. */
  | { t: 'dismountDenied'; id: PlayerId }
  /** A rider rang the bell (H) at (x, z). */
  | { t: 'bell'; id: PlayerId; x: number; z: number }
  | { t: 'ignition'; car: number; e: IgnitionEvent }
  | { t: 'knock'; id: PlayerId; by: number }
  | { t: 'impact'; x: number; z: number; strength: number }
  | { t: 'lamp'; i: number };

/**
 * One player's state after a step. pos/vel: feet and velocity while walking (or down), chassis centre and velocity
 * while driving, the ground under the wheels and the velocity along the heading while riding. yaw: the player's last
 * input yaw. engine: ignition of the car they drive ('off' otherwise). falling: fell off a bike and has no control yet
 * (fallTicks: ticks left). pedalling: riding with the pedal input forward.
 */
export type PlayerSnapshot = {
  mode: 'walk' | 'drive' | 'down' | 'ride';
  pos: Vec3;
  vel: Vec3;
  /** The camera's yaw (the input's), and the way the body faces (turns towards where it walks; what others see). */
  yaw: number;
  facing: number;
  carId: number | null;
  char: CharacterState;
  car: VehicleState | null;
  engine: IgnitionState;
  bikeId: number | null;
  bike: BikeState | null;
  falling: boolean;
  fallTicks: number;
  pedalling: boolean;
};

type Player = {
  char: Character; car: number | null; yaw: number; use: boolean; jump: boolean;
  /** The bike ridden (id in ParkedBikes) and its controller, or null. */
  bike: number | null; ridden: RiddenBike | null;
  /** Where the figure faces (heading; follows the walking direction): E picks the car or bike in front. */
  facing: number;
  /** Ticks left lying after a bike crash (no control). */
  fallTicks: number;
  /** Riding with the pedal input forward (the remote rig turns the crank). */
  pedalling: boolean;
  /** Tick of the last bell rung (BELL_EVERY ticks apart at most: a held bell bit must not flood the snapshots). */
  bellTick: number;
};

/** Time (ms) a step may spend building streamed city tiles beyond CITY_NEED (see CityTiles.update). */
const CITY_BUDGET_MS = 2;
/** Ticks between two car proximity updates (0.5 s, as in single player). */
const PROXIMITY_EVERY = 30;
/** Ticks between two idle-reset checks (1 s). */
const RESET_CHECK_EVERY = 60;
/** Feet above the surface when placed (spawn, getting out). */
const DROP = 0.02;
/** A spawn spot closer than this (m) to another player's feet is taken. */
const SPAWN_PERSON_GAP = 1;
const KMH = 1 / 3.6;
const DT = TUNING.world.dt;
/** Ticks without control after a bike crash (falling, lying, getting up). */
const FALL_TICKS = Math.round(TUNING.bike.getUpSeconds * TICK_HZ);
/** The facing turns towards the walking direction at this rate (1/s; as the rendered figure) above FACE_MIN_SPEED (m/s). */
const FACE_RATE = 12;
const FACE_MIN_SPEED = 0.2;
/** A rider's bell rings at most once per this many ticks (0.25 s). */
const BELL_EVERY = 15;

/**
 * The shared simulation: physics world, street props, the car pool and the players, advanced one fixed tick
 * (TUNING.world.dt) per step(). DOM- and Three.js-free and deterministic (time is the tick counter), so the server,
 * the client's prediction and offline play all run the same code.
 */
export class WorldSim {
  tick = 0;
  /**
   * The tick NPC plans are evaluated at: 'sim' = this.tick (server, offline), 'external' = npcTick, which the client
   * sets to the predicted server tick of the step it is about to take.
   */
  npcClock: 'sim' | 'external' = 'sim';
  npcTick = 0;
  private npcSource: NpcSource | null = null;
  private npcBodies: NpcBodies | null = null;
  private readonly list = new Map<PlayerId, Player>();
  private readonly ignitions: Ignition[];
  /** Per car: whether the last applied driver input brakes (brake lights). */
  private readonly brakes: boolean[];
  /** Per car: whether its driver holds the horn. */
  private readonly horns: boolean[];
  private readonly resets = new ResetTimers();
  private readonly proxies: Proxies;

  private constructor(
    readonly pw: PhysicsWorld, readonly cars: CarPool, readonly props: StreetProps, readonly bikes: ParkedBikes, readonly racks: BikeRacks,
    private readonly a: WorldAssets, private readonly foci: 'players' | readonly XZ[],
  ) {
    this.ignitions = cars.poses.map(() => new Ignition());
    this.brakes = cars.poses.map(() => false);
    this.horns = cars.poses.map(() => false);
    this.proxies = new Proxies(pw, cars, bikes);
  }

  /**
   * Builds the world from the assets. foci: where cars and parked bikes get physics bodies ('players' = around every
   * player, default). sliceMs: build the city colliders in slices of this many ms (see createPhysicsWorld).
   * streamCity: build the city's colliders only around the players (the client's prediction), starting with the
   * manifest spawn and these points; without it the whole city is built (the server).
   */
  static async create(
    a: WorldAssets, opts: { foci?: 'players' | { x: number; z: number }[]; sliceMs?: number; streamCity?: readonly XZ[] } = {},
  ): Promise<WorldSim> {
    const stream = opts.streamCity ? [a.manifest.spawn, ...opts.streamCity] : undefined;
    const pw = await createPhysicsWorld(a.collision, a.terrain, { sliceMs: opts.sliceMs, stream });
    const slice = timeSlicer(opts.sliceMs);
    const poles = (a.signals ?? []).flatMap((j) => j.poles.map((p) => [p.x, p.z] as const));
    const props = new StreetProps(pw, a.manifest.lamps, a.manifest.trees, a.terrain, poles);
    await slice();
    const cars = new CarPool(pw, a.manifest.parked, a.terrain);
    const racks = new BikeRacks(pw, a.manifest.bikeRacks, a.terrain);
    const bikes = new ParkedBikes(pw, a.manifest.bikes, a.terrain);
    await slice();
    const sim = new WorldSim(pw, cars, props, bikes, racks, a, opts.foci ?? 'players');
    cars.updateProximity(sim.focusPoints());
    bikes.updateProximity(sim.focusPoints());
    // colliders created after the last world step are invisible to scene queries (spawn and exit tests) until the
    // next one; nothing is awake yet, so this step changes no state
    pw.world.step();
    return sim;
  }

  /** Adds player `id` at `at` (on the surface there) or, without it, at a free spot near the manifest spawn. */
  addPlayer(id: PlayerId, at?: XZ): void {
    if (this.list.has(id)) throw new Error(`player ${id} exists`);
    const { manifest, terrain } = this.a;
    // cars and bikes near the new player must exist before the spawn test and the first step
    this.cars.updateProximity([...this.focusPoints(), at ?? manifest.spawn]);
    this.bikes.updateProximity([...this.focusPoints(), at ?? manifest.spawn]);
    this.pw.city?.update([...this.playerPoints(), at ?? manifest.spawn], 0);
    let p: Vec3;
    if (at) {
      const ground = heightAt(terrain, at.x, at.z);
      p = { x: at.x, y: surfaceY(this.pw, at.x, at.z, ground + 3) ?? ground, z: at.z };
    } else {
      p = findSpawn(this.pw, manifest, terrain, (x, z) => this.spawnTaken(x, z));
    }
    const char = new Character(this.pw, { x: p.x, y: p.y + DROP, z: p.z });
    this.list.set(id, {
      char, car: null, yaw: manifest.spawn.heading, use: false, jump: false, bike: null, ridden: null, facing: manifest.spawn.heading, fallTicks: 0,
      pedalling: false, bellTick: -Infinity,
    });
  }

  /** Removes player `id`; a car they drove stays where it is with the engine off. */
  removePlayer(id: PlayerId): void {
    const pl = this.list.get(id);
    if (!pl) return;
    if (pl.car !== null) this.leaveCar(pl.car);
    if (pl.bike !== null) this.bikes.dismount(pl.bike, pl.ridden!); // the bike rolls out where it is
    pl.char.dispose();
    this.list.delete(id);
  }

  players(): Iterable<PlayerId> {
    return this.list.keys();
  }

  hasPlayer(id: PlayerId): boolean {
    return this.list.has(id);
  }

  /** NPCs near players get kinematic bodies from `source` before every step (see NpcBodies). */
  attachNpcs(source: NpcSource): void {
    this.npcSource = source;
    this.npcBodies ??= new NpcBodies(this.pw);
  }

  /** NPC bodies near the players at NPC tick `tick` (for the coming step). */
  private syncNpcs(tick: number): void {
    if (!this.npcSource || !this.npcBodies) return;
    const pts = this.playerPoints();
    this.npcBodies.sync(pts.length ? this.npcSource.bodiesNear(tick, pts, NPC_BODY_RADIUS) : []);
  }

  /** Number of NPC bodies in the physics world (tests, debug). */
  get npcBodyCount(): number {
    return this.npcBodies?.count ?? 0;
  }

  /** Ignition of car i (engine sound and lights follow it). */
  ignition(i: number): Ignition {
    return this.ignitions[i]!;
  }

  /** Whether car i's brake lights are on: its driver holds the brake or throttles against the direction of travel. */
  braking(i: number): boolean {
    return this.brakes[i]!;
  }

  /** Whether car i's driver holds the horn. */
  horning(i: number): boolean {
    return this.horns[i]!;
  }

  /** Sets the radio of the car player `id` drives; ignored on foot. */
  setRadio(id: PlayerId, station: StationId | null): void {
    const car = this.list.get(id)?.car;
    if (car !== null && car !== undefined) this.cars.radio[car] = station;
  }

  /**
   * One tick. Inputs apply in map order (= arrival order: of two players pressing E at the same car, the first gets
   * it); players without an input get a neutral one (keeping their yaw). Then the rules, then the physics step.
   */
  step(inputs: ReadonlyMap<PlayerId, PlayerInput>): SimEvent[] {
    const ev: SimEvent[] = [];
    const order: [PlayerId, Player, PlayerInput][] = [];
    for (const [id, input] of inputs) {
      const pl = this.list.get(id);
      if (pl) order.push([id, pl, input]);
    }
    for (const [id, pl] of [...this.list].sort((x, y) => x[0] - y[0])) {
      if (!inputs.has(id)) order.push([id, pl, NEUTRAL_INPUT(pl.yaw)]);
    }

    // streamed city: tiles ahead of the players, a little per tick (always those right around them)
    this.pw.city?.update(this.playerPoints(), CITY_BUDGET_MS);
    // people first: a knockdown or push lands before this tick's walking input is applied
    carHitsPeople(this, ev);
    separatePeople(this);
    if (this.tick % RESET_CHECK_EVERY === 0) this.resets.update(this);

    for (const [id, pl, input] of order) this.useEdge(id, pl, input, ev);
    for (let i = 0; i < this.ignitions.length; i++) {
      for (const e of this.ignitions[i]!.update()) ev.push({ t: 'ignition', car: i, e });
    }
    for (const [id, pl, input] of order) this.applyInput(id, pl, input, ev);

    if (this.tick % PROXIMITY_EVERY === 0) {
      const foci = this.focusPoints();
      this.cars.updateProximity(foci);
      this.bikes.updateProximity(foci);
    }
    this.syncNpcs((this.npcClock === 'sim' ? this.tick : this.npcTick) + 1);
    this.pw.step();
    this.cars.sync();
    this.bikes.sync();
    for (const pl of this.list.values()) if (pl.car === null && pl.bike === null) this.turnFacing(pl);
    for (const i of this.props.takeFallen()) ev.push({ t: 'lamp', i });
    this.tick++;
    return ev;
  }

  /**
   * Client prediction: the other players as stand-ins. walkers: feet of the other people on foot (kinematic capsules).
   * cars: poses of the cars the server streams (someone else drives them, or they roll); they are followed
   * kinematically. A car no longer in `cars` rests (dynamic, asleep) at rest(i) or its last pose. Cars local players
   * drive are never touched.
   */
  setProxies(walkers: ReadonlyMap<PlayerId, Vec3>, cars: ReadonlyMap<number, CarPose>, rest?: (i: number) => CarPose | null): void {
    this.proxies.setWalkers(walkers);
    this.proxies.setCars(cars, (i) => this.drivenLocally(i), rest);
  }

  /**
   * Client prediction: poses of the bikes the server streams (ridden by someone else, or rolling) are followed
   * kinematically; a bike no longer streamed rests at rest(i) or its last pose. Bikes local players ride are never touched.
   */
  setBikeProxies(bikes: ReadonlyMap<number, BikePose>, rest?: (i: number) => BikePose | null): void {
    this.proxies.setBikes(bikes, (i) => this.riddenLocally(i), rest);
  }

  /**
   * Client prediction: who else rides which bike (the server's slow state). Those bikes count as taken when getting
   * on. Bikes local players ride are never touched.
   */
  setRemoteRiders(riders: ReadonlyMap<number, PlayerId>): void {
    const r = this.bikes.rider;
    for (let i = 0; i < r.length; i++) {
      if (this.riddenLocally(i)) continue;
      const who = riders.get(i) ?? null;
      if (r[i] !== who) r[i] = who;
    }
  }

  /**
   * Client prediction: who else (not a player of this sim) sits in which car, from the server's slow state. Those cars
   * count as taken when getting in. Cars local players drive are never touched.
   */
  setRemoteDrivers(drivers: ReadonlyMap<number, PlayerId>): void {
    for (let i = 0; i < this.cars.count; i++) {
      if (this.drivenLocally(i)) continue;
      const d = drivers.get(i) ?? null;
      if (this.cars.driver[i] !== d) this.cars.driver[i] = d;
    }
  }

  /**
   * Client reconciliation: puts player `id` into `from` (the server's state after the acknowledged input), then
   * re-applies `inputs` (the unacknowledged ones) step by step with pw.step(): only this player's input and getting
   * in/out, no rules for anyone else, no events, no tick advance. Every other dynamic body (pose, velocities, sleep)
   * and every lamp is put back afterwards, so only the own entity ends up on the new state. onStep(k) runs after
   * input k.
   */
  replay(id: PlayerId, from: OwnState, inputs: readonly PlayerInput[], onStep?: (k: number) => void, npcTickAt?: (k: number) => number): void {
    const pl = this.list.get(id);
    if (!pl) throw new Error(`no player ${id}`);
    this.setOwn(id, pl, from);
    // a correction may move the player far (a teleport, a respawn): the city there must exist before the replay
    this.pw.city?.update(this.playerPoints(), 0);
    // the own car; a ridden bike is kinematic and never among the saved bodies
    const ownBody = (): number => (pl.car !== null ? this.cars.vehicle(pl.car)!.chassis.handle : -1);
    const saved = saveDynamicBodies(this.pw.world, new Set([ownBody()]));
    this.props.takeFallen(); // replay runs between steps: nothing pending here
    const ev: SimEvent[] = [];
    inputs.forEach((input, k) => {
      this.useEdge(id, pl, input, ev);
      if (pl.car !== null) this.ignitions[pl.car]!.update();
      this.applyInput(id, pl, input, ev);
      if (npcTickAt) this.syncNpcs(npcTickAt(k) + 1);
      this.pw.step();
      onStep?.(k);
    });
    // (a parked bike mounted during the replay has lost its body: restoreDynamicBodies skips removed bodies)
    restoreDynamicBodies(this.pw.world, saved, new Set([ownBody()]));
    // lamps the replayed path knocked over: the original prediction did not (or did it in an earlier step)
    for (const i of this.props.takeFallen()) this.props.standUp(i);
    this.cars.sync();
    this.bikes.sync();
  }

  player(id: PlayerId): PlayerSnapshot {
    const pl = this.list.get(id);
    if (!pl) throw new Error(`no player ${id}`);
    const char = pl.char.saveState();
    if (pl.car !== null) {
      const v = this.cars.vehicle(pl.car)!;
      const car = v.saveState();
      return {
        mode: 'drive', pos: { x: car.x, y: car.y, z: car.z }, vel: { x: car.vx, y: car.vy, z: car.vz }, yaw: pl.yaw, facing: pl.facing,
        carId: pl.car, char, car, engine: this.ignitions[pl.car]!.state, bikeId: null, bike: null, falling: false, fallTicks: 0, pedalling: false,
      };
    }
    if (pl.bike !== null) {
      const b = pl.ridden!.state();
      return {
        mode: 'ride', pos: { x: b.x, y: b.y, z: b.z }, vel: { x: Math.sin(b.heading) * b.speed, y: b.vy, z: Math.cos(b.heading) * b.speed },
        yaw: pl.yaw, facing: pl.facing, carId: null, char, car: null, engine: 'off', bikeId: pl.bike, bike: b, falling: false, fallTicks: 0, pedalling: pl.pedalling,
      };
    }
    return {
      mode: pl.char.isDown() ? 'down' : 'walk', pos: pl.char.position(), vel: pl.char.velocity(), yaw: pl.yaw, facing: pl.facing,
      carId: null, char, car: null, engine: 'off', bikeId: null, bike: null, falling: pl.fallTicks > 0, fallTicks: pl.fallTicks, pedalling: false,
    };
  }

  /** The bike player `id` rides (its controller: type, lean), or null. */
  riddenBike(id: PlayerId): RiddenBike | null {
    return this.list.get(id)?.ridden ?? null;
  }

  /** Players on foot (not in a car) in id order, with their characters: what collisions.ts works on. */
  onFoot(): { id: PlayerId; char: Character }[] {
    const out: { id: PlayerId; char: Character }[] = [];
    for (const [id, pl] of this.list) if (pl.car === null && pl.bike === null) out.push({ id, char: pl.char });
    return out.sort((a, b) => a.id - b.id);
  }

  /** Cars and bikes players moved and left empty: NPC traffic stops for them. */
  leftVehicles(): LeftVehicle[] {
    const out: LeftVehicle[] = [];
    const { cars, bikes } = this;
    for (let i = 0; i < cars.count; i++) {
      if (cars.driver[i] !== null || !cars.isMoved(i)) continue;
      const v = cars.vehicle(i);
      const p = v ? v.pose() : cars.poses[i]!;
      out.push({ x: p.x, z: p.z, heading: headingOf(p), kind: 'car' });
    }
    for (let i = 0; i < bikes.poses.length; i++) {
      if (bikes.rider[i] != null || !bikes.isMoved(i)) continue;
      const p = bikes.poses[i]!;
      out.push({ x: p.x, z: p.z, heading: p.heading, kind: 'bike' });
    }
    return out;
  }

  /** Players on a bike in id order, with their bikes: what collisions.ts checks cars against. */
  riders(): { id: PlayerId; bike: RiddenBike }[] {
    const out: { id: PlayerId; bike: RiddenBike }[] = [];
    for (const [id, pl] of this.list) if (pl.ridden) out.push({ id, bike: pl.ridden });
    return out.sort((a, b) => a.id - b.id);
  }

  /** A car hit rider `id` hard: they fall off as in a crash (the bike stops and stays), with the `dismount` event. */
  knockOffBike(id: PlayerId, ev: SimEvent[], thrown: { x: number; y: number; z: number }): void {
    const pl = this.list.get(id);
    if (pl?.ridden) this.crash(id, pl, ev, thrown);
  }

  /** Where every player is (the car they drive, the bike they ride, else their feet). */
  playerPoints(): XZ[] {
    const out: XZ[] = [];
    for (const pl of this.list.values()) out.push(this.whereIs(pl));
    return out;
  }

  private whereIs(pl: Player): XZ {
    if (pl.car !== null) return this.cars.poses[pl.car]!;
    if (pl.ridden) return pl.ridden.state();
    return pl.char.position();
  }

  /** 'standing' (post upright), 'lying' (knocked over and asleep: nothing more to stream) or 'tipping' (knocked over, still moving or streamed). */
  lampState(i: number): 'standing' | 'tipping' | 'lying' {
    if (this.props.isStanding(i)) return 'standing';
    return this.props.isResting(i) ? 'lying' : 'tipping';
  }

  /** Indices of the lamps that are not standing. */
  lampsDown(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.props.count; i++) if (!this.props.isStanding(i)) out.push(i);
    return out;
  }

  /** Test hook: advances the tick counter (which the idle resets run on) by n without stepping any physics. */
  advanceIdleTicks(n: number): void {
    this.tick += n;
  }

  /** Where cars need physics: every player (the car they drive, else their feet) or the fixed foci. */
  private focusPoints(): XZ[] {
    if (this.foci !== 'players') return [...this.foci];
    return this.playerPoints();
  }

  /**
   * Spawn spot taken by something scene queries may not see yet (players and cars created since the last step):
   * another player's feet within SPAWN_PERSON_GAP, or the footprint of a car (plus a capsule radius).
   */
  private spawnTaken(x: number, z: number): boolean {
    for (const pl of this.list.values()) {
      const p = pl.car !== null ? null : this.whereIs(pl);
      if (p && Math.hypot(p.x - x, p.z - z) < SPAWN_PERSON_GAP) return true;
    }
    const r = TUNING.character.radius + 0.1;
    for (const [i, c] of this.cars.poses.entries()) {
      const V = CAR_SPECS[this.cars.types[i]!];
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > V.length || Math.abs(dz) > V.length) continue;
      const h = headingOf(c), s = Math.sin(h), co = Math.cos(h);
      const along = dx * s + dz * co, across = dx * co - dz * s;
      if (Math.abs(along) < V.length / 2 + r && Math.abs(across) < V.width / 2 + r) return true;
    }
    return false;
  }

  /** E acts on its rising edge (held for several ticks = one action); not while lying after a bike crash. */
  private useEdge(id: PlayerId, pl: Player, input: PlayerInput, ev: SimEvent[]): void {
    if (input.use && !pl.use && pl.fallTicks === 0) {
      if (pl.car !== null) this.getOut(id, pl, ev);
      else if (pl.bike !== null) this.getOffBike(id, pl, ev);
      else this.getIn(id, pl, ev);
    }
    pl.use = input.use;
  }

  /** Walking, riding or driving input for one step (after the ignitions advanced). */
  private applyInput(id: PlayerId, pl: Player, input: PlayerInput, ev: SimEvent[]): void {
    pl.yaw = input.yaw;
    // a jump (or a hop on the bike) takes off on the rising edge of the jump input, like one press of Space
    const jump = input.jump && !pl.jump;
    pl.jump = input.jump;
    if (pl.fallTicks > 0) {
      // fell off a bike: lying and getting up, no control
      pl.fallTicks--;
      pl.char.applyInput({ forward: 0, right: 0, run: false, yaw: input.yaw, jump: false });
    } else if (pl.bike !== null) {
      const r = pl.ridden!.applyInput({ pedal: input.forward, steer: input.right, sprint: input.run, hop: jump });
      pl.pedalling = input.forward > 0;
      if (input.bell && this.tick - pl.bellTick >= BELL_EVERY) {
        pl.bellTick = this.tick;
        const s = pl.ridden!.state();
        ev.push({ t: 'bell', id, x: s.x, z: s.z });
      }
      if (r.crashed) {
        // thrown on over the handlebar with the speed the bike hit the obstacle with
        const h = pl.ridden!.state().heading, v = r.crashSpeed;
        this.crash(id, pl, ev, { x: Math.sin(h) * v, y: TUNING.bike.crashUp, z: Math.cos(h) * v }, true);
      }
    } else if (pl.car === null) {
      pl.char.applyInput({ forward: input.forward, right: input.right, run: input.run, yaw: input.yaw, jump });
    } else {
      const v = this.cars.vehicle(pl.car)!;
      const throttle = this.ignitions[pl.car]!.state === 'running' ? input.forward : 0;
      v.applyInput({ throttle, steer: input.right, brake: input.brake });
      this.brakes[pl.car] = input.brake || (input.forward < 0 && v.speed() > 1);
      this.horns[pl.car] = input.horn === true;
    }
  }

  /** Whether a player of this sim drives car i. */
  private drivenLocally(i: number): boolean {
    const d = this.cars.driver[i];
    return d !== null && d !== undefined && this.list.get(d)?.car === i;
  }

  /** Whether a player of this sim rides bike i. */
  private riddenLocally(i: number): boolean {
    const r = this.bikes.rider[i];
    return r !== null && r !== undefined && this.list.get(r)?.bike === i;
  }

  /**
   * Puts player `id` into `s`: on or off the right bike, in or out of the right car (quietly: no events, no
   * door/ignition restart), then the state.
   */
  private setOwn(id: PlayerId, pl: Player, s: OwnState): void {
    const target = s.mode === 'drive' && s.car && s.carId !== null ? s.carId : null;
    const bikeTarget = s.mode === 'ride' && s.bike && s.bikeId !== null && s.bikeId !== undefined ? s.bikeId : null;
    if (pl.bike !== null && pl.bike !== bikeTarget) {
      this.bikes.dismount(pl.bike, pl.ridden!);
      pl.bike = null;
      pl.ridden = null;
      pl.char.setEnabled(true);
    }
    if (pl.car !== null && pl.car !== target) {
      this.leaveCar(pl.car);
      pl.car = null;
      pl.char.setEnabled(true);
    }
    pl.fallTicks = s.fallTicks ?? 0;
    pl.pedalling = false;
    if (bikeTarget !== null) {
      if (pl.bike === null) {
        pl.ridden = this.bikes.mount(bikeTarget, id);
        pl.bike = bikeTarget;
        pl.char.setEnabled(false);
      }
      pl.ridden!.restoreState(s.bike!);
    } else if (target !== null) {
      if (pl.car === null) {
        this.cars.enter(target, id);
        pl.car = target;
        pl.char.setEnabled(false);
      }
      this.cars.vehicle(target)!.restoreState(s.car!);
      const ign = this.ignitions[target]!;
      if (s.ignition) ign.restore(s.ignition);
      else if (s.engine) ign.set(s.engine);
    } else {
      pl.char.restoreState(s.char);
    }
    pl.use = s.use ?? false;
    pl.jump = s.jump ?? false;
  }

  private getIn(id: PlayerId, pl: Player, ev: SimEvent[]): void {
    if (pl.char.isDown()) return; // knocked down: no getting into a car
    const pos = pl.char.position();
    const candidates = this.cars.candidates();
    const car = nearestEnterableCar(pos, candidates, ENTER_MAX_DIST);
    // a car and a bike in reach: the one the figure faces
    const bike = this.bikes.nearestMountable(pos);
    if (pickVehicle(pos, pl.facing, car === null ? null : this.cars.poses[car]!, bike === null ? null : this.bikes.poses[bike]!) === 'bike') {
      this.mountBike(id, pl, bike!, ev);
      return;
    }
    if (car === null) {
      // only a taken car or bike in reach: tell the player (their prediction may have put them in or on it)
      let taken: XZ | null = null, takenD = ENTER_MAX_DIST;
      for (const c of candidates) {
        const d = Math.hypot(c.x - pos.x, c.z - pos.z);
        if (c.occupied && d <= takenD) [taken, takenD] = [c, d];
      }
      const ridden = this.bikes.nearestRidden(pos);
      const which = pickVehicle(pos, pl.facing, taken, ridden === null ? null : this.bikes.poses[ridden]!);
      if (which === 'car') ev.push({ t: 'enterDenied', id });
      else if (which === 'bike') ev.push({ t: 'mountDenied', id });
      return;
    }
    this.cars.enter(car, id);
    pl.car = car;
    pl.jump = false;
    pl.char.setEnabled(false);
    this.ignitions[car]!.start();
    ev.push({ t: 'enter', id, car });
  }

  private getOut(id: PlayerId, pl: Player, ev: SimEvent[]): void {
    const i = pl.car!;
    const v = this.cars.vehicle(i)!;
    if (!canGetOut(v.speed())) {
      ev.push({ t: 'exitDenied', id, reason: 'speed' });
      return;
    }
    const pose = v.pose();
    const spot = exitSpot({ x: pose.x, z: pose.z, heading: headingOf(pose) }, (x, z) => exitFree(this.pw, this.a.terrain, v.chassis, pose, x, z), v.spec.length);
    if (!spot) {
      ev.push({ t: 'exitDenied', id, reason: 'blocked' });
      return;
    }
    this.leaveCar(i);
    pl.car = null;
    pl.char.setEnabled(true);
    const y = surfaceY(this.pw, spot.x, spot.z, pose.y + 1) ?? heightAt(this.a.terrain, spot.x, spot.z);
    pl.char.teleport({ x: spot.x, y: y + DROP, z: spot.z });
    pl.facing = headingOf(pose);
    ev.push({ t: 'exit', id, car: i });
  }

  private mountBike(id: PlayerId, pl: Player, bike: number, ev: SimEvent[]): void {
    pl.ridden = this.bikes.mount(bike, id);
    pl.bike = bike;
    pl.jump = false;
    pl.char.setEnabled(false);
    ev.push({ t: 'mount', id, bike });
  }

  /** E on the bike: step off to the side (slow) or jump off and let the bike roll on (fast). */
  private getOffBike(id: PlayerId, pl: Player, ev: SimEvent[]): void {
    const r = pl.ridden!, s = r.state();
    const spot = dismountSpot(s, (x, z) => this.bikes.canStepOff(s, x, z));
    if (!spot) {
      ev.push({ t: 'dismountDenied', id });
      return;
    }
    if (Math.abs(s.speed) < TUNING.bike.dismountJumpKmh * KMH) r.restore({ ...s, speed: 0 });
    this.leaveBike(id, pl, spot, s, false, ev);
  }

  /**
   * Crashed into something or hit by a car: the rider falls next to the bike, which stays where it is, and is
   * `thrown` (m/s; slides out while lying, as a knocked-down walker).
   */
  private crash(id: PlayerId, pl: Player, ev: SimEvent[], thrown: { x: number; y: number; z: number }, over = false): void {
    const r = pl.ridden!, s = r.state();
    r.restore({ ...s, speed: 0 });
    // nowhere free to the side or behind (squeezed against a wall): fall where the bike is, never through the wall
    const spot = dismountSpot(s, (x, z) => this.bikes.canStepOff(s, x, z)) ?? { x: s.x, z: s.z };
    this.leaveBike(id, pl, spot, s, true, ev);
    pl.fallTicks = FALL_TICKS;
    // thrown from the saddle (the hips at about riderHips above the bike's ground), not from beside the bike
    pl.char.teleport({ x: s.x, y: s.y + TUNING.bike.riderHips - TUNING.character.radius, z: s.z });
    // head-on into something low enough (a car, a post): over the handlebar onto or over it
    const sp = Math.hypot(thrown.x, thrown.z);
    if (over && sp > 0) {
      const dx = thrown.x / sp, dz = thrown.z / sp, t = pl.char.throwOver(dx, dz, sp, thrown.y);
      pl.char.knock({ x: dx * t.speed, y: t.up, z: dz * t.speed }, FALL_TICKS);
    } else pl.char.knock(thrown, FALL_TICKS);
  }

  private leaveBike(id: PlayerId, pl: Player, spot: XZ, s: BikeState, crash: boolean, ev: SimEvent[]): void {
    const bike = pl.bike!;
    this.bikes.dismount(bike, pl.ridden!);
    pl.bike = null;
    pl.ridden = null;
    pl.pedalling = false;
    pl.char.setEnabled(true);
    const y = surfaceY(this.pw, spot.x, spot.z, s.y + 1) ?? heightAt(this.a.terrain, spot.x, spot.z);
    pl.char.teleport({ x: spot.x, y: y + DROP, z: spot.z });
    pl.facing = s.heading;
    ev.push({ t: 'dismount', id, bike, heading: s.heading, crash });
  }

  /** The facing follows the walking direction (as the rendered figure turns). */
  private turnFacing(pl: Player): void {
    if (pl.char.isDown()) return; // thrown or lying: turns again once up and walking
    const v = pl.char.velocity();
    if (Math.hypot(v.x, v.z) <= FACE_MIN_SPEED) return;
    const d = Math.atan2(v.x, v.z) - pl.facing;
    pl.facing += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, DT * FACE_RATE);
  }

  private leaveCar(i: number): void {
    this.cars.exit(i);
    this.ignitions[i]!.stop();
    this.brakes[i] = false;
    this.horns[i] = false;
  }
}
