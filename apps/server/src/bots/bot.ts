import { performance } from 'node:perf_hooks';
import { Client, type Room } from '@colyseus/sdk';
import {
  decodeSnapshot, encodeInputs, MAX_INPUTS_PER_PACKET, prng, PROTOCOL_VERSION, TICK_HZ, type PlayerInput, type Snapshot,
} from '@nn/shared';

/** walk: on foot to a new target every 3–8 s; drive: gets into a car and keeps it moving; ride: the same on a bike. */
export type BotRole = 'walk' | 'drive' | 'ride';
type XZ = { x: number; z: number };
/** A parked car or bike to board: position and heading (forward = (sin h, cos h)). */
export type VehicleSpot = XZ & { heading: number };

/** The part of a Colyseus room a bot uses (a fake one in tests). */
export interface BotRoom {
  send(type: string, msg?: unknown): void;
  sendBytes(type: string, bytes: Uint8Array): void;
  onMessage<T>(type: string, cb: (msg: T) => void): unknown;
}

export type BotOptions = {
  role: BotRole;
  seed: number;
  /** Centre of the area the bot stays in (the spawn). */
  home: XZ;
  /** Where a walker is teleported at the start. */
  start: XZ;
  /** Cars (drive) or bikes (ride) to try, in order; a vehicle bot is teleported next to one and presses E. */
  vehicles: VehicleSpot[];
  /** Wall clock in ms (default performance.now). */
  now?: () => number;
};

/** Packets are sent every this many ms: 3 inputs of 1/60 s each. */
const SEND_EVERY_MS = (1000 / TICK_HZ) * MAX_INPUTS_PER_PACKET;
/** Inputs due after a stalled event loop beyond this many are skipped, not sent in a burst. */
const MAX_CATCH_UP = 2 * MAX_INPUTS_PER_PACKET;
/** A bot that wanders farther than this (m) from home is brought back. */
const HOME_RADIUS = 300;
/** A vehicle bot that is not aboard after this many seconds is teleported to the next vehicle. */
const BOARD_TIMEOUT_S = 6;
const MODE = { walk: 0, drive: 1, down: 2, ride: 3 } as const;

export { prng };

/**
 * A load-test player: sends 60 Hz inputs in packets of 3, follows its own state from the snapshots and counts the bytes
 * it receives. All decisions come from a seeded PRNG and the bot's input clock (one tick per input).
 */
export class Bot {
  /** Last own mode from a snapshot (0 walk, 1 drive, 2 down, 3 ride); null before the first. */
  mode: number | null = null;
  private readonly rng: () => number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private t0 = 0;
  /** Inputs generated (and the bot's clock in ticks); skipped ones count too. */
  private ticks = 0;
  private seq = 1;
  private pos: XZ;
  private speed = 0;
  // walking
  private target: XZ;
  private nextTargetAt = 0;
  private running = false;
  // boarding
  private vehicleIx = -1;
  private boardDeadline = 0;
  private nextUseAt = 0;
  private teleportedAt = -Infinity;
  // driving / riding
  private steer = 0;
  private nextSteerAt = 0;
  private slowSince: number | null = null;
  private reverseUntil = 0;
  // received bytes, one bucket per whole second since construction
  private readonly bucketsT0: number;
  private readonly buckets: number[] = [];

  constructor(private readonly room: BotRoom, private readonly o: BotOptions) {
    this.rng = prng(o.seed);
    this.now = o.now ?? (() => performance.now());
    this.pos = { ...o.start };
    this.target = { ...o.start };
    this.bucketsT0 = this.now();
    room.onMessage('welcome', () => undefined);
    room.onMessage('n', (bytes: Uint8Array) => {
      this.npcBytes += bytes.byteLength;
    });
    room.onMessage('s', (bytes: Uint8Array) => {
      const s = decodeSnapshot(bytes);
      if (s) this.onSnapshot(s);
    });
  }

