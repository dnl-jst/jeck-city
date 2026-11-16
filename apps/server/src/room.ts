import { performance } from 'node:perf_hooks';
import { CloseCode, Room, ServerError, type AuthContext, type Client, type RoomException, type RoomMethodName } from 'colyseus';
import {
  buildSnapshot, CHARACTER_VARIANTS, checkName, decodeInputs, dedupeName, encodeSnapshot, FixedStepper, Interest, MAX_MESSAGE_BYTES,
  parseStationId, PROTOCOL_VERSION, SNAPSHOT_EVERY, TICK_HZ, WorldSim,
  type PlayerId, type PlayerInput, type PropPose, type SimEvent, type WorldAssets,
} from '@nn/shared';
import type { Config } from './config';
import { LagLine } from './fake-lag';
import { TickStats, type Health } from './health';
import { InputQueue } from './inputs';
import { JoinLimiter } from './join-limit';
import { ipHash, log } from './log';
import { BikeSlowState, CarState, LampState, NippesState, PlayerState } from './state';

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

const MODE = { walk: 0, drive: 1, down: 2, ride: 3 } as const;
const ENGINE = { off: 0, starting: 1, running: 2 } as const;

type Auth = { name: string; ipHash: string; variant: number };
type Seat = {
  slot: PlayerId; name: string; ipHash: string; queue: InputQueue; kicked: boolean;
  client: Client;
  /** Snapshot interest set of this client. */
  interest: Interest;
  /** Connection lost, inside the reconnect window: neutral input, no snapshots. */
  away: boolean;
  /** Fake lag (dev) per direction; null when off. */
  lagIn: LagLine | null;
  lagOut: LagLine | null;
};

