import {
  CORRECTION_BLEND_S, FixedStepper, HARD_SNAP_M, MAX_INPUTS_PER_PACKET, MAX_REPLAY_STEPS, ownStateOf, TICK_HZ, TUNING,
  type CarPose, type IgnitionSave, type InputPacket, type PlayerId, type PlayerInput, type PropPose, type SimEvent,
  type Snapshot, type SnapshotCar, type SnapshotLamp, type SnapshotWalker, type StationId, type WorldSim,
} from '@nn/shared';
import type { RenderOffset, Session } from '../session';
import type { ServerClock } from './clock';
import type { NetState, Welcome } from './connection';
import { poseOps, SnapshotBuffer } from './interp';
import type { RemoteCarInfo } from '../remote/remote-players';

/** What OnlineSession uses of a Connection (tests put a fake server behind it). */
export interface NetLink {
  readonly clock: ServerClock;
  readonly welcome: Welcome;
  readonly rttMs: number;
  readonly state: NetState;
  sendInputs(p: InputPacket): void;
  sendRadio(s: StationId | null): void;
  onSnapshot(cb: (s: Snapshot) => void): () => void;
  onWelcome(cb: (w: Welcome) => void): () => void;
}

/** For the debug overlay: round trip, age of the newest snapshot, size of the last correction (m), players in the room. */
export type NetStats = { rttMs: number; snapshotAgeMs: number; predErrorM: number; players: number };

/** Remote entities at the render tick (keys as in the snapshot: p<slot>, c<car>, l<lamp>). */
export type RemoteSample = {
  walkers: Map<string, SnapshotWalker>; cars: Map<string, SnapshotCar>; lamps: Map<string, SnapshotLamp>;
};

/** Slow-state facts the renderer needs: names by slot, and per car its driver (slot) and lamp level. */
export type Roster = { names: Map<number, string>; cars: Map<number, RemoteCarInfo> };

type Vec3 = { x: number; y: number; z: number };
type Quat = { x: number; y: number; z: number; w: number };
/** An input not yet acknowledged, with what the prediction made of it (state after its step). */
type Pending = { seq: number; input: PlayerInput; pos: Vec3; car: number | null; ign: IgnitionSave | null };

/** Unacknowledged inputs kept (2 s); older ones fall out (a gap that large is set hard anyway). */
const RING = 120;
/** Snapshots held between two frames at most (a hidden tab does not render). */
const INBOX = 40;
/** A lamp down in the prediction world that the server does not report as fallen for this many steps stands up (1 s). */
const LAMP_CONFIRM_STEPS = TICK_HZ;
/** Exponential fade of the render offset: e^−3 ≈ 5 % is left after CORRECTION_BLEND_S. */
const BLEND_RATE = 3 / CORRECTION_BLEND_S;

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qconj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const poseOf = (p: CarPose | PropPose): CarPose => ({ x: p.x, y: p.y, z: p.z, qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw });

/**
 * Online play: the local WorldSim is a prediction world. The own figure / car is simulated at once with every input
 * (numbered with seq, kept until the server acknowledges it); other players are kinematic stand-ins on the
 * interpolated snapshot poses (WorldSim.setProxies). Each snapshot resets the own state to the server's at ackSeq and
 * replays the unacknowledged inputs (WorldSim.replay); the difference to the old prediction fades out of the rendered
 * pose over CORRECTION_BLEND_S. More than MAX_REPLAY_STEPS inputs outstanding or an error above HARD_SNAP_M: set hard.
 *
 * seq keeps increasing for the whole page session, across reconnects (the server drops seq ≤ the last one it queued).
 */