  start(): void {
    if (this.o.role === 'walk') this.room.send('devTeleport', { ...this.o.start });
    this.t0 = this.now();
    this.timer = setInterval(() => this.sendDue(), SEND_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** NPC message bytes received so far (part of the received bytes). */
  npcBytes = 0;

  /** Inputs sent so far. */
  get inputsSent(): number {
    return this.seq - 1;
  }

  /** Counts `n` received bytes in the current second. */
  received(n: number): void {
    const s = Math.floor((this.now() - this.bucketsT0) / 1000);
    while (this.buckets.length <= s) this.buckets.push(0);
    this.buckets[s]! += n;
  }

  /** Received bytes per completed second since the bot was created. */
  bytesPerSecond(): number[] {
    const s = Math.floor((this.now() - this.bucketsT0) / 1000);
    const out = this.buckets.slice(0, s);
    while (out.length < s) out.push(0);
    return out;
  }

  /** Sends the inputs due by the wall clock, in packets of up to 3; a backlog beyond MAX_CATCH_UP is skipped. */
  private sendDue(): void {
    const due = Math.floor(((this.now() - this.t0) * TICK_HZ) / 1000) - this.ticks;
    if (due <= 0) return;
    if (due > MAX_CATCH_UP) {
      this.ticks += due - MAX_CATCH_UP;
    }
    let left = Math.min(due, MAX_CATCH_UP);
    while (left > 0) {
      const n = Math.min(left, MAX_INPUTS_PER_PACKET);
      const inputs: PlayerInput[] = [];
      for (let k = 0; k < n; k++) inputs.push(this.nextInput());
      this.room.sendBytes('i', encodeInputs({ seq: this.seq, tick: this.ticks, inputs }));
      this.seq += n;
      left -= n;
    }
  }

  private onSnapshot(s: Snapshot): void {
    this.mode = s.own.mode;
    if (s.own.car) {
      this.pos = { x: s.own.car.x, z: s.own.car.z };
      this.speed = Math.hypot(s.own.car.vx, s.own.car.vz);
    } else if (s.own.bike) {
      this.pos = { x: s.own.bike.x, z: s.own.bike.z };
      this.speed = Math.abs(s.own.bike.speed);
    } else {
      this.pos = { x: s.own.char.x, z: s.own.char.z };
      this.speed = Math.hypot(s.own.char.vx, s.own.char.vz);
    }
  }

  /** One tick of input; the bot's clock advances by 1/60 s. */
  private nextInput(): PlayerInput {
    const t = this.ticks++ / TICK_HZ;
    if (this.o.role === 'walk') return this.walk(t);
    // (right after a teleport the last snapshot still shows the old state)
    const aboard = this.mode === (this.o.role === 'drive' ? MODE.drive : MODE.ride) && t - this.teleportedAt > 0.5;
    return aboard ? this.move(t) : this.board(t);
  }

  private walk(t: number): PlayerInput {
    if (t >= this.nextTargetAt || Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) < 3) {
      const a = this.rng() * 2 * Math.PI, r = 20 + 80 * this.rng();
      this.target = { x: this.pos.x + r * Math.sin(a), z: this.pos.z + r * Math.cos(a) };
      if (Math.hypot(this.target.x - this.o.home.x, this.target.z - this.o.home.z) > HOME_RADIUS) {
        const b = this.rng() * 2 * Math.PI, rb = 100 * this.rng();
        this.target = { x: this.o.home.x + rb * Math.sin(b), z: this.o.home.z + rb * Math.cos(b) };
      }
      this.nextTargetAt = t + 3 + 5 * this.rng();
      this.running = this.rng() < 0.5;
    }
    const yaw = Math.atan2(this.target.x - this.pos.x, this.target.z - this.pos.z);
    return { forward: 1, right: 0, run: this.running, jump: false, brake: false, use: false, yaw };
  }

  /** Not (or no longer) aboard: E once a second; after BOARD_TIMEOUT_S a teleport next to the next vehicle. */
  private board(t: number): PlayerInput {
    const input: PlayerInput = { forward: 0, right: 0, run: false, jump: false, brake: false, use: false, yaw: 0 };
    const spots = this.o.vehicles;
    if (spots.length === 0) return input;
    if (t >= this.boardDeadline) {
      this.vehicleIx++;
      const v = spots[this.vehicleIx % spots.length]!;
      // beside it, alternating sides per attempt: about 1.3 m from a car's flank, 1 m from a bike
      const side = (Math.floor(this.vehicleIx / spots.length) % 2 === 0 ? 1 : -1) * (this.o.role === 'drive' ? 2.2 : 1);
      this.room.send('devTeleport', { x: v.x + side * Math.cos(v.heading), z: v.z - side * Math.sin(v.heading) });
      this.teleportedAt = t;
      this.boardDeadline = t + BOARD_TIMEOUT_S;
      this.nextUseAt = t + 0.5;
      this.slowSince = null;
    }
    if (t >= this.nextUseAt) {
      input.use = true;
      this.nextUseAt = t + 1;
    }
    return input;
  }

  /** Aboard: throttle on, a new steering angle every 1.5–4.5 s, backing out after 2 s stuck. */
  private move(t: number): PlayerInput {
    // fell off or got out: try E where it is first, then a teleport
    this.boardDeadline = t + BOARD_TIMEOUT_S;
    this.nextUseAt = t + 0.5;
    if (Math.hypot(this.pos.x - this.o.home.x, this.pos.z - this.o.home.z) > HOME_RADIUS + 100) {
      this.boardDeadline = t; // too far out: teleported next to the next vehicle near home
      return this.board(t);
    }
    const input: PlayerInput = { forward: 1, right: 0, run: false, jump: false, brake: false, use: false, yaw: 0 };
    if (t < this.reverseUntil) {
      input.forward = -1;
      input.right = -this.steer;
      return input;
    }
    if (t >= this.nextSteerAt) {
      const max = this.o.role === 'drive' ? 1 : 0.5;
      this.steer = (this.rng() < 0.3 ? 0 : this.rng() * 2 - 1) * max;
      this.nextSteerAt = t + 1.5 + 3 * this.rng();
      this.running = this.rng() < 0.3;
    }
    if (this.speed < 1) {
      this.slowSince ??= t;
      if (t - this.slowSince > 2) {
        this.reverseUntil = t + 2;
        this.slowSince = null;
        this.steer = this.steer === 0 ? 1 : this.steer;
      }
    } else this.slowSince = null;
    input.forward = this.o.role === 'drive' ? 0.8 : 1;
    input.right = this.steer;
    input.run = this.o.role === 'ride' && this.running;
    return input;
  }
}

export type ConnectedBot = { bot: Bot; room: Room; left: Promise<number> };

/**
 * Joins the dev server at `url` as `name` and wraps a Bot around the room; every message's bytes are counted.
 * `left` resolves with the close code when the connection ends.
 */
export async function connectBot(url: string, name: string, worldHash: string, o: BotOptions): Promise<ConnectedBot> {
  const room = await new Client(url).join('nippes', { name, protocolVersion: PROTOCOL_VERSION, worldHash });
  const bot = new Bot(room as unknown as BotRoom, o);
  const events = room.connection.events;
  const handle = events.onmessage!;
  events.onmessage = (e: MessageEvent) => {
    bot.received((e.data as ArrayBuffer).byteLength ?? 0);
    handle(e);
  };
  const left = new Promise<number>((resolve) => room.onLeave((code) => { bot.stop(); resolve(code); }));
  return { bot, room, left };
}
