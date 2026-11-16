import { describe, expect, test, vi } from 'vitest';
import {
  buildSnapshot, decodeInputs, decodeSnapshot, encodeInputs, encodeSnapshot, headingOf, Interest, NEUTRAL_INPUT,
  WorldSim, type CarPose, type InputPacket, type PlayerInput, type SimEvent, type WorldAssets,
} from '@nn/shared';
import { fixtureAssets } from '../../../../packages/shared/src/sim/fixture.test-util';
import { ServerClock } from './clock';
import type { NetState } from './connection';
import { OnlineSession, type NetLink } from './online-session';

const ME = 1, OTHER = 2;
const TICK_MS = 1000 / 60;
/** Most inputs the server holds per player (as apps/server InputQueue). */
const QUEUE_MAX = 6;
const N = NEUTRAL_INPUT(0);

/** Seeded PRNG (mulberry32): frame-time jitter, the same every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mail = { at: number; run: () => void };
type Pose = Record<'x' | 'y' | 'z' | 'qx' | 'qy' | 'qz' | 'qw', number>;

/**
 * A server WorldSim behind a fake connection: inputs and snapshots travel through the codec with `oneWayMs` delay each
 * way; the server steps at 60 Hz in simulated time, takes one queued input per player and tick (neutral if none), and
 * sends a snapshot plus the slow-state mirror every 3rd tick.
 */
class FakeNet {
  t = 0;
  /** Link stalled: inputs and snapshots sent meanwhile are lost. */
  hold = false;
  /** Inputs of the server-side players other than ME, per tick. */
  others: (tick: number) => Map<number, PlayerInput> = () => new Map();
  readonly link: NetLink;
  private readonly queue: { seq: number; input: PlayerInput }[] = [];
  private lastQueued = -1;
  private ackSeq = 0;
  private lastYaw = 0;
  private nextTick = TICK_MS;
  private events: SimEvent[] = [];
  private readonly interest = new Interest();
  private mail: Mail[] = [];
  private readonly listeners = new Set<(s: ReturnType<typeof decodeSnapshot> & object) => void>();
  private mirror = { players: new Map(), cars: new Map(), lamps: new Map() };

  constructor(readonly server: WorldSim, private readonly oneWayMs: number) {
    const net = this;
    this.link = {
      clock: new ServerClock(),
      welcome: { slot: ME, name: 'Jupp', devMode: true, tick: 0 },
      rttMs: 2 * oneWayMs,
      get state() { return net.mirror as unknown as NetState; },
      sendInputs: (p: InputPacket) => {
        if (this.hold) return;
        const bytes = encodeInputs(p);
        this.post(() => this.receive(decodeInputs(bytes)!));
      },
      sendRadio: () => undefined,
      onSnapshot: (cb) => { this.listeners.add(cb); return () => this.listeners.delete(cb); },
      onWelcome: () => () => undefined,
    };
  }

  /** Runs deliveries and server ticks up to simulated time `ms`, in time order. */
  advanceTo(ms: number): void {
    for (;;) {
      const m = this.mail.reduce<Mail | null>((a, b) => (!a || b.at < a.at ? b : a), null);
      const tick = this.nextTick <= ms ? this.nextTick : Infinity;
      if (m && m.at <= ms && m.at <= tick) {
        this.mail.splice(this.mail.indexOf(m), 1);
        this.t = m.at;
        m.run();
      } else if (tick !== Infinity) {
        this.t = tick;
        this.nextTick += TICK_MS;
        this.tick();
      } else break;
    }
    this.t = ms;
  }

  private post(run: () => void): void {
    this.mail.push({ at: this.t + this.oneWayMs, run });
  }

  private receive(p: InputPacket): void {
    p.inputs.forEach((input, k) => {
      if (p.seq + k <= this.lastQueued) return;
      this.lastQueued = p.seq + k;
      this.queue.push({ seq: p.seq + k, input });
      if (this.queue.length > QUEUE_MAX) this.queue.shift();
    });
  }

