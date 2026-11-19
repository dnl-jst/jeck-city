import { describe, expect, test, vi } from 'vitest';
import {
  buildSnapshot, decodeInputs, decodeSnapshot, encodeInputs, encodeSnapshot, headingOf, Interest, NEUTRAL_INPUT,
  WorldSim, type BikePose, type CarPose, type InputPacket, type PlayerInput, type SimEvent, type WorldAssets,
} from '@nn/shared';
import { fixtureAssets } from '../../../../packages/shared/src/sim/fixture.test-util';
import { ServerClock } from './clock';
import type { NetState } from './connection';
import { OnlineSession, remoteList, type NetLink } from './online-session';
import { InputQueue } from '../../../server/src/inputs';

const ME = 1, OTHER = 2;
const TICK_MS = 1000 / 60;
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
 * way; the server steps at 60 Hz in simulated time, takes ME's input from the server's InputQueue each tick, and
 * sends a snapshot plus the slow-state mirror every 3rd tick.
 */
class FakeNet {
  t = 0;
  /** Link stalled: inputs and snapshots sent meanwhile are lost. */
  hold = false;
  /**
   * A busy main thread (slow frames): the browser runs the next frame before the message tasks queued meanwhile, so a
   * snapshot reaches the session one frame later than it arrived. play() releases them.
   */
  starved = false;
  private held: { at: number; deliver: () => void }[] = [];
  /** Whether the next message in direction `dir` is stalled (lost and resent, as NN_FAKE_LAG's stall percentage). */
  stall: ((dir: 'up' | 'down') => boolean) | null = null;
  private readonly lastDue = { up: 0, down: 0 };
  /** Inputs of the server-side players other than ME, per tick. */
  others: (tick: number) => Map<number, PlayerInput> = () => new Map();
  readonly link: NetLink;
  private readonly queue = new InputQueue(0);
  private nextTick = TICK_MS;
  private events: SimEvent[] = [];
  private readonly interest = new Interest();
  private mail: Mail[] = [];
  private readonly listeners = new Set<(s: ReturnType<typeof decodeSnapshot> & object) => void>();
  private mirror = { players: new Map(), cars: new Map(), bikes: new Map(), lamps: new Map() };
  private lastCars = new Map<string, Pose>();
  private lastBikes = new Map<string, BikePose>();
  /** Cars left out of the snapshots (as if out of the client's interest). */
  hiddenCars = new Set<number>();

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
        this.post(() => this.receive(decodeInputs(bytes)!), 'up');
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

  private post(run: () => void, dir: 'up' | 'down'): void {
    // as the server's fake lag: a stalled message waits 200 ms more, and nothing overtakes it (TCP)
    const at = Math.max(this.t + this.oneWayMs + (this.stall?.(dir) ? 200 : 0), this.lastDue[dir]);
    this.lastDue[dir] = at;
    this.mail.push({ at, run });
  }

  private receive(p: InputPacket): void {
    this.queue.push(p, this.t);
  }

  private tick(): void {
    const s = this.server;
    const inputs = this.others(s.tick);
    inputs.set(ME, this.queue.next());
    this.events.push(...s.step(inputs));
    if (s.tick % 3 !== 0) return;
    const snap = buildSnapshot(s, ME, this.interest, this.queue.ackSeq, this.events, (id) => id);
    snap.cars = snap.cars.filter((c) => !this.hiddenCars.has(c.id));
    const bytes = encodeSnapshot(snap);
    this.events = [];
    const mirror = this.slowState();
    if (this.hold) return;
    this.post(() => {
      const snap = decodeSnapshot(bytes)!;
      this.link.clock.onSnapshot(snap.serverTick, this.t);
      const deliver = () => {
        this.mirror = mirror;
        for (const cb of this.listeners) cb(snap);
      };
      if (this.starved) this.held.push({ at: this.t, deliver });
      else deliver();
    }, 'down');
  }

  /** Starved: hands the session the snapshots that arrived up to `ms`. */
  release(ms: number): void {
    const due = this.held.filter((h) => h.at <= ms);
    this.held = this.held.filter((h) => h.at > ms);
    for (const h of due) h.deliver();
  }