export class OnlineSession implements Session {
  readonly me: PlayerId;
  steps = 0;
  onStep: (() => void) | null = null;
  onCorrection: (() => void) | null = null;
  /** How far (m) corrections moved the rendered own pose in the last frame (fade-out step, or a hard set). */
  correction = 0;
  private readonly stepper = new FixedStepper(TUNING.world.dt, 5);
  /** use/jump pressed but not yet sent in a step (one-tick pulses, as offline). */
  private use = false;
  private jump = false;
  private seq = 0;
  private pending: Pending[] = [];
  /** The newest acknowledged input (a later snapshot may acknowledge the same seq again). */
  private acked: Pending | null = null;
  private inbox: Snapshot[] = [];
  /** No snapshot reconciled yet: the first one sets hard (the local spawn is only a guess). */
  private first = true;
  /** seq of a predicted getting-in the server has not acknowledged yet. */
  private enterSeq: number | null = null;
  private predErrorM = 0;
  private lastSnapshotMs: number | null = null;
  private readonly walkerBuf = new SnapshotBuffer<SnapshotWalker>(poseOps());
  private readonly carBuf = new SnapshotBuffer<SnapshotCar>(poseOps());
  private readonly lampBuf = new SnapshotBuffer<SnapshotLamp>(poseOps());
  private sample: RemoteSample = { walkers: new Map(), cars: new Map(), lamps: new Map() };
  private readonly rosterNow: Roster = { names: new Map(), cars: new Map() };
  private readonly offset: RenderOffset = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  /** Lamps down in the prediction world → the step the server last reported them fallen (or they fell locally). */
  private readonly lampSeen = new Map<number, number>();
  private readonly now: () => number;
  private readonly unsubscribe: (() => void)[];

  constructor(readonly sim: WorldSim, private readonly link: NetLink, opts: { now?: () => number } = {}) {
    this.me = link.welcome.slot;
    this.now = opts.now ?? (() => performance.now());
    this.unsubscribe = [
      link.onSnapshot((s) => {
        this.inbox.push(s);
        if (this.inbox.length > INBOX) this.inbox.shift();
        this.lastSnapshotMs = this.now();
      }),
      link.onWelcome((w) => {
        // after a reconnect the server's clock and the remote entities start over
        this.walkerBuf.clear();
        this.carBuf.clear();
        this.lampBuf.clear();
        link.clock.reset();
        link.clock.onSnapshot(w.tick, this.now());
      }),
    ];
  }

  get alpha(): number {
    return this.stepper.alpha;
  }

  renderOffset(): RenderOffset {
    return this.offset;
  }

  /** Remote players, cars and tipping lamps as sampled for this frame (at the render tick). */
  remote(): RemoteSample {
    return this.sample;
  }

  /** Names and car occupancy from the slow state, as of this frame. */
  roster(): Roster {
    return this.rosterNow;
  }

  stats(): NetStats {
    let players = 0;
    this.link.state.players.forEach(() => { players++; });
    return {
      rttMs: this.link.rttMs,
      snapshotAgeMs: this.lastSnapshotMs === null ? Infinity : this.now() - this.lastSnapshotMs,
      predErrorM: this.predErrorM,
      players,
    };
  }

  /** Stops listening to the connection. */
  dispose(): void {
    for (const u of this.unsubscribe) u();
  }

  frame(dt: number, input: PlayerInput, radioCmd?: StationId | null): SimEvent[] {
    const ev: SimEvent[] = [];
    const offStart = { x: this.offset.x, y: this.offset.y, z: this.offset.z };
    const moved = this.receive(ev);
    if (radioCmd !== undefined) {
      this.sim.setRadio(this.me, radioCmd);
      this.link.sendRadio(radioCmd);
    }
    this.updateRemote(ev);

    this.use ||= input.use;
    this.jump ||= input.jump;
    const sent: Pending[] = [];
    this.stepper.advance(dt, () => {
      const i: PlayerInput = { ...input, use: this.use, jump: this.jump };
      this.use = this.jump = false;
      const seq = ++this.seq;
      for (const e of this.sim.step(new Map([[this.me, i]]))) {
        ev.push(e);
        if (e.t === 'enter' && e.id === this.me) this.enterSeq = seq;
        else if (e.t === 'lamp') this.lampSeen.set(e.i, this.steps);
      }
      const p: Pending = { seq, input: i, ...this.ownSample() };
      this.pending.push(p);
      if (this.pending.length > RING) this.pending.shift();
      sent.push(p);
      this.steps++;
      this.onStep?.();
    });
    const tick = Math.max(0, Math.round(this.link.clock.estimate(this.now())));
    for (let k = 0; k < sent.length; k += MAX_INPUTS_PER_PACKET) {
      const chunk = sent.slice(k, k + MAX_INPUTS_PER_PACKET);
      this.link.sendInputs({ seq: chunk[0]!.seq, tick, inputs: chunk.map((p) => p.input) });
    }

    this.fade(dt);
    if (moved === 'mode') this.correction = 0;
    else {
      const d = moved ?? { x: 0, y: 0, z: 0 };
      const o = this.offset;
      this.correction = Math.hypot(d.x + o.x - offStart.x, d.y + o.y - offStart.y, d.z + o.z - offStart.z);
    }
    return ev;
  }