  private tick(): void {
    const s = this.server;
    const inputs = this.others(s.tick);
    const e = this.queue.shift();
    if (e) { this.ackSeq = e.seq; this.lastYaw = e.input.yaw; }
    inputs.set(ME, e ? e.input : NEUTRAL_INPUT(this.lastYaw));
    this.events.push(...s.step(inputs));
    if (s.tick % 3 !== 0) return;
    const bytes = encodeSnapshot(buildSnapshot(s, ME, this.interest, this.ackSeq, this.events, (id) => id));
    this.events = [];
    const mirror = this.slowState();
    if (this.hold) return;
    this.post(() => {
      const snap = decodeSnapshot(bytes)!;
      this.link.clock.onSnapshot(snap.serverTick, this.t);
      this.mirror = mirror;
      for (const cb of this.listeners) cb(snap);
    });
  }

  /** What the Colyseus state would hold (as the room's syncState). */
  private slowState() {
    const s = this.server;
    const pose = (p: CarPose): Pose => ({ x: p.x, y: p.y, z: p.z, qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw });
    const players = new Map<string, unknown>();
    for (const id of s.players()) {
      const p = s.player(id);
      players.set(String(id), { slot: id, name: `p${id}`, mode: { walk: 0, drive: 1, down: 2, ride: 0 }[p.mode], carId: p.carId ?? -1 });
    }
    const cars = new Map<string, unknown>();
    for (let i = 0; i < s.cars.count; i++) {
      if (s.cars.driver[i] === null && !s.cars.isMoved(i)) continue;
      const v = s.cars.vehicle(i);
      cars.set(String(i), { driver: s.cars.driver[i] ?? -1, engine: 0, lights: false, radio: '', ...pose(v ? v.pose() : s.cars.poses[i]!) });
    }
    const lamps = new Map<string, unknown>();
    for (const i of s.lampsDown()) if (s.lampState(i) === 'lying') lamps.set(String(i), s.props.lampPose(i));
    return { players, cars, lamps };
  }
}

/** Left of a car (left = (cos h, −sin h)), d m. */
function leftOf(c: CarPose, d: number): { x: number; z: number } {
  const h = headingOf(c);
  return { x: c.x + Math.cos(h) * d, z: c.z - Math.sin(h) * d };
}

/** Server and client sims of the same world with ME at `at` in both; the session follows the server with 2 × oneWayMs RTT. */
async function setup(a: WorldAssets, at: { x: number; z: number }, oneWayMs: number, serverAssets = a) {
  const server = await WorldSim.create(serverAssets);
  const client = await WorldSim.create(a);
  server.addPlayer(ME, at);
  client.addPlayer(ME, at);
  const net = new FakeNet(server, oneWayMs);
  const session = new OnlineSession(client, net.link, { now: () => net.t });
  return { server, client, net, session };
}

type Frame = { t: number; events: SimEvent[]; correction: number; predErrorM: number; probe: boolean };

/** Plays `ms` of frames with 12–21 ms frame times (60 fps on average); input(t) is the input of the frame at t. */
function play(
  net: FakeNet, session: OnlineSession, ms: number, input: (t: number) => PlayerInput, rnd: () => number, probe = () => false,
): Frame[] {
  const out: Frame[] = [];
  const end = net.t + ms;
  while (net.t < end) {
    const dt = 12 + rnd() * 9.33;
    net.advanceTo(net.t + dt);
    const events = session.frame(dt / 1000, input(net.t));
    out.push({ t: net.t, events, correction: session.correction, predErrorM: session.stats().predErrorM, probe: probe() });
  }
  return out;
}

const p95 = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)]!;

/** The fixture with car 0 out on the open south-west lawn (−60, −80), facing +z. */
function openRoad(): WorldAssets {
  const a = fixtureAssets();
  a.manifest.parked[0] = { x: -60, z: -80, heading: 0, color: 0xff0000 };
  return a;
}