  /** What the Colyseus state would hold (as the room's syncState). */
  private slowState() {
    const s = this.server;
    const pose = (p: CarPose): Pose => ({ x: p.x, y: p.y, z: p.z, qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw });
    const players = new Map<string, unknown>();
    for (const id of s.players()) {
      const p = s.player(id);
      players.set(String(id), {
        slot: id, name: `p${id}`, mode: { walk: 0, drive: 1, down: 2, ride: 3, sit: 4 }[p.mode], carId: p.carId ?? p.pass?.car ?? -1, seat: p.carId !== null ? 0 : p.pass?.seat ?? -1, bikeId: p.bikeId ?? -1, variant: 0,
      });
    }
    // a car's pose is written when the entry appears and while the car is at rest (as the room's syncState)
    const cars = new Map<string, Pose & { driver: number; engine: number; lights: boolean; radio: string }>();
    for (let i = 0; i < s.cars.count; i++) {
      if (!s.cars.occupied(i) && !s.cars.isMoved(i)) continue;
      const v = s.cars.vehicle(i), prev = this.lastCars.get(String(i));
      const at = !prev || !v || v.chassis.isSleeping() ? pose(v ? v.pose() : s.cars.poses[i]!) : pose(prev);
      cars.set(String(i), { driver: s.cars.driver[i] ?? -1, engine: 0, lights: false, radio: '', ...at });
    }
    this.lastCars = cars;
    const lamps = new Map<string, unknown>();
    for (const i of s.lampsDown()) if (s.lampState(i) === 'lying') lamps.set(String(i), s.props.lampPose(i));
    // likewise a bike's pose: when the entry appears and while it is unridden and not rolling
    const bikes = new Map<string, BikePose & { rider: number }>(), rolling = new Set(s.bikes.awake());
    s.bikes.poses.forEach((b, i) => {
      if (s.bikes.rider[i] === null && !s.bikes.isMoved(i)) return;
      const prev = this.lastBikes.get(String(i));
      const at = !prev || (s.bikes.rider[i] === null && !rolling.has(i)) ? b : prev;
      bikes.set(String(i), { rider: s.bikes.rider[i] ?? -1, x: at.x, y: at.y, z: at.z, heading: at.heading });
    });
    this.lastBikes = bikes;
    return { players, cars, bikes, lamps };
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

type Frame = { t: number; events: SimEvent[]; correction: number; predErrorM: number; probe: boolean; steps: number };

/**
 * Plays `ms` of frames with 12–21 ms frame times (60 fps on average; `frameMs` sets other bounds); input(t) is the
 * input of the frame at t.
 */
function play(
  net: FakeNet, session: OnlineSession, ms: number, input: (t: number) => PlayerInput, rnd: () => number, probe = () => false,
  frameMs: [number, number] = [12, 21.33],
): Frame[] {
  const out: Frame[] = [];
  const end = net.t + ms;
  while (net.t < end) {
    const dt = frameMs[0] + rnd() * (frameMs[1] - frameMs[0]);
    const prev = net.t;
    net.advanceTo(net.t + dt);
    net.release(prev);
    const steps = session.steps;
    const events = session.frame(Math.min(dt, 100) / 1000, input(net.t)); // main.ts clamps frame time to 0.1 s
    out.push({ t: net.t, events, correction: session.correction, predErrorM: session.stats().predErrorM, probe: probe(), steps: session.steps - steps });
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
    // most snapshots find the prediction at ackSeq right: no replay
    expect(session.reconciles.skipped).toBeGreaterThan(3 * session.reconciles.replayed);
  }, 60_000);

  test('150 ms RTT: no correction jump > 0.2 m (p95), driving', async () => {
    const a = openRoad();
    const { net, session, client } = await setup(a, { x: -57.5, z: -80 }, 75);
    const rnd = prng(2);
    play(net, session, 500, () => N, rnd);
    const ev = play(net, session, 100, () => ({ ...N, use: true }), rnd).flatMap((f) => f.events);
    expect(ev).toContainEqual({ t: 'enter', id: ME, car: 0, seat: 0 });
    play(net, session, 7000, () => N, rnd); // walks to the door, gets in, the engine starts
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
    // most snapshots find the prediction at ackSeq right: no replay
    expect(session.reconciles.skipped).toBeGreaterThan(3 * session.reconciles.replayed);
  }, 60_000);

  test('slow renderer (9–11 fps, steps sent bunched, snapshots seen a frame late) at 150 ms RTT: correction per step p95 ≤ 0.2 m, driving', async () => {
    const { net, session, client } = await setup(openRoad(), { x: -57.5, z: -80 }, 75);
    const rnd = prng(9);
    const slow: [number, number] = [90, 133];
    net.starved = true;

    play(net, session, 500, () => N, rnd, undefined, slow);
    const ev = play(net, session, 1, () => ({ ...N, use: true }), rnd, undefined, slow).flatMap((f) => f.events); // one frame
    expect(ev).toContainEqual({ t: 'enter', id: ME, car: 0, seat: 0 });
    play(net, session, 1500, () => N, rnd, undefined, slow);
    const replay = vi.spyOn(client, 'replay');
    const frames = play(net, session, 20_000, () => {
      const p = client.player(ME);
      return { ...N, forward: 1, right: -0.6, yaw: p.car ? headingOf(p.car) : 0 };
    }, rnd, undefined, slow);
    expect(client.player(ME).mode).toBe('drive');
    // every snapshot is reconciled by replaying (inputs sent, still queued at the server, and in flight exceed 20)
    expect(replay.mock.calls.filter((c) => c[2].length === 0)).toEqual([]);
    expect(p95(frames.map((f) => f.correction / Math.max(1, f.steps)))).toBeLessThan(0.2);
    const p = client.player(ME).pos;
    expect(Math.hypot(p.x + 60, p.z + 80)).toBeGreaterThan(10);
  }, 60_000);

  test('slow renderer at 150 ms RTT: a stalled input packet does not throw the prediction away', async () => {
    const { net, session, client } = await setup(fixtureAssets(), { x: -70, z: -70 }, 75);
    const rnd = prng(11);
    const slow: [number, number] = [90, 110];
    net.starved = true;
    const run = () => ({ ...N, forward: 1, run: true });
    play(net, session, 2000, run, rnd, undefined, slow);
    const replay = vi.spyOn(client, 'replay');
    // one input packet waits 200 ms longer (a lost TCP segment), the ones after it queue up behind it
    let stalled = false;
    net.stall = (dir) => dir === 'up' && !stalled && (stalled = true);
    const frames = play(net, session, 5000, run, rnd, undefined, slow);
    // inputs in flight, held at the server, and sent while the snapshot waited: more than 20, still replayed
    const lens = replay.mock.calls.map((c) => c[2].length);
    expect(lens.every((n) => n > 0)).toBe(true);
    expect(Math.max(...lens)).toBeGreaterThan(20);
    expect(Math.max(...frames.map((f) => f.correction))).toBeLessThan(1);
    // the backlog the late packet left at the server is trimmed again
    expect(lens.at(-1)).toBeLessThan(20);
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

  test('large error hard-sets but keeps pending inputs', async () => {
    const { net, session, client, server } = await setup(fixtureAssets(), { x: -70, z: -70 }, 75);
    const rnd = prng(5);
    const run = () => ({ ...N, forward: 1, run: true });
    play(net, session, 1500, run, rnd);
    // the server puts us 3 m to the side (as a server-side push would): a correction above HARD_SNAP_M
    const p = server.player(ME).pos;
    server.removePlayer(ME);
    server.addPlayer(ME, { x: p.x + 3, z: p.z });
    const frames = play(net, session, 1500, run, rnd);
    const jump = frames.findIndex((f) => f.correction > 2);
    expect(jump).toBeGreaterThanOrEqual(0);
    // one jump onto the server's path, inputs on top: the following snapshots bring no second correction (faded or not)
    // (predErrorM keeps the jump's size until the next reconciliation)
    const later = frames.slice(jump + 1);
    const next = later.findIndex((f) => f.predErrorM !== frames[jump]!.predErrorM);
    expect(next).toBeGreaterThanOrEqual(0);
    expect(Math.max(...later.map((f) => f.correction))).toBeLessThan(0.1);
    expect(Math.max(...later.slice(next).map((f) => f.predErrorM))).toBeLessThan(0.1);
    expect(session.reconciles.hard).toBe(2); // the first snapshot and this one
    const c = client.player(ME).pos, s = server.player(ME).pos;
    expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeLessThan(2);
  }, 60_000);

  test('losing the driver\'s seat to somebody quicker: the prediction is corrected to the seat the server gave', async () => {
    const a = fixtureAssets();
    const car = 0;
    const { net, session, client, server } = await setup(a, leftOf({ ...fixtureCarPose(a, car) }, 2.5), 75);
    const beside = leftOf(fixtureCarPose(a, car), 2.2);
    server.addPlayer(OTHER, { x: beside.x + 0.3, z: beside.z + 0.3 }); // at the driver's door too
    const rnd = prng(4);
    play(net, session, 1000, () => N, rnd);
    expect(client.cars.driver[car]).toBe(null);

    // OTHER presses E at the server two ticks from now; our E reaches the server ~75 ms later
    const otherUse = server.tick + 2;
    net.others = (tick) => new Map([[OTHER, tick === otherUse ? { ...N, use: true } : N]]);
    const first = session.frame(0.017, { ...N, use: true });
    net.advanceTo(net.t + 17);
    expect([...first, ...play(net, session, 50, () => N, rnd).flatMap((f) => f.events)]).toContainEqual({ t: 'enter', id: ME, car, seat: 0 });
    expect(client.player(ME).mode).toBe('drive'); // predicted

    const ev = play(net, session, 1000, () => N, rnd).flatMap((f) => f.events);
    expect(server.player(OTHER).carId).toBe(car);
    // the server seated us on another seat of the same car: out of the driver's seat, into that one
    const mine = server.player(ME).pass!;
    expect(mine.car).toBe(car);
    expect(mine.seat).toBeGreaterThan(0);
    expect(ev.filter((e) => e.t === 'enterDenied')).toEqual([]);
    expect(ev.filter((e) => e.t === 'exit')).toEqual([{ t: 'exit', id: ME, car, seat: 0 }]);
    expect(ev.filter((e) => e.t === 'enter')).toEqual([{ t: 'enter', id: ME, car, seat: mine.seat }]);
    expect(client.player(ME)).toMatchObject({ mode: 'sit', pass: mine });
    // the car is OTHER's now: taken in the prediction world and following the server's pose
    expect(client.cars.driver[car]).toBe(OTHER);
    expect(client.cars.following().has(car)).toBe(true);
  }, 60_000);
});

describe('OnlineSession bikes', () => {
  /** The fixture with bike 0 out on the open south-west lawn (−60, −80), facing +z. */
  function openLawnBike(): WorldAssets {
    const a = fixtureAssets();
    a.manifest.bikes = [{ x: -60, z: -80, heading: 0, type: 0, color: 0 }];
    return a;
  }

  test('150 ms RTT: no correction jump > 0.2 m (p95), riding', async () => {
    const { net, session, client } = await setup(openLawnBike(), { x: -59, z: -80 }, 75);
    const rnd = prng(6);
    play(net, session, 500, () => N, rnd);
    const ev = play(net, session, 100, () => ({ ...N, use: true }), rnd).flatMap((f) => f.events);
    expect(ev).toContainEqual({ t: 'mount', id: ME, bike: 0 });
    // a wide left-hand circle at cruising speed, with a hop now and then
    const frames = play(net, session, 15_000, (t) => {
      const p = client.player(ME);
      return { ...N, forward: 1, right: -0.3, jump: Math.floor(t / 3000) !== Math.floor((t - 20) / 3000), yaw: p.bike ? p.bike.heading : 0 };
    }, rnd);
    expect(client.player(ME).mode).toBe('ride');
    expect(frames.flatMap((f) => f.events).filter((e) => e.t === 'dismount' || e.t === 'mount')).toEqual([]);
    expect(p95(frames.map((f) => f.correction))).toBeLessThan(0.2);
    expect(p95(frames.map((f) => f.predErrorM))).toBeLessThan(0.2);
    const p = client.player(ME).pos;
    expect(Math.hypot(p.x + 60, p.z + 80)).toBeGreaterThan(5);
  }, 60_000);

  test('getting off a moved bike: it stays where it was left (the stale slow-state pose is not placed)', async () => {
    const { net, session, client, server } = await setup(openLawnBike(), { x: -59, z: -80 }, 75);
    const rnd = prng(14);
    play(net, session, 500, () => N, rnd);
    play(net, session, 100, () => ({ ...N, use: true }), rnd);
    expect(client.player(ME).mode).toBe('ride');
    play(net, session, 3000, () => ({ ...N, forward: 1, yaw: 0 }), rnd);
    // brake (back-pedal) until it stops, without pushing it backwards
    play(net, session, 3000, () => ({ ...N, forward: (client.player(ME).bike?.speed ?? 0) > 0.1 ? -1 : 0, yaw: 0 }), rnd);
    expect(Math.abs(client.player(ME).bike!.speed)).toBeLessThan(0.5);
    const left = { ...client.player(ME).bike! }, home = { x: -60, z: -80 };
    expect(Math.hypot(left.x - home.x, left.z - home.z)).toBeGreaterThan(5);
    play(net, session, 1, () => ({ ...N, use: true }), rnd); // one frame: a second pulse would get back on
    let worst = 0;
    play(net, session, 3000, () => N, rnd, () => {
      const b = client.bikes.poses[0]!;
      worst = Math.max(worst, Math.hypot(b.x - left.x, b.z - left.z));
      return false;
    });
    expect(client.player(ME).mode).toBe('walk');
    expect(server.player(ME).mode).toBe('walk');
    expect(worst).toBeLessThan(1);
    const c = client.bikes.poses[0]!, sv = server.bikes.poses[0]!;
    expect(Math.hypot(c.x - sv.x, c.z - sv.z)).toBeLessThan(0.05);
  }, 60_000);

  test('jumping off a moving bike: it rolls on and never snaps back to where it was mounted', async () => {
    const { net, session, client, server } = await setup(openLawnBike(), { x: -59, z: -80 }, 75);
    const rnd = prng(15);
    play(net, session, 500, () => N, rnd);
    play(net, session, 100, () => ({ ...N, use: true }), rnd);
    play(net, session, 3000, () => ({ ...N, forward: 1, yaw: 0 }), rnd);
    expect(client.player(ME).bike!.speed).toBeGreaterThan(4);
    play(net, session, 1, () => ({ ...N, use: true }), rnd);
    let nearest = Infinity;
    play(net, session, 4000, () => N, rnd, () => {
      const b = client.bikes.poses[0]!;
      nearest = Math.min(nearest, Math.hypot(b.x + 60, b.z + 80));
      return false;
    });
    expect(server.player(ME).mode).toBe('walk');
    expect(server.bikes.awake()).toEqual([]);
    expect(nearest).toBeGreaterThan(5);
    const c = client.bikes.poses[0]!, sv = server.bikes.poses[0]!;
    expect(Math.hypot(c.x - sv.x, c.z - sv.z)).toBeLessThan(0.05);
  }, 60_000);

  test('denied mount is rolled back', async () => {
    const a = fixtureAssets(); // bike 0 at (−6, −30) facing +z
    const { net, session, client, server } = await setup(a, { x: -5, z: -30 }, 75);
    server.addPlayer(OTHER, { x: -7, z: -30 });
    const rnd = prng(7);
    play(net, session, 1000, () => N, rnd);
    expect(client.bikes.rider[0]).toBe(null);

    // OTHER presses E at the server two ticks from now; our E reaches the server ~75 ms later
    const otherUse = server.tick + 2;
    net.others = (tick) => new Map([[OTHER, tick === otherUse ? { ...N, use: true } : N]]);
    const first = session.frame(0.017, { ...N, use: true });
    net.advanceTo(net.t + 17);
    expect([...first, ...play(net, session, 50, () => N, rnd).flatMap((f) => f.events)]).toContainEqual({ t: 'mount', id: ME, bike: 0 });
    expect(client.player(ME).mode).toBe('ride'); // predicted

    const ev = play(net, session, 1000, () => N, rnd).flatMap((f) => f.events);
    expect(server.player(OTHER).bikeId).toBe(0);
    expect(server.player(ME).mode).toBe('walk');
    expect(ev.filter((e) => e.t === 'mountDenied')).toEqual([{ t: 'mountDenied', id: ME }]);
    expect(ev.filter((e) => e.t === 'dismount')).toMatchObject([{ t: 'dismount', id: ME, bike: 0, crash: false }]);
    expect(client.player(ME).mode).toBe('walk');
    // the bike is OTHER's now: taken in the prediction world and following the server's pose
    expect(client.bikes.rider[0]).toBe(OTHER);
    expect(client.bikes.following().has(0)).toBe(true);
    const c = client.player(ME).pos, s = server.player(ME).pos;
    expect(Math.hypot(c.x - s.x, c.z - s.z)).toBeLessThan(0.2);
    // E again at the taken bike: refused at once by the prediction
    const again = play(net, session, 100, () => ({ ...N, use: true }), rnd).flatMap((f) => f.events);
    expect(again).toContainEqual({ t: 'mountDenied', id: ME });
    expect(client.player(ME).mode).toBe('walk');
  }, 60_000);
});

test('a bike moved before we joined is where the server has it', async () => {
  const { net, session, client, server } = await setup(fixtureAssets(), { x: -40, z: -70 }, 75);
  // before our first snapshot: OTHER rides bike 0 (−6, −30) 3 s north, stops and gets off; it rests there
  server.addPlayer(OTHER, { x: -5, z: -30 });
  const step = (i: PlayerInput, n = 1) => { for (let k = 0; k < n; k++) server.step(new Map([[OTHER, i]])); };
  step(N, 10);
  step({ ...N, use: true });
  step({ ...N, forward: 1 }, 180);
  step({ ...N, forward: -1 }, 120);
  step({ ...N, use: true });
  step(N, 240);
  expect(server.bikes.isMoved(0)).toBe(true);
  play(net, session, 1000, () => N, prng(8));
  const c = client.bikes.poses[0]!, sv = server.bikes.poses[0]!;
  expect(Math.hypot(c.x - sv.x, c.z - sv.z)).toBeLessThan(0.05);
}, 60_000);

describe('OnlineSession resting cars', () => {
  /** Shoves driverless car 0 on the server (it rolls a few metres and stops). */
  const shove = (server: WorldSim) => server.cars.vehicle(0)!.chassis.setLinvel({ x: 0, y: 0, z: 8 }, true);
  const gap = (client: WorldSim, server: WorldSim) => {
    const c = client.cars.vehicle(0)?.pose() ?? client.cars.poses[0]!, s = server.cars.vehicle(0)!.pose();
    return Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
  };

  test('a car moved before we joined is where the server has it; back home after the idle reset', async () => {
    const { net, session, client, server } = await setup(fixtureAssets(), { x: -20, z: -20 }, 75);
    server.step(new Map());
    shove(server);
    for (let k = 0; k < 600 && server.cars.awake().length; k++) server.step(new Map());
    expect(server.cars.awake()).toEqual([]);
    expect(server.cars.isMoved(0)).toBe(true);
    play(net, session, 1000, () => N, prng(10));
    expect(client.cars.vehicle(0)).not.toBeNull();
    expect(gap(client, server)).toBeLessThan(0.05);
    // the server puts it back (idle reset): the slow state drops it
    server.cars.reset(0);
    play(net, session, 1000, () => N, prng(11));
    const c = client.cars.vehicle(0)!.pose(), h = client.cars.homePose(0);
    expect(Math.hypot(c.x - h.x, c.z - h.z)).toBeLessThan(0.05);
  }, 60_000);

  test('getting out of a car that was moved: it stays where it was left (the stale slow-state pose is not placed)', async () => {
    const { net, session, client, server } = await setup(openRoad(), { x: -57.5, z: -80 }, 75);
    const rnd = prng(13);
    play(net, session, 500, () => N, rnd);
    play(net, session, 100, () => ({ ...N, use: true }), rnd);
    play(net, session, 7000, () => N, rnd); // walks to the door, gets in, the engine starts
    play(net, session, 2000, () => ({ ...N, forward: 1, yaw: headingOf(client.player(ME).car!) }), rnd);
    play(net, session, 6000, () => ({ ...N, brake: true, yaw: headingOf(client.player(ME).car!) }), rnd);
    expect(client.player(ME).mode).toBe('drive');
    const left = client.cars.vehicle(0)!.pose(), home = client.cars.homePose(0);
    expect(Math.hypot(left.x - home.x, left.z - home.z)).toBeGreaterThan(5);
    play(net, session, 100, () => ({ ...N, use: true }), rnd);
    let worst = 0;
    play(net, session, 3000, () => N, rnd, () => {
      const c = client.cars.vehicle(0)!.pose();
      worst = Math.max(worst, Math.hypot(c.x - left.x, c.z - left.z));
      return false;
    });
    expect(client.player(ME).mode).toBe('walk');
    expect(server.player(ME).mode).toBe('walk');
    expect(worst).toBeLessThan(0.5);
  }, 60_000);

  test('a car that leaves the interest set while rolling ends where the server lets it rest', async () => {
    const { net, session, client, server } = await setup(fixtureAssets(), { x: -20, z: -20 }, 75);
    const rnd = prng(12);
    play(net, session, 1000, () => N, rnd);
    shove(server);
    play(net, session, 300, () => N, rnd);
    expect(server.cars.awake()).toEqual([0]);
    expect(client.cars.following().has(0)).toBe(true);
    net.hiddenCars.add(0);
    play(net, session, 6000, () => N, rnd);
    expect(server.cars.awake()).toEqual([]);
    expect(client.cars.following().has(0)).toBe(false);
    expect(gap(client, server)).toBeLessThan(0.05);
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
    play(net, session, 7000, () => N, rnd); // walks to the door, gets in, the engine starts
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

describe('OnlineSession weather', () => {
  test('a state without the weather field (older server) means unknown weather, no throw', async () => {
    const { session } = await setup(fixtureAssets(), { x: -70, z: -70 }, 75);
    expect(session.weather()).toBeNull();
  });
});

describe('remoteList', () => {
  test('flattens walkers, riders and drivers; leaves out me; down while knocked over', () => {
    const w = (slot: number, state: 0 | 2) => [`w${slot}`, { slot, x: slot, y: 0, z: 2 * slot, yaw: 0, speed: 0, state }] as const;
    const sample = {
      walkers: new Map([w(1, 0), w(2, 2), w(9, 0)]),
      riders: new Map([['r3', { slot: 3, bikeId: 0, x: 30, y: 0, z: 31, heading: 0, speed: 0, steer: 0, pedalling: false, airborne: false }]]),
      cars: new Map([['c5', { id: 5, x: 50, y: 0, z: 51 }], ['c6', { id: 6, x: 60, y: 0, z: 61 }]]),
      bikes: new Map(), lamps: new Map(),
    } as unknown as Parameters<typeof remoteList>[0];
    const list = remoteList(sample, new Map([[1, 'Jupp'], [2, 'Else']]), new Map([[5, { driver: 4 }], [6, { driver: -1 }]]), 9);
    expect(list).toEqual([
      { slot: 1, name: 'Jupp', x: 1, z: 2, mode: 'walk' },
      { slot: 2, name: 'Else', x: 2, z: 4, mode: 'down' },
      { slot: 3, name: '', x: 30, z: 31, mode: 'ride' },
      { slot: 4, name: '', x: 50, z: 51, mode: 'drive' },
    ]);
  });
});
