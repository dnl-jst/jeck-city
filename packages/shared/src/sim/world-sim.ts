import { heightAt } from '../assets/terrain';
import { Character, type CharacterState } from '../physics/character';
import { StreetProps } from '../physics/props';
import { surfaceY } from '../physics/surface';
import { TUNING } from '../physics/tuning';
import type { VehicleState } from '../physics/vehicle';
import { createPhysicsWorld, type PhysicsWorld } from '../physics/world';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import { ENTER_MAX_DIST, type StationId } from '../net/constants';
import type { WorldAssets } from './assets';
import { CarPool, type PlayerId } from './cars';
import { carHitsPeople, separatePeople } from './collisions';
import { Ignition, type IgnitionEvent, type IgnitionState } from './ignition';
import { ResetTimers } from './resets';
import { canGetOut, exitFree, exitSpot, headingOf, nearestEnterableCar } from './rules';
import { findSpawn } from './spawn';

type Vec3 = { x: number; y: number; z: number };
type XZ = { x: number; z: number };

export type SimEvent =
  | { t: 'enter'; id: PlayerId; car: number }
  /** E on foot next to a car someone else drives (and no free car in reach). */
  | { t: 'enterDenied'; id: PlayerId }
  | { t: 'exit'; id: PlayerId; car: number }
  | { t: 'exitDenied'; id: PlayerId; reason: 'speed' | 'blocked' }
  | { t: 'ignition'; car: number; e: IgnitionEvent }
  | { t: 'knock'; id: PlayerId; by: number }
  | { t: 'impact'; x: number; z: number; strength: number }
  | { t: 'lamp'; i: number };

/**
 * One player's state after a step. pos/vel: feet and velocity while walking (or down), chassis centre and velocity
 * while driving. yaw: the player's last input yaw. engine: ignition of the car they drive ('off' on foot).
 */
export type PlayerSnapshot = {
  mode: 'walk' | 'drive' | 'down';
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  carId: number | null;
  char: CharacterState;
  car: VehicleState | null;
  engine: IgnitionState;
};

type Player = { char: Character; car: number | null; yaw: number; use: boolean; jump: boolean };

/** Ticks between two car proximity updates (0.5 s, as in single player). */
const PROXIMITY_EVERY = 30;
/** Ticks between two idle-reset checks (1 s). */
const RESET_CHECK_EVERY = 60;
/** Feet above the surface when placed (spawn, getting out). */
const DROP = 0.02;
/** A spawn spot closer than this (m) to another player's feet is taken. */
const SPAWN_PERSON_GAP = 1;

/**
 * The shared simulation: physics world, street props, the car pool and the players, advanced one fixed tick
 * (TUNING.world.dt) per step(). DOM- and Three.js-free and deterministic (time is the tick counter), so the server,
 * the client's prediction and offline play all run the same code.
 */
export class WorldSim {
  tick = 0;
  private readonly list = new Map<PlayerId, Player>();
  private readonly ignitions: Ignition[];
  /** Per car: whether the last applied driver input brakes (brake lights). */
  private readonly brakes: boolean[];
  private readonly resets = new ResetTimers();

  private constructor(
    readonly pw: PhysicsWorld, readonly cars: CarPool, readonly props: StreetProps, private readonly a: WorldAssets,
    private readonly foci: 'players' | readonly XZ[],
  ) {
    this.ignitions = cars.poses.map(() => new Ignition());
    this.brakes = cars.poses.map(() => false);
  }

  /** Builds the world from the assets. foci: where cars get physics bodies ('players' = around every player, default). */
  static async create(a: WorldAssets, opts: { foci?: 'players' | { x: number; z: number }[] } = {}): Promise<WorldSim> {
    const pw = await createPhysicsWorld(a.collision, a.terrain);
    const props = new StreetProps(pw, a.manifest.lamps, a.manifest.trees, a.terrain);
    const cars = new CarPool(pw, a.manifest.parked, a.terrain);
    const sim = new WorldSim(pw, cars, props, a, opts.foci ?? 'players');
    cars.updateProximity(sim.focusPoints());
    // colliders created after the last world step are invisible to scene queries (spawn and exit tests) until the
    // next one; nothing is awake yet, so this step changes no state
    pw.world.step();
    return sim;
  }

  /** Adds player `id` at `at` (on the surface there) or, without it, at a free spot near the manifest spawn. */
  addPlayer(id: PlayerId, at?: XZ): void {
    if (this.list.has(id)) throw new Error(`player ${id} exists`);
    const { manifest, terrain } = this.a;
    // cars near the new player must exist before the spawn test and the first step
    this.cars.updateProximity([...this.focusPoints(), at ?? manifest.spawn]);
    let p: Vec3;
    if (at) {
      const ground = heightAt(terrain, at.x, at.z);
      p = { x: at.x, y: surfaceY(this.pw, at.x, at.z, ground + 3) ?? ground, z: at.z };
    } else {
      p = findSpawn(this.pw, manifest, terrain, (x, z) => this.spawnTaken(x, z));
    }
    const char = new Character(this.pw, { x: p.x, y: p.y + DROP, z: p.z });
    this.list.set(id, { char, car: null, yaw: manifest.spawn.heading, use: false, jump: false });
  }

  /** Removes player `id`; a car they drove stays where it is with the engine off. */
  removePlayer(id: PlayerId): void {
    const pl = this.list.get(id);
    if (!pl) return;
    if (pl.car !== null) this.leaveCar(pl.car);
    pl.char.dispose();
    this.list.delete(id);
  }

  players(): Iterable<PlayerId> {
    return this.list.keys();
  }