describe('OnlineSession', () => {
  test('150 ms RTT: no correction jump > 0.2 m (p95), walking', async () => {
    const { net, session, client, server } = await setup(fixtureAssets(), { x: -70, z: -70 }, 75);
    const rnd = prng(1);
    play(net, session, 1000, () => N, rnd);
    // running in a wide circle (yaw turns 0.25 rad/s: radius ~22 m)
    const frames = play(net, session, 20_000, (t) => ({ ...N, forward: 1, run: true, yaw: t / 4000 }), rnd);
    expect(p95(frames.map((f) => f.correction))).toBeLessThan(0.2);
    expect(p95(frames.map((f) => f.predErrorM))).toBeLessThan(0.2);
    // it did move, and the prediction ends close to the server (which is ~10 ticks behind)
    const c = client.player(ME).pos, s = server.player(ME).pos;
    expect(Math.hypot(c.x + 70, c.z + 70)).toBeGreaterThan(10);
    expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeLessThan(2);
  }, 60_000);

  test('150 ms RTT: no correction jump > 0.2 m (p95), driving', async () => {
    const a = openRoad();
    const { net, session, client } = await setup(a, { x: -57.5, z: -80 }, 75);
    const rnd = prng(2);
    play(net, session, 500, () => N, rnd);
    const ev = play(net, session, 100, () => ({ ...N, use: true }), rnd).flatMap((f) => f.events);
    expect(ev).toContainEqual({ t: 'enter', id: ME, car: 0 });
    play(net, session, 1500, () => N, rnd); // engine starts
    // a left-hand circle of ~30 m radius at full speed, inside the lawn
    const frames = play(net, session, 20_000, () => {
      const p = client.player(ME);
      return { ...N, forward: 1, right: -0.6, yaw: p.car ? headingOf(p.car) : 0 };
    }, rnd);
    expect(client.player(ME).mode).toBe('drive');
    expect(p95(frames.map((f) => f.correction))).toBeLessThan(0.2);
    expect(p95(frames.map((f) => f.predErrorM))).toBeLessThan(0.2);
    const p = client.player(ME).pos;
    expect(Math.hypot(p.x + 60, p.z + 80)).toBeGreaterThan(10);
  }, 60_000);

  test('more than MAX_REPLAY_STEPS pending → hard set', async () => {
    const { net, session, client, server } = await setup(fixtureAssets(), { x: -70, z: -70 }, 75);
    const rnd = prng(3);
    const walk = () => ({ ...N, forward: 1 });
    play(net, session, 1000, walk, rnd);
    net.hold = true;
    play(net, session, 100, walk, rnd); // snapshots already on their way still arrive
    const replay = vi.spyOn(client, 'replay');
    play(net, session, 2000, walk, rnd);
    expect(replay).not.toHaveBeenCalled();
    net.hold = false;
    // the next snapshot: 2 s of inputs never reached the server, far beyond MAX_REPLAY_STEPS
    while (replay.mock.calls.length === 0) play(net, session, 5, walk, rnd);
    expect(replay.mock.calls[0]![2]).toHaveLength(0);
    // set onto the server's state at that snapshot: from there on, normal replays again
    play(net, session, 500, walk, rnd);
    expect(replay.mock.calls.at(-1)![2].length).toBeGreaterThan(0);
    expect(replay.mock.calls.at(-1)![2].length).toBeLessThanOrEqual(20);
    const c = client.player(ME).pos, s = server.player(ME).pos;
    expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeLessThan(1);
  }, 60_000);

  test('denied enter is rolled back', async () => {
    const a = fixtureAssets();
    const car = 0;
    const { net, session, client, server } = await setup(a, leftOf({ ...fixtureCarPose(a, car) }, 2.5), 75);
    server.addPlayer(OTHER, leftOf(fixtureCarPose(a, car), -2.5));
    const rnd = prng(4);
    play(net, session, 1000, () => N, rnd);
    expect(client.cars.driver[car]).toBe(null);

    // OTHER presses E at the server two ticks from now; our E reaches the server ~75 ms later
    const otherUse = server.tick + 2;
    net.others = (tick) => new Map([[OTHER, tick === otherUse ? { ...N, use: true } : N]]);
    const first = session.frame(0.017, { ...N, use: true });
    net.advanceTo(net.t + 17);
    expect([...first, ...play(net, session, 50, () => N, rnd).flatMap((f) => f.events)]).toContainEqual({ t: 'enter', id: ME, car });
    expect(client.player(ME).mode).toBe('drive'); // predicted

    const ev = play(net, session, 1000, () => N, rnd).flatMap((f) => f.events);
    expect(server.player(OTHER).carId).toBe(car);
    expect(server.player(ME).mode).toBe('walk');
    expect(ev.filter((e) => e.t === 'enterDenied')).toEqual([{ t: 'enterDenied', id: ME }]);
    expect(ev.filter((e) => e.t === 'exit')).toEqual([{ t: 'exit', id: ME, car }]);
    expect(client.player(ME).mode).toBe('walk');
    // the car is OTHER's now: taken in the prediction world and following the server's pose
    expect(client.cars.driver[car]).toBe(OTHER);
    expect(client.cars.following().has(car)).toBe(true);
    const c = client.player(ME).pos, s = server.player(ME).pos;
    expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeLessThan(0.2);
  }, 60_000);
});