  /**
   * Snapshots that came in since the last frame: remote entities into the buffers, the newest one reconciled.
   * Returns how far the own entity moved, or 'mode' if it got in or out of a car (no fade across that).
   */
  private receive(ev: SimEvent[]): Vec3 | 'mode' | null {
    if (!this.inbox.length) return null;
    const snaps = this.inbox;
    this.inbox = [];
    for (const s of snaps) {
      this.walkerBuf.push(s.serverTick, new Map(s.walkers.map((w) => [`p${w.slot}`, w])));
      this.carBuf.push(s.serverTick, new Map(s.cars.map((c) => [`c${c.id}`, c])));
      this.lampBuf.push(s.serverTick, new Map(s.lamps.map((l) => [`l${l.i}`, l])));
      for (const e of s.events) if (e.t === 'lamp' && this.lampSeen.has(e.i)) this.lampSeen.set(e.i, this.steps);
    }
    return this.reconcile(snaps[snaps.length - 1]!, ev);
  }

  private reconcile(s: Snapshot, ev: SimEvent[]): Vec3 | 'mode' {
    const ack = s.ackSeq;
    let ackEntry = this.acked?.seq === ack ? this.acked : null;
    while (this.pending.length && this.pending[0]!.seq <= ack) {
      const e = this.pending.shift()!;
      if (e.seq === ack) ackEntry = e;
      this.acked = e;
    }
    const server = ownStateOf(s.own);
    if (ackEntry) {
      server.use = ackEntry.input.use;
      server.jump = ackEntry.input.jump;
      if (server.carId !== null && ackEntry.car === server.carId && ackEntry.ign && ackEntry.ign.s === server.engine) server.ignition = ackEntry.ign;
    }
    let denied = false;
    if (this.enterSeq !== null && ack >= this.enterSeq) {
      denied = server.mode !== 'drive';
      this.enterSeq = null;
    }
    // error of the prediction for the acknowledged input (only comparable in the same car / on foot)
    const err = ackEntry && ackEntry.car === server.carId ? dist(ackEntry.pos, server.car ?? server.char) : 0;
    const hard = this.first || this.pending.length > MAX_REPLAY_STEPS || err > HARD_SNAP_M;
    this.first = false;

    const before = this.ownPose();
    if (hard) {
      this.pending = [];
      this.enterSeq = null;
      this.sim.replay(this.me, server, []);
    } else {
      this.sim.replay(this.me, server, this.pending.map((p) => p.input), (k) => Object.assign(this.pending[k]!, this.ownSample()));
    }
    const after = this.ownPose();
    this.onCorrection?.();

    if (before.car !== after.car) {
      if (before.car !== null) ev.push({ t: 'exit', id: this.me, car: before.car });
      if (denied) ev.push({ t: 'enterDenied', id: this.me });
      if (after.car !== null) ev.push({ t: 'enter', id: this.me, car: after.car });
      this.clearOffset();
      return 'mode';
    }
    const d = { x: after.pos.x - before.pos.x, y: after.pos.y - before.pos.y, z: after.pos.z - before.pos.z };
    this.predErrorM = Math.hypot(d.x, d.y, d.z);
    if (hard || this.predErrorM > HARD_SNAP_M) {
      this.clearOffset();
      return d;
    }
    // rendered = offset + predicted must stay where it was: offset' = offset − d, rot' = rot · before · after⁻¹
    const o = this.offset;
    o.x -= d.x; o.y -= d.y; o.z -= d.z;
    if (before.q && after.q) {
      const r = qmul(qmul({ x: o.qx, y: o.qy, z: o.qz, w: o.qw }, before.q), qconj(after.q));
      o.qx = r.x; o.qy = r.y; o.qz = r.z; o.qw = r.w;
    }
    return d;
  }