  hasPlayer(id: PlayerId): boolean {
    return this.list.has(id);
  }

  /** Ignition of car i (engine sound and lights follow it). */
  ignition(i: number): Ignition {
    return this.ignitions[i]!;
  }

  /** Whether car i's brake lights are on: its driver holds the brake or throttles against the direction of travel. */
  braking(i: number): boolean {
    return this.brakes[i]!;
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

    // people first: a knockdown or push lands before this tick's walking input is applied
    carHitsPeople(this, ev);
    separatePeople(this);
    if (this.tick % RESET_CHECK_EVERY === 0) this.resets.update(this);

    // E acts on its rising edge (held for several ticks = one action)
    for (const [id, pl, input] of order) {
      if (input.use && !pl.use) {
        if (pl.car === null) this.getIn(id, pl, ev);
        else this.getOut(id, pl, ev);
      }
      pl.use = input.use;
    }
    for (let i = 0; i < this.ignitions.length; i++) {
      for (const e of this.ignitions[i]!.update()) ev.push({ t: 'ignition', car: i, e });
    }
    for (const [, pl, input] of order) {
      pl.yaw = input.yaw;
      // a jump takes off on the rising edge of the jump input, like one press of Space in single player
      const jump = input.jump && !pl.jump;
      pl.jump = input.jump;
      if (pl.car === null) {
        pl.char.applyInput({ forward: input.forward, right: input.right, run: input.run, yaw: input.yaw, jump });
      } else {
        const v = this.cars.vehicle(pl.car)!;
        const throttle = this.ignitions[pl.car]!.state === 'running' ? input.forward : 0;
        v.applyInput({ throttle, steer: input.right, brake: input.brake });
        this.brakes[pl.car] = input.brake || (input.forward < 0 && v.speed() > 1);
      }
    }

    if (this.tick % PROXIMITY_EVERY === 0) this.cars.updateProximity(this.focusPoints());
    this.pw.step();
    this.cars.sync();
    for (const i of this.props.takeFallen()) ev.push({ t: 'lamp', i });
    this.tick++;
    return ev;
  }

  player(id: PlayerId): PlayerSnapshot {
    const pl = this.list.get(id);
    if (!pl) throw new Error(`no player ${id}`);
    const char = pl.char.saveState();
    if (pl.car !== null) {
      const v = this.cars.vehicle(pl.car)!;
      const car = v.saveState();
      return {
        mode: 'drive', pos: { x: car.x, y: car.y, z: car.z }, vel: { x: car.vx, y: car.vy, z: car.vz }, yaw: pl.yaw,
        carId: pl.car, char, car, engine: this.ignitions[pl.car]!.state,
      };
    }
    return {
      mode: pl.char.isDown() ? 'down' : 'walk', pos: pl.char.position(), vel: pl.char.velocity(), yaw: pl.yaw,
      carId: null, char, car: null, engine: 'off',
    };
  }

  /** Players on foot (not in a car) in id order, with their characters: what collisions.ts works on. */
  onFoot(): { id: PlayerId; char: Character }[] {
    const out: { id: PlayerId; char: Character }[] = [];
    for (const [id, pl] of this.list) if (pl.car === null) out.push({ id, char: pl.char });
    return out.sort((a, b) => a.id - b.id);
  }

  /** Where every player is (the car they drive, else their feet). */
  playerPoints(): XZ[] {
    const out: XZ[] = [];
    for (const pl of this.list.values()) out.push(pl.car !== null ? this.cars.poses[pl.car]! : pl.char.position());
    return out;
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
      const p = pl.car !== null ? null : pl.char.position();
      if (p && Math.hypot(p.x - x, p.z - z) < SPAWN_PERSON_GAP) return true;
    }
    const V = TUNING.vehicle, r = TUNING.character.radius + 0.1;
    for (const c of this.cars.poses) {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > V.length || Math.abs(dz) > V.length) continue;
      const h = headingOf(c), s = Math.sin(h), co = Math.cos(h);
      const along = dx * s + dz * co, across = dx * co - dz * s;
      if (Math.abs(along) < V.length / 2 + r && Math.abs(across) < V.width / 2 + r) return true;
    }
    return false;
  }

  private getIn(id: PlayerId, pl: Player, ev: SimEvent[]): void {
    if (pl.char.isDown()) return; // knocked down: no getting into a car
    const pos = pl.char.position();
    const candidates = this.cars.candidates();
    const car = nearestEnterableCar(pos, candidates, ENTER_MAX_DIST);
    if (car === null) {
      // only a taken car in reach: tell the player (their prediction may have put them in it)
      if (candidates.some((c) => c.occupied && Math.hypot(c.x - pos.x, c.z - pos.z) <= ENTER_MAX_DIST)) ev.push({ t: 'enterDenied', id });
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
    const spot = exitSpot({ x: pose.x, z: pose.z, heading: headingOf(pose) }, (x, z) => exitFree(this.pw, this.a.terrain, v.chassis, pose, x, z));
    if (!spot) {
      ev.push({ t: 'exitDenied', id, reason: 'blocked' });
      return;
    }
    this.leaveCar(i);
    pl.car = null;
    pl.char.setEnabled(true);
    const y = surfaceY(this.pw, spot.x, spot.z, pose.y + 1) ?? heightAt(this.a.terrain, spot.x, spot.z);
    pl.char.teleport({ x: spot.x, y: y + DROP, z: spot.z });
    ev.push({ t: 'exit', id, car: i });
  }

  private leaveCar(i: number): void {
    this.cars.exit(i);
    this.ignitions[i]!.stop();
    this.brakes[i] = false;
  }
}
