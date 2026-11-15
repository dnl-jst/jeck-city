import { performance } from 'node:perf_hooks';
import { Room, ServerError, type AuthContext, type Client, type RoomException, type RoomMethodName } from 'colyseus';
import {
  checkName, decodeInputs, dedupeName, FixedStepper, MAX_MESSAGE_BYTES, parseStationId, PROTOCOL_VERSION,
  SNAPSHOT_EVERY, TICK_HZ, WorldSim, type PlayerId, type PlayerInput, type PropPose, type WorldAssets,
} from '@nn/shared';
import type { Config } from './config';
import { InputQueue } from './inputs';
import { JoinLimiter } from './join-limit';
import { ipHash, log } from './log';
import { CarState, LampState, NippesState, PlayerState } from './state';

/** What the room is built from; the world is loaded once at server start. */
export type RoomDeps = { cfg: Config; assets: WorldAssets; worldHash: string };

/** Close code for a client that broke the protocol (unknown or oversized message). */
export const CLOSE_PROTOCOL = 4400;
/** Fixed steps run per wall-clock tick at most; any further backlog is dropped (and logged). */
const MAX_CATCH_UP = 3;
/** At most one tick-overrun warning per this many ms. */
const OVERRUN_WARN_MS = 10_000;
/** Longest name string looked at; longer ones are rejected without normalising them. */
const MAX_RAW_NAME = 100;
/** Messages per second before Colyseus drops a client: inputs come at 60 Hz, radio and pings rarely. */
const MAX_MESSAGES_PER_S = 5 * TICK_HZ;

const MODE = { walk: 0, drive: 1, down: 2 } as const;
const ENGINE = { off: 0, starting: 1, running: 2 } as const;

type Auth = { name: string; ipHash: string };
type Seat = { slot: PlayerId; name: string; ipHash: string; queue: InputQueue; kicked: boolean };