describe('OnlineSession lamps', () => {
  /** Car 0 at (30, −40) facing +z, straight at lamp 0 (30, 0); drives into it at full throttle. Returns the frames. */
  async function ram(serverLamps: boolean) {
    const a = fixtureAssets();
    a.manifest.parked[0] = { x: 30, z: -40, heading: 0, color: 0xff0000 };
    const sa = fixtureAssets();
    sa.manifest.parked[0] = a.manifest.parked[0];
    if (!serverLamps) sa.manifest.lamps = [];
    const { net, session, client, server } = await setup(a, { x: 32.5, z: -40 }, 75, sa);
    const rnd = prng(5);
    play(net, session, 300, () => N, rnd);
    play(net, session, 50, () => ({ ...N, use: true }), rnd);
    play(net, session, 1500, () => N, rnd);
    const frames = play(net, session, 6000, () => ({ ...N, forward: 1 }), rnd, () => client.props.isStanding(0));
    return { frames, client, server, net, session, rnd };
  }

  test('a lamp knocked over in the prediction stays down once the server reports it', async () => {
    const { frames, client, server, net, session, rnd } = await ram(true);
    expect(frames.flatMap((f) => f.events)).toContainEqual({ t: 'lamp', i: 0 });
    expect(server.props.isStanding(0)).toBe(false);
    play(net, session, 2000, () => N, rnd);
    expect(client.props.isStanding(0)).toBe(false);
  }, 60_000);

  test('a lamp the server does not report as fallen stands up again', async () => {
    const { frames, client } = await ram(false);
    const fell = frames.findIndex((f) => f.events.some((e) => e.t === 'lamp' && e.i === 0));
    expect(fell).toBeGreaterThanOrEqual(0);
    // 1 s (60 steps) after it fell, not before
    const up = frames.findIndex((f, k) => k > fell && f.probe);
    expect(up).toBeGreaterThan(fell);
    expect(frames[up]!.t - frames[fell]!.t).toBeGreaterThan(950);
    expect(frames[up]!.t - frames[fell]!.t).toBeLessThan(1100);
    expect(client.props.isStanding(0)).toBe(true);
  }, 60_000);
});

function fixtureCarPose(a: WorldAssets, i: number): CarPose {
  const c = a.manifest.parked[i]!;
  return { x: c.x, y: 0, z: c.z, qx: 0, qy: Math.sin(c.heading / 2), qz: 0, qw: Math.cos(c.heading / 2) };
}