  /**
   * Remote entities at the render tick: other people and streamed cars become stand-ins in the prediction world
   * (cars taken according to the slow state), fallen lamps follow the server's pose; a lamp the prediction knocked
   * over that the server does not report within LAMP_CONFIRM_STEPS stands up again.
   */
  private updateRemote(ev: SimEvent[]): void {
    const rt = this.link.clock.renderTick(this.now());
    const walkers = this.walkerBuf.sample(rt), cars = this.carBuf.sample(rt), lamps = this.lampBuf.sample(rt);
    this.sample = { walkers, cars, lamps };
    const state = this.link.state;

    const feet = new Map<PlayerId, Vec3>();
    for (const w of walkers.values()) if (w.slot !== this.me) feet.set(w.slot, w);
    const poses = new Map<number, CarPose>();
    for (const c of cars.values()) poses.set(c.id, poseOf(c));
    const drivers = new Map<number, PlayerId>();
    const { names, cars: info } = this.rosterNow;
    names.clear();
    info.clear();
    state.players.forEach((p) => { names.set(p.slot, p.name); });
    state.cars.forEach((c, key) => {
      if (c.driver < 0) return;
      info.set(Number(key), { driver: c.driver, level: !c.lights ? 0 : c.engine === 2 ? 1 : 0.5 });
      if (c.driver !== this.me) drivers.set(Number(key), c.driver);
    });
    this.sim.setRemoteDrivers(drivers);
    this.sim.setProxies(feet, poses, (i) => {
      const c = state.cars.get(String(i));
      return c ? poseOf(c) : null;
    });

    const props = this.sim.props;
    const fallen = (i: number, pose: PropPose): void => {
      if (props.isStanding(i)) ev.push({ t: 'lamp', i });
      props.follow(i, poseOf(pose));
      this.lampSeen.set(i, this.steps);
    };
    for (const l of lamps.values()) fallen(l.i, l);
    state.lamps.forEach((l, key) => { if (!lamps.has(`l${key}`)) fallen(Number(key), l); });
    for (const [i, at] of this.lampSeen) {
      if (this.steps - at < LAMP_CONFIRM_STEPS) continue;
      props.standUp(i);
      this.lampSeen.delete(i);
    }
  }

  /** The render offset fades towards zero (position and rotation). */
  private fade(dt: number): void {
    const k = Math.exp(-BLEND_RATE * Math.max(0, dt));
    const o = this.offset;
    o.x *= k; o.y *= k; o.z *= k;
    // nlerp from identity to the rotation offset by k
    const sign = o.qw < 0 ? -1 : 1;
    const qx = sign * o.qx * k, qy = sign * o.qy * k, qz = sign * o.qz * k, qw = 1 - k + sign * o.qw * k;
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    o.qx = qx / n; o.qy = qy / n; o.qz = qz / n; o.qw = qw / n;
  }

  private clearOffset(): void {
    Object.assign(this.offset, { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 });
  }

  /** The own entity now: feet on foot, chassis centre and rotation in a car. */
  private ownPose(): { car: number | null; pos: Vec3; q: Quat | null } {
    const p = this.sim.player(this.me);
    if (p.carId === null) return { car: null, pos: p.pos, q: null };
    const c = this.sim.cars.vehicle(p.carId)!.pose();
    return { car: p.carId, pos: { x: c.x, y: c.y, z: c.z }, q: { x: c.qx, y: c.qy, z: c.qz, w: c.qw } };
  }

  /** What a pending input keeps of the state after its step. */
  private ownSample(): Omit<Pending, 'seq' | 'input'> {
    const p = this.sim.player(this.me);
    return { pos: p.pos, car: p.carId, ign: p.carId !== null ? this.sim.ignition(p.carId).save() : null };
  }
}