/** Byte size of a raw ws 'message' payload (Buffer, ArrayBuffer or fragments). */
function rawSize(data: unknown): number {
  if (Array.isArray(data)) return data.reduce((n: number, b: { byteLength: number }) => n + b.byteLength, 0);
  return (data as { byteLength?: number }).byteLength ?? 0;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Copies a pose into a schema entry, touching only changed fields (unchanged fields cost nothing on the wire). */
function setPose(e: Record<'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw', number>, p: PropPose): void {
  for (const k of ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const) if (e[k] !== p[k]) e[k] = p[k];
}

/**
 * The one room, 'nippes': the authoritative WorldSim at 60 Hz, one input queue per player, join checks
 * (version, name, rate) and the slow schema state. Built through nippesRoom(deps).
 */
export abstract class NippesRoom extends Room<{ state: NippesState }> {
  protected abstract readonly deps: RoomDeps;
  sim!: WorldSim;
  /** Fixed steps dropped because the wall clock ran ahead (total since start). */
  droppedSteps = 0;
  private readonly seats = new Map<string, Seat>();
  private readonly stepper = new FixedStepper(1 / TICK_HZ, MAX_CATCH_UP);
  private joins!: JoinLimiter;
  private unwarnedDrops = 0;
  private lastWarnMs = -Infinity;
  private lastTickMs: number | null = null;

  async onCreate(): Promise<void> {
    const { cfg, assets } = this.deps;
    this.maxClients = cfg.maxPlayers;
    this.autoDispose = false;
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_S;
    this.joins = new JoinLimiter(cfg.joinPerMin);
    this.setState(new NippesState());
    this.sim = await WorldSim.create(assets);

    this.onMessageBytes('i', (client, bytes: Uint8Array) => {
      const seat = this.seatOf(client);
      const p = seat && decodeInputs(bytes);
      if (p) seat.queue.push(p, performance.now());
    });
    this.onMessage('radio', (client, msg: unknown) => {
      const seat = this.seatOf(client);
      if (seat) this.sim.setRadio(seat.slot, parseStationId(msg));
    });
    this.onMessage('devTeleport', (client, msg: unknown) => {
      const seat = this.seatOf(client);
      if (!seat || !cfg.dev) return;
      const { x, z } = (msg ?? {}) as { x?: unknown; z?: unknown };
      if (!finite(x) || !finite(z)) return;
      // a fresh figure at (x, z); a car they drove stays there with the engine off
      this.sim.removePlayer(seat.slot);
      this.sim.addPlayer(seat.slot, { x, z });
    });
    this.onMessage('*', (client, type: string | number) => this.kick(client, `unknown message ${String(type).slice(0, 32)}`));

    this.setTimestep(() => this.advance(), 1000 / TICK_HZ);
    log('info', 'room created', { maxPlayers: cfg.maxPlayers, cars: this.sim.cars.count, lamps: this.sim.props.count, dev: cfg.dev });
  }

  onUnhandledMessage(client: Client, type: string | number): void {
    this.kick(client, `unhandled request ${String(type).slice(0, 32)}`);
  }

  onAuth(_client: Client, options: unknown, ctx: AuthContext): Auth {
    const hash = ipHash(ctx.ip);
    if (!this.joins.allow(hash, Date.now())) {
      log('info', 'join rejected', { ipHash: hash, reason: 'rate' });
      throw new ServerError(429, 'rate');
    }
    const o = (options ?? {}) as { name?: unknown; protocolVersion?: unknown; worldHash?: unknown };
    if (o.protocolVersion !== PROTOCOL_VERSION || o.worldHash !== this.deps.worldHash) {
      log('info', 'join rejected', { ipHash: hash, reason: 'version' });
      throw new ServerError(409, 'version');
    }
    const raw = typeof o.name === 'string' && o.name.length <= MAX_RAW_NAME ? o.name : '';
    const r = checkName(raw);
    if (!r.ok) {
      log('info', 'join rejected', { ipHash: hash, reason: r.error });
      throw new ServerError(400, r.error);
    }
    return { name: r.name, ipHash: hash };
  }

  onJoin(client: Client, _options: unknown, auth: Auth): void {
    const used = new Set([...this.seats.values()].map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    if (slot >= this.deps.cfg.maxPlayers) throw new ServerError(503, 'full');
    const name = dedupeName(auth.name, [...this.seats.values()].map((s) => s.name));

    this.sim.addPlayer(slot);
    const seat: Seat = { slot, name, ipHash: auth.ipHash, queue: new InputQueue(this.sim.player(slot).yaw), kicked: false };
    this.seats.set(client.sessionId, seat);
    this.state.players.set(String(slot), new PlayerState({ slot, name, mode: MODE.walk, carId: -1 }));
    // registered before Colyseus' own listener (added after onJoin), so it sees every message first
    client.ref.on('message', (data: unknown) => {
      if (rawSize(data) > MAX_MESSAGE_BYTES) this.kick(client, 'oversized message');
    });
    client.send('welcome', { slot, name, devMode: this.deps.cfg.dev, tick: this.sim.tick });
    log('info', 'join', { slot, name, ipHash: auth.ipHash, players: this.seats.size });
  }

  onLeave(client: Client, code?: number): void {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    this.seats.delete(client.sessionId);
    this.sim.removePlayer(seat.slot);
    this.state.players.delete(String(seat.slot));
    log('info', 'leave', { slot: seat.slot, name: seat.name, ipHash: seat.ipHash, code, players: this.seats.size });
  }

  /** Errors thrown in room hooks, message handlers and the tick: logged, the room keeps running. */
  onUncaughtException(error: RoomException, methodName: RoomMethodName): void {
    if (error.cause instanceof ServerError) return; // a deliberate rejection (onAuth/onJoin), already logged
    log('error', 'uncaught exception', { method: methodName, error: String(error), stack: error.stack });
  }

  /** Test and diagnostics access: the input queue / slot of a session. */
  queueOf(sessionId: string): InputQueue | undefined {
    return this.seats.get(sessionId)?.queue;
  }

  slotOf(sessionId: string): PlayerId | undefined {
    return this.seats.get(sessionId)?.slot;
  }

  private seatOf(client: Client): Seat | undefined {
    const seat = this.seats.get(client.sessionId);
    return seat && !seat.kicked ? seat : undefined;
  }

  /** Disconnects a client that broke the protocol; its later messages are ignored. */
  private kick(client: Client, reason: string): void {
    const seat = this.seats.get(client.sessionId);
    if (seat?.kicked) return;
    if (seat) seat.kicked = true;
    log('warn', 'kick', { slot: seat?.slot, ipHash: seat?.ipHash, reason });
    client.leave(CLOSE_PROTOCOL);
  }

  /** Wall-clock tick: as many fixed steps as are due (at most MAX_CATCH_UP; the rest is dropped and logged). */
  private advance(): void {
    // own clock: Colyseus' first delta spans the room's (slow) creation and would show up as a dropped backlog
    const now = performance.now();
    const dt = this.lastTickMs === null ? 0 : (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    const step = this.stepper.step;
    const due = Number.isFinite(dt) && dt > 0 ? Math.floor((this.stepper.alpha * step + dt) / step + 1e-9) : 0;
    const ran = this.stepper.advance(dt, () => this.stepOnce());
    const dropped = Math.max(0, due - ran);
    this.droppedSteps += dropped;
    this.unwarnedDrops += dropped;
    if (this.unwarnedDrops > 0 && now - this.lastWarnMs >= OVERRUN_WARN_MS) {
      log('warn', 'tick overrun: steps dropped', { dropped: this.unwarnedDrops, total: this.droppedSteps });
      this.unwarnedDrops = 0;
      this.lastWarnMs = now;
    }
  }

  private stepOnce(): void {
    // inputs apply in arrival order (of two players pressing E at one car, the first to reach the server gets it)
    const seats = [...this.seats.values()].sort((a, b) => a.queue.headArrival - b.queue.headArrival || a.slot - b.slot);
    const inputs = new Map<PlayerId, PlayerInput>();
    for (const s of seats) inputs.set(s.slot, s.queue.next());
    this.sim.step(inputs);
    if (this.sim.tick % SNAPSHOT_EVERY === 0) this.syncState();
  }

  /** Mirrors players, moved or driven cars and lying lamps into the schema state. */
  private syncState(): void {
    const { sim, state } = this;
    for (const seat of this.seats.values()) {
      const p = sim.player(seat.slot);
      const e = state.players.get(String(seat.slot));
      if (!e) continue;
      if (e.mode !== MODE[p.mode]) e.mode = MODE[p.mode];
      const carId = p.carId ?? -1;
      if (e.carId !== carId) e.carId = carId;
    }

    const cars = sim.cars;
    for (let i = 0; i < cars.count; i++) {
      const key = String(i);
      const driver = cars.driver[i] ?? null;
      if (driver === null && !cars.isMoved(i)) {
        if (state.cars.has(key)) state.cars.delete(key);
        continue;
      }
      const v = cars.vehicle(i);
      let e = state.cars.get(key);
      const fresh = !e;
      if (!e) state.cars.set(key, (e = new CarState()));
      const ign = sim.ignition(i);
      const d = driver ?? -1, engine = ENGINE[ign.state], lights = ign.lightLevel() > 0, radio = cars.radio[i] ?? '';
      if (e.driver !== d) e.driver = d;
      if (e.engine !== engine) e.engine = engine;
      if (e.lights !== lights) e.lights = lights;
      if (e.radio !== radio) e.radio = radio;
      if (fresh || !v || v.chassis.isSleeping()) setPose(e, v ? v.pose() : cars.poses[i]!);
    }

    const lying = new Set<string>();
    for (const i of sim.lampsDown()) {
      if (sim.lampState(i) !== 'lying') continue;
      const key = String(i);
      lying.add(key);
      let e = state.lamps.get(key);
      if (!e) state.lamps.set(key, (e = new LampState()));
      setPose(e, sim.props.lampPose(i));
    }
    for (const key of [...state.lamps.keys()]) if (!lying.has(key)) state.lamps.delete(key);
  }
}

/** The room class for defineRoom: bound to `deps`, and only one instance may exist (clients cannot create more). */
export function nippesRoom(deps: RoomDeps): new () => NippesRoom {
  let live = false;
  return class extends NippesRoom {
    protected readonly deps = deps;

    override async onCreate(): Promise<void> {
      if (live) throw new ServerError(403, 'there is only one room');
      live = true;
      await super.onCreate();
    }

    onDispose(): void {
      live = false;
    }
  };
}