/** Byte size of a raw ws 'message' payload (Buffer, ArrayBuffer or fragments). */
function rawSize(data: unknown): number {
  if (Array.isArray(data)) return data.reduce((n: number, b: { byteLength: number }) => n + b.byteLength, 0);
  return (data as { byteLength?: number }).byteLength ?? 0;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** An untrusted character variant: an index into CHARACTER_VARIANTS, anything else is the first one. */
const parseVariant = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < CHARACTER_VARIANTS.length ? (v as number) : 0);

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
  private readonly stats = new TickStats();
  /** Sim events since the last snapshot round; every client's snapshot gets all of them. */
  private events: SimEvent[] = [];

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
      if (!seat) return;
      this.inbound(seat, () => {
        const p = decodeInputs(bytes);
        if (p) seat.queue.push(p, performance.now());
      });
    });
    this.onMessage('radio', (client, msg: unknown) => {
      const seat = this.seatOf(client);
      if (seat) this.inbound(seat, () => this.sim.setRadio(seat.slot, parseStationId(msg)));
    });
    this.onMessage('devTeleport', (client, msg: unknown) => {
      const seat = this.seatOf(client);
      if (!seat || !cfg.dev) return;
      const { x, z } = (msg ?? {}) as { x?: unknown; z?: unknown };
      // (a bike they rode rolls out there, a car they drove stays with the engine off)
      if (!finite(x) || !finite(z)) return;
      // a fresh figure at (x, z); a car they drove stays there with the engine off
      this.inbound(seat, () => {
        this.sim.removePlayer(seat.slot);
        this.sim.addPlayer(seat.slot, { x, z });
      });
    });
    this.onMessage('variant', (client, msg: unknown) => {
      const seat = this.seatOf(client);
      const e = seat && this.state.players.get(String(seat.slot));
      if (e) e.variant = parseVariant(msg);
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
    const o = (options ?? {}) as { name?: unknown; protocolVersion?: unknown; worldHash?: unknown; variant?: unknown };
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
    return { name: r.name, ipHash: hash, variant: parseVariant(o.variant) };
  }

  onJoin(client: Client, _options: unknown, auth: Auth): void {
    const used = new Set([...this.seats.values()].map((s) => s.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    if (slot >= this.deps.cfg.maxPlayers) throw new ServerError(503, 'full');
    const name = dedupeName(auth.name, [...this.seats.values()].map((s) => s.name));

    this.sim.addPlayer(slot);
    const lag = this.deps.cfg.fakeLag;
    const seat: Seat = {
      slot, name, ipHash: auth.ipHash, queue: new InputQueue(this.sim.player(slot).yaw), kicked: false, client,
      interest: new Interest(), away: false, lagIn: lag && new LagLine(lag), lagOut: lag && new LagLine(lag),
    };
    this.seats.set(client.sessionId, seat);
    this.state.players.set(String(slot), new PlayerState({ slot, name, mode: MODE.walk, carId: -1, bikeId: -1, variant: auth.variant }));
    this.watchMessageSize(client);
    client.send('welcome', { slot, name, devMode: this.deps.cfg.dev, tick: this.sim.tick });
    log('info', 'join', { slot, name, ipHash: auth.ipHash, players: this.seats.size });
  }

  /** The connection broke without a goodbye: the figure (and car) stay for cfg.reconnectS, with neutral input. */
  onDrop(client: Client, code?: number): void {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    // no second chance after a protocol violation (kicked, oversized frame, Colyseus message-rate cut)
    if (seat.kicked || code === CloseCode.WITH_ERROR) return this.removeSeat(client, code);
    seat.away = true;
    log('info', 'drop', { slot: seat.slot, ipHash: seat.ipHash, code });
    this.allowReconnection(client, this.deps.cfg.reconnectS).catch(() => undefined); // onLeave follows when it runs out
  }

  onReconnect(client: Client): void {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    seat.client = client; // a new Client object for the new connection
    seat.away = false;
    seat.interest = new Interest(); // the new connection knows nothing yet
    this.watchMessageSize(client);
    this.outbound(seat, () => client.send('welcome', { slot: seat.slot, name: seat.name, devMode: this.deps.cfg.dev, tick: this.sim.tick }));
    log('info', 'reconnect', { slot: seat.slot, name: seat.name, ipHash: seat.ipHash });
  }

  onLeave(client: Client, code?: number): void {
    this.removeSeat(client, code);
  }

  /** The figure goes away, a car it drove stays behind (engine off) and the slot is free again. */
  private removeSeat(client: Client, code?: number): void {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    this.seats.delete(client.sessionId);
    seat.lagIn?.cancel();
    seat.lagOut?.cancel();
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

  /** /healthz: connected players, p95 tick time and dropped steps over the last 600 ticks. */
  health(): Health {
    return this.stats.health(this.seats.size);
  }

  /** Runs `action` now, or after the simulated inbound lag (dev). Order per client is kept. */
  private inbound(seat: Seat, action: () => void): void {
    if (seat.lagIn) seat.lagIn.push(() => { if (this.seats.get(seat.client.sessionId) === seat) action(); });
    else action();
  }

  /** Sends now, or after the simulated outbound lag (dev). Nothing is sent while the client is away. */
  private outbound(seat: Seat, action: () => void): void {
    if (seat.away) return;
    if (seat.lagOut) seat.lagOut.push(() => { if (this.seats.get(seat.client.sessionId) === seat && !seat.away) action(); });
    else action();
  }

  /** Disconnects clients sending oversized raw messages. Registered before Colyseus' own listener, so it sees every message first. */
  private watchMessageSize(client: Client): void {
    client.ref.on('message', (data: unknown) => {
      if (rawSize(data) > MAX_MESSAGE_BYTES) this.kick(client, 'oversized message');
    });
    // a frame beyond the transport's payload limit closes the socket as 1006, like a dead network: tell them apart here
    client.ref.on('error', (e: { code?: string }) => {
      const seat = this.seats.get(client.sessionId);
      if (seat && e?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') seat.kicked = true;
    });
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
    this.stats.drop(dropped);
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
    const t0 = performance.now();
    for (const e of this.sim.step(inputs)) this.events.push(e);
    if (this.sim.tick % SNAPSHOT_EVERY === 0) {
      this.syncState();
      this.sendSnapshots();
    }
    this.stats.record(performance.now() - t0);
  }

  /** One snapshot per connected client: its own state in full, the rest within its interest set. */
  private sendSnapshots(): void {
    const events = this.events;
    this.events = [];
    for (const seat of this.seats.values()) {
      if (seat.away) continue;
      const snap = buildSnapshot(this.sim, seat.slot, seat.interest, seat.queue.ackSeq, events, (id) => id);
      const bytes = encodeSnapshot(snap);
      this.outbound(seat, () => seat.client.sendBytes('s', bytes));
    }
  }

  /** Mirrors players, moved or driven cars, moved or ridden bikes and lying lamps into the schema state. */
  private syncState(): void {
    const { sim, state } = this;
    for (const seat of this.seats.values()) {
      const p = sim.player(seat.slot);
      const e = state.players.get(String(seat.slot));
      if (!e) continue;
      if (e.mode !== MODE[p.mode]) e.mode = MODE[p.mode];
      const carId = p.carId ?? -1;
      if (e.carId !== carId) e.carId = carId;
      const bikeId = p.bikeId ?? -1;
      if (e.bikeId !== bikeId) e.bikeId = bikeId;
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

    const bikes = sim.bikes, rolling = new Set(bikes.awake());
    for (let i = 0; i < bikes.poses.length; i++) {
      const key = String(i);
      const rider = bikes.rider[i] ?? null;
      if (rider === null && !bikes.isMoved(i)) {
        if (state.bikes.has(key)) state.bikes.delete(key);
        continue;
      }
      let e = state.bikes.get(key);
      const fresh = !e;
      if (!e) state.bikes.set(key, (e = new BikeSlowState()));
      const r = rider ?? -1;
      if (e.rider !== r) e.rider = r;
      if (fresh || (rider === null && !rolling.has(i))) {
        const p = bikes.poses[i]!;
        for (const k of ['x', 'y', 'z', 'heading'] as const) if (e[k] !== p[k]) e[k] = p[k];
      }
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
