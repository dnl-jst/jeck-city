import {
  KNOCKDOWN_KMH, KNOCKDOWN_S, NPC_DESPAWN, NPC_GIVE_UP_S, NPC_MAX, NPC_PLAN_LEAD_S, NPC_REACT_RADIUS, NPC_SAY_AFTER_S, NPC_SAY_COOLDOWN_S,
  NPC_SPAWN_FIRST_MIN, NPC_SPAWN_MAX, NPC_SPAWN_MIN, TICK_HZ,
} from '../net/constants';
import { linesFor } from '../npc/lines';
import type { NpcMsg } from '../npc/net';
import { GraphIndex, type NetLayer, type NpcNet } from '../npc/netgraph';
import { planAt, planDuration, rampsForLegs } from '../npc/plan';
import { pedSignalAt, signalAt } from '../npc/signals';
import type { NpcKind, NpcLook, PathPt, Plan } from '../npc/types';
import { JunctionTables, lightAllows, STOP_DECEL as STOP_DECEL_T } from './npc-junctions';
import { prng } from './prng';

/** NPCs wanted within 250 m of a player (at density 1): walkers, cyclists, drivers, and seat groups in parks. */
export const NPC_TARGETS = { walker: 40, cyclist: 10, driver: 20, groups: 6 } as const;
/** Radius (m) the targets count in. */
const AREA = 250;
/** How often (ticks) spawning, dissolving and small talk are checked. */
const CENSUS_EVERY = 15;
/** Most NPCs spawned per census. */
const SPAWN_PER_CENSUS = 8;
/** Below this share of its target an area counts as unpopulated (first visit, teleport): NPCs may appear closer. */
const POPULATED = 0.25;
/** Spawns stay out of ±60° around where a player looks. */
const VIEW_HALF = Math.PI / 3;
/** A plan covers at least this much way (m) per kind. */
const PLAN_MIN: Record<'walker' | 'cyclist' | 'driver', number> = { walker: 25, cyclist: 60, driver: 100 };
/** Speeds (m/s). */
const WALK_SPEED = [1.1, 1.6] as const, CYCLE_SPEED = [3.5, 6] as const;
const DRIVE_FAST = 50 / 3.6, DRIVE_SLOW = 30 / 3.6, DRIVE_TURN = 15 / 3.6, CYCLE_TURN = 3;
/** Lanes narrower than this (m) are side streets (30 km/h). */
const NARROW_LANE = 3.2;
const ACCEL: Record<'walker' | 'cyclist' | 'driver', number> = { walker: 1.5, cyclist: 1.5, driver: 2.5 };
/** Small talk: a seat ring with a player this close (m) says something every 20–40 s. */
const TALK_RADIUS = 30;
const TALK_MIN_S = 20, TALK_MAX_S = 40;
/** A vehicle never spawns closer than this (m) to another NPC on the same layer. */
const SPAWN_GAP = 8;

const TINTS = [0x2d3a4a, 0x7a2e2e, 0x3c5a3a, 0xc8b38a, 0x1f1f24, 0x5b4a7a, 0xa05a2c, 0x8a8f96, 0x2e5d8a, 0xd9d4c7, 0x6b3d52, 0x44606b];
const PAINT = [0xf2f2f2, 0x1c1c1e, 0x8c9198, 0x2a4a7a, 0x7a1f1f, 0x3d5c3a, 0xc9b27c, 0x5a5f66, 0x0f3057, 0xb8b8b8];

export type Focus = { x: number; z: number; heading: number };
/** A player as traffic sees it: position, velocity, on foot / in a car / on a bike. */
export type PlayerNear = { id: number; x: number; z: number; vx: number; vz: number; mode: 'walk' | 'drive' | 'ride' };
/** One edge (part) of a route: from distance `from` to `to` along the edge's points (to < from: against them). */
export type Leg = { edge: number; from: number; to: number; v: number };
export type NpcState = {
  id: number; kind: NpcKind; look: NpcLook; plan: Plan; layer: NetLayer | 'seat';
  /** The legs of the current plan, in order (moving NPCs). */
  legs: Leg[];
  /** Cruising speed (walkers, cyclists) or speed factor (drivers). */
  cruise: number;
  /** Tick at which the next plan is due. */
  nextPlanAt: number;
  /** Seat ring and seat (sitters). */
  ring?: number; seat?: number;
  /** Holding (stopping or standing) for traffic; since when it stands (tick) or null. */
  hold: boolean; waitingSince: number | null;
  /** Speed cap (m/s) while following a slower vehicle (Infinity: none). */
  cap: number;
  /** Tick of the last plan change made by traffic (rate limit). */
  lastTraffic: number;
  /** Overtaking until this tick (the plan runs on the oncoming lane). */
  overtakeUntil: number;
  /** While overtaking: the plan's path is longer than its legs by `extra` over its length `at` (legsFrom scales). */
  shift?: { extra: number; at: number };
  /** Blocked by a player since (tick) or null; tick it last said something. */
  blockedSince: number | null; saidAt: number;
  /** Knocked down: lying until this tick, then getting up until getupUntil (0: not). */
  downUntil: number; getupUntil: number;
};

/** What a body in the physics world needs of an NPC near a player. */
export type NpcBody = { id: number; kind: NpcKind; x: number; y: number; z: number; heading: number; pitch: number; vehicleType: number; lying: boolean };

const LAYER_OF: Record<'walker' | 'cyclist' | 'driver', NetLayer> = { walker: 'walk', cyclist: 'cycle', driver: 'drive' };

/** Traffic is checked every this many ticks per NPC (phase: id). */
const TRAFFIC_EVERY = 6;
/** Plan changes by traffic that are not needed for safety (resume, speed cap) at most this often (ticks). */
const TRAFFIC_CALM = 30;
/** Length and half width (m) of what traffic sees. */
const SIZE = { car: { len: 4.5, half: 0.95 }, bike: { len: 1.8, half: 0.4 }, person: { len: 0.6, half: 0.35 } } as const;
/** Gap (m) kept to the vehicle or person ahead, bumper to bumper. */
const GAP = { driver: 2.5, cyclist: 1.5, walker: 0.8 } as const;
/** Vehicles approaching a junction within this many seconds compete for it (right of way). */
const PRIORITY_ETA = 3;
/** Everyone waiting this long (ticks) at a junction without lights: the one waiting longest goes. */
const STANDOFF = 120;
/** A walker this close (m) to a signalled crossing waits for the green man. */
const PED_WAIT = 1.5;
/** Overtaking: lateral offset (m), lead-in/out length (m), clear oncoming lane ahead (m), no junction within (m). */
const OVERTAKE = { offset: 3, ramp: 15, clear: 120, junction: 30 };

/** pts from distance s along them on. */
function trimPath(pts: PathPt[], s: number): PathPt[] {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + l >= s) {
      const t = l > 0 ? (s - acc) / l : 0;
      return [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, ...pts.slice(i)];
    }
    acc += l;
  }
  return pts.slice(-1);
}

/** Points at most `step` m apart. */
function densifyPath(pts: PathPt[], step: number): PathPt[] {
  const out = pts.length ? [pts[0]!] : [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

const smooth = (k: number): number => k * k * (3 - 2 * k);

type Obstacle = { id: number; x: number; z: number; vx: number; vz: number; len: number; half: number; npc: NpcState | null; mode: 'walk' | 'drive' | 'ride' };
const OBST_CELL = 20;

/**
 * Spawns, routes and dissolves the NPCs around the players (foci), deterministically from its seed and the foci.
 * Every moving NPC follows a plan over a few edges of its graph; a new plan continuing the route is issued
 * NPC_PLAN_LEAD_S before the current one ends. Sitters sit on seat rings. update() returns the messages for the clients.
 */
export class NpcDirector {
  /** Target density factor 0.1..1 (the load brake). */
  density = 1;
  readonly ix: Record<NetLayer, GraphIndex>;
  private readonly npcs = new Map<number, NpcState>();
  private readonly rng: () => number;
  private nextId = 1;
  /** Ring → ids of its sitters. */
  private readonly rings = new Map<number, number[]>();
  /** Ring → tick of its next small talk. */
  private readonly talkAt = new Map<number, number>();
  private readonly slowEdges: Record<NetLayer, Set<number>>;
  readonly tables: JunctionTables;
  private players: PlayerNear[] = [];
  /** Positions of the moving NPCs and players, refreshed every TRAFFIC_EVERY ticks. */
  private obstacles: Obstacle[] = [];
  private obstacleGrid = new Map<string, Obstacle[]>();
  /** Turn arcs vehicles have committed to (past the point where they could still stop), by NPC id. */
  private readonly claims = new Map<number, { j: number; layer: 'drive' | 'cycle'; turn: number }>();
  /** Player id → the NPC scolding them and until when (one at a time). */
  private readonly scolding = new Map<number, { npc: number; until: number }>();

  constructor(readonly net: NpcNet, private readonly heightAt: (x: number, z: number, layer: NetLayer) => number, seed: number) {
    this.rng = prng(seed);
    this.ix = { walk: new GraphIndex(net.walk), drive: new GraphIndex(net.drive), cycle: new GraphIndex(net.cycle) };
    this.slowEdges = {
      walk: new Set(),
      drive: new Set(net.junctions.flatMap((j) => j.turns)),
      cycle: new Set(net.junctions.flatMap((j) => j.cycleTurns)),
    };
    this.tables = new JunctionTables(net);
  }

  /** The players traffic reacts to (set before update). */
  setPlayers(players: PlayerNear[]): void {
    this.players = players;
  }

  /** Conflicting turn edge pairs of junction j (drive layer). */
  turnConflicts(j: number): Set<string> {
    return this.tables.conflictSet(j, 'drive');
  }

  /** The leg n is on at tick (null for sitters). */
  currentLeg(n: NpcState, tick: number): Leg | null {
    if (!n.legs.length) return null;
    return this.legsFrom(n, planAt(n.plan, tick).s)[0] ?? null;
  }

  /**
   * Places an NPC on a route (tests, reactions): legs give edges and the distance to start from (to: the edge's end in
   * its direction unless given).
   */
  spawnAt(kind: 'walker' | 'cyclist' | 'driver', legs: { edge: number; from: number; to?: number }[], tick: number, cruise?: number): NpcState {
    const layer = LAYER_OF[kind];
    const id = this.nextId++;
    const look = this.lookFor(kind);
    const n = this.newMoving(id, kind, look, layer, cruise ?? this.cruiseFor(kind), tick);
    n.legs = legs.map((l) => {
      const to = l.to ?? this.ix[layer].length(l.edge);
      return { edge: l.edge, from: l.from, to, v: this.legSpeed(n, layer, l.edge) };
    });
    const first = n.legs[0]!;
    n.plan = { ...n.plan, action: 'move', path: [this.legPoints(layer, { ...first, to: first.from })[0]!], ramps: [{ s0: 0, s1: 0, v0: first.v, v1: first.v }] };
    this.npcs.set(id, n);
    this.extend(n, tick, []);
    return n;
  }

  private newMoving(id: number, kind: NpcKind, look: NpcLook, layer: NetLayer, cruise: number, tick: number): NpcState {
    return {
      id, kind, look, layer, legs: [], cruise, nextPlanAt: tick, hold: false, waitingSince: null, cap: Infinity, lastTraffic: -Infinity, overtakeUntil: -1,
      blockedSince: null, saidAt: -Infinity, downUntil: 0, getupUntil: 0,
      plan: { id, kind, look, startTick: tick, path: [], ramps: [], action: 'wait', seq: -1 },
    };
  }

  private cruiseFor(kind: 'walker' | 'cyclist' | 'driver'): number {
    if (kind === 'walker') return WALK_SPEED[0] + this.rng() * (WALK_SPEED[1] - WALK_SPEED[0]);
    if (kind === 'cyclist') return CYCLE_SPEED[0] + this.rng() * (CYCLE_SPEED[1] - CYCLE_SPEED[0]);
    return 0.9 + this.rng() * 0.15;
  }

  get count(): number {
    return this.npcs.size;
  }

  all(): Iterable<NpcState> {
    return this.npcs.values();
  }

  get(id: number): NpcState | undefined {
    return this.npcs.get(id);
  }

  /** NPCs within r (m) of (x, z) at tick. */
  near(x: number, z: number, r: number, tick: number): NpcState[] {
    const out: NpcState[] = [];
    for (const n of this.npcs.values()) {
      const p = planAt(n.plan, tick);
      if (Math.abs(p.x - x) <= r && Math.abs(p.z - z) <= r && Math.hypot(p.x - x, p.z - z) <= r) out.push(n);
    }
    return out;
  }

  /** One tick: due plans, and every CENSUS_EVERY ticks dissolving, spawning and small talk. */
  update(tick: number, foci: readonly Focus[]): NpcMsg[] {
    const msgs: NpcMsg[] = [];
    for (const n of this.npcs.values()) if (n.kind !== 'sitter' && !n.hold && tick >= n.nextPlanAt) this.extend(n, tick, msgs);
    if (tick % TRAFFIC_EVERY === 0) this.refreshObstacles(tick);
    this.knocks(tick, msgs);
    for (const n of [...this.npcs.values()]) this.timers(n, tick, msgs);
    const nearPlayers = this.nearPlayerIds();
    for (const n of [...this.npcs.values()]) {
      if (n.kind === 'sitter' || n.downUntil || n.getupUntil) continue;
      if ((n.id + tick) % TRAFFIC_EVERY === 0 || nearPlayers.has(n.id)) this.traffic(n, tick, msgs);
    }
    if (tick % CENSUS_EVERY === 0) this.census(tick, foci, msgs);
    return msgs;
  }

  /**
   * Replaces n's plan from `tick` on (reactions, traffic): the new plan starts at n's position then. legs: the route
   * it follows (with this.extend appending when it runs out). Returns the plan message.
   */
  replan(n: NpcState, tick: number, path: PathPt[], ramps: Plan['ramps'], action: Plan['action'], legs: Leg[] = n.legs): NpcMsg {
    n.plan = { id: n.id, kind: n.kind, look: n.look, startTick: tick, path, ramps, action, seq: n.plan.seq + 1 };
    n.legs = legs;
    n.shift = undefined;
    const d = planDuration(n.plan);
    n.nextPlanAt = Number.isFinite(d) ? tick + Math.max(1, d - NPC_PLAN_LEAD_S * TICK_HZ) : Infinity;
    return { t: 'plan', plan: n.plan };
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Points of edge `e` from distance `from` to `to` along it (either direction), with heights. */
  legPoints(layer: NetLayer, leg: Leg): PathPt[] {
    const e = this.net[layer].edges[leg.edge]!, cum = this.ix[layer].cum[leg.edge]!;
    const at = (s: number): PathPt => {
      let k = 1;
      while (k < e.pts.length - 1 && cum[k]! < s) k++;
      const [ax, az] = e.pts[k - 1]!, [bx, bz] = e.pts[k]!;
      const t = Math.max(0, Math.min(1, (s - cum[k - 1]!) / ((cum[k]! - cum[k - 1]!) || 1)));
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      return { x, y: this.heightAt(x, z, layer), z };
    };
    const out = [at(leg.from)];
    const lo = Math.min(leg.from, leg.to), hi = Math.max(leg.from, leg.to);
    const inner: number[] = [];
    for (let k = 1; k < e.pts.length - 1; k++) if (cum[k]! > lo + 1e-6 && cum[k]! < hi - 1e-6) inner.push(k);
    if (leg.to < leg.from) inner.reverse();
    for (const k of inner) {
      const [x, z] = e.pts[k]!;
      out.push({ x, y: this.heightAt(x, z, layer), z });
    }
    out.push(at(leg.to));
    return out;
  }

  /** Speed (m/s) of n on an edge. */
  private legSpeed(n: NpcState, layer: NetLayer, edge: number): number {
    if (n.kind === 'walker') return n.cruise;
    if (n.kind === 'cyclist') return this.slowEdges.cycle.has(edge) ? Math.min(CYCLE_TURN, n.cruise) : n.cruise;
    if (this.slowEdges[layer].has(edge)) return DRIVE_TURN;
    return (this.net.drive.edges[edge]!.width < NARROW_LANE ? DRIVE_SLOW : DRIVE_FAST) * n.cruise;
  }

  /** The edges a route may continue on from the end of `leg`: never straight back unless there is no other way. */
  nextLegs(layer: NetLayer, leg: Leg, n: NpcState): Leg[] {
    const g = this.net[layer], ix = this.ix[layer];
    const e = g.edges[leg.edge]!;
    const node = leg.to >= leg.from ? e.b : e.a;
    const make = (i: number): Leg => {
      const f = g.edges[i]!;
      const len = ix.length(i);
      const fwd = f.a === node;
      return { edge: i, from: fwd ? 0 : len, to: fwd ? len : 0, v: this.legSpeed(n, layer, i) };
    };
    const outs = ix.out(node).filter((i) => i !== leg.edge);
    if (outs.length) return outs.map(make);
    return ix.out(node).includes(leg.edge) ? [make(leg.edge)] : [];
  }

  /** Continues n's route from its position at `tick`: the rest of the current legs plus new ones, as a new plan. */
  extend(n: NpcState, tick: number, msgs: NpcMsg[], accel?: number): void {
    const kind = n.kind as 'walker' | 'cyclist' | 'driver';
    const layer = n.layer as NetLayer;
    const pose = planAt(n.plan, tick);
    const legs = this.legsFrom(n, pose.s);
    let total = legs.reduce((a, l) => a + Math.abs(l.to - l.from), 0);
    let dead = false;
    while (total < PLAN_MIN[kind] || legs.length < 2) {
      const opts = this.nextLegs(layer, legs[legs.length - 1]!, n);
      if (!opts.length) {
        dead = true;
        break;
      }
      const next = opts[Math.floor(this.rng() * opts.length)]!;
      legs.push(next);
      total += Math.abs(next.to - next.from);
    }
    // drop zero-length legs (a route starting exactly at a node)
    const route = legs.filter((l) => Math.abs(l.to - l.from) > 1e-3);
    if (!route.length) {
      this.remove(n, msgs);
      return;
    }
    const { path, extra } = this.pathFrom(pose, layer, route, Infinity);
    const vOf = (l: Leg) => Math.min(l.v, n.cap);
    const lens = route.map((l) => ({ len: Math.abs(l.to - l.from), v: vOf(l) }));
    lens[0]!.len += extra;
    const ramps = rampsForLegs(lens, Math.max(pose.speed, n.plan.ramps.length ? 0.3 : vOf(route[0]!)), dead ? 0 : vOf(route[route.length - 1]!), accel ?? ACCEL[kind]);
    msgs.push(this.replan(n, tick, path, ramps, 'move', route));
    this.setShift(n, path, extra);
    if (dead) n.nextPlanAt = Infinity;
  }

  /**
   * The path along legs (up to max m) starting at the NPC's actual position: if that lies off the legs' line (after
   * overtaking), the path joins the line over the first 8 m. extra: how much longer the path is than the legs.
   */
  private pathFrom(pose: { x: number; y: number; z: number }, layer: NetLayer, legs: Leg[], max: number): { path: PathPt[]; extra: number } {
    const pts = this.routePoints(layer, legs, max);
    if (!pts.length || Math.hypot(pts[0]!.x - pose.x, pts[0]!.z - pose.z) < 0.3) return { path: pts, extra: 0 };
    const len = (q: PathPt[]) => q.reduce((a, p, i) => (i ? a + Math.hypot(p.x - q[i - 1]!.x, p.z - q[i - 1]!.z) : 0), 0);
    let acc = 0, i = 1;
    while (i < pts.length - 1 && acc < 8) {
      acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z);
      i++;
    }
    const path = [{ x: pose.x, y: pose.y, z: pose.z }, ...pts.slice(i - 1)];
    return { path, extra: len(path) - len(pts) };
  }

  private setShift(n: NpcState, path: PathPt[], extra: number): void {
    if (Math.abs(extra) < 0.02) return;
    let at = 0;
    for (let i = 1; i < path.length; i++) at += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
    n.shift = { extra, at };
  }

  /** n's legs from distance s along its current plan on (the first one cut to start there). */
  legsFrom(n: NpcState, s: number): Leg[] {
    if (n.shift) s = (s * (n.shift.at - n.shift.extra)) / n.shift.at;
    const legs: Leg[] = [];
    for (const leg of n.legs) {
      const len = Math.abs(leg.to - leg.from);
      if (s >= len - 1e-6 && legs.length === 0) {
        s -= len;
        continue;
      }
      if (legs.length === 0) {
        const dir = Math.sign(leg.to - leg.from) || 1;
        legs.push({ ...leg, from: leg.from + dir * s });
      } else legs.push(leg);
    }
    if (!legs.length && n.legs.length) {
      const last = n.legs[n.legs.length - 1]!;
      legs.push({ ...last, from: last.to });
    }
    return legs;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Traffic

  private refreshObstacles(tick: number): void {
    const list: Obstacle[] = [];
    for (const n of this.npcs.values()) {
      const p = planAt(n.plan, tick);
      const size = n.kind === 'driver' ? SIZE.car : n.kind === 'cyclist' ? SIZE.bike : SIZE.person;
      list.push({
        id: n.id, x: p.x, z: p.z, vx: Math.sin(p.heading) * p.speed, vz: Math.cos(p.heading) * p.speed, len: size.len, half: size.half, npc: n,
        mode: n.kind === 'walker' ? 'walk' : n.kind === 'driver' ? 'drive' : 'ride',
      });
    }
    this.obstacles = list;
    this.obstacleGrid = new Map();
    for (const o of list) {
      const k = `${Math.floor(o.x / OBST_CELL)},${Math.floor(o.z / OBST_CELL)}`;
      (this.obstacleGrid.get(k) ?? this.obstacleGrid.set(k, []).get(k)!).push(o);
    }
  }

  private playerObstacle(pl: PlayerNear): Obstacle {
    const size = pl.mode === 'drive' ? SIZE.car : pl.mode === 'ride' ? SIZE.bike : SIZE.person;
    return { id: -pl.id - 1, x: pl.x, z: pl.z, vx: pl.vx, vz: pl.vz, len: size.len, half: size.half + (pl.mode === 'walk' ? 0.05 : 0), npc: null, mode: pl.mode };
  }

  /** NPCs (positions from the last refresh) within NPC_REACT_RADIUS of a player: they check traffic every tick. */
  private nearPlayerIds(): Set<number> {
    const out = new Set<number>();
    for (const pl of this.players) for (const o of this.nearNpcObstacles(pl.x, pl.z, NPC_REACT_RADIUS)) out.add(o.id);
    return out;
  }

  private nearObstacles(x: number, z: number, r: number): Obstacle[] {
    const out = this.nearNpcObstacles(x, z, r);
    for (const pl of this.players) if (Math.abs(pl.x - x) <= r + 5 && Math.abs(pl.z - z) <= r + 5) out.push(this.playerObstacle(pl));
    return out;
  }

  private nearNpcObstacles(x: number, z: number, r: number): Obstacle[] {
    const out: Obstacle[] = [];
    for (let cx = Math.floor((x - r) / OBST_CELL); cx <= Math.floor((x + r) / OBST_CELL); cx++) {
      for (let cz = Math.floor((z - r) / OBST_CELL); cz <= Math.floor((z + r) / OBST_CELL); cz++) out.push(...(this.obstacleGrid.get(`${cx},${cz}`) ?? []));
    }
    return out;
  }

  /** Points along legs from their start, up to `max` m (with heights). */
  private routePoints(layer: NetLayer, legs: Leg[], max: number): PathPt[] {
    const out: PathPt[] = [];
    let done = 0;
    for (const leg of legs) {
      const len = Math.abs(leg.to - leg.from);
      const part = done + len > max ? { ...leg, to: leg.from + Math.sign(leg.to - leg.from) * (max - done) } : leg;
      const pts = this.legPoints(layer, part);
      if (out.length) pts.shift();
      out.push(...pts);
      done += Math.abs(part.to - part.from);
      if (done >= max - 1e-6) break;
    }
    return out;
  }

  /** Samples every 1.5 m ahead along pts: distance ahead and position. */
  private static samples(pts: PathPt[], look: number, step = 1.5): { d: number; x: number; z: number }[] {
    const out: { d: number; x: number; z: number }[] = [];
    let acc = 0, next = step / 2;
    for (let i = 1; i < pts.length && next <= look; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      while (next <= acc + l && next <= look) {
        const t = l > 0 ? (next - acc) / l : 0;
        out.push({ d: next, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
        next += step;
      }
      acc += l;
    }
    return out;
  }

  /** Brings n to a stop `target` m ahead along its route (or keeps it standing), unless it already does that. */
  private holdAt(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, legs: Leg[], target: number, msgs: NpcMsg[]): void {
    const layer = n.layer as NetLayer;
    const v = pose.speed;
    if (n.hold) {
      const end = n.plan.action === 'wait' ? pose.s : (n.plan.ramps[n.plan.ramps.length - 1]?.s1 ?? 0);
      if (Math.abs(end - (pose.s + target)) < 0.5 || (n.plan.action === 'wait' && target < 0.5)) return;
    }
    let path: PathPt[], ramps: Plan['ramps'] = [], action: Plan['action'] = 'move';
    if (target < 0.05 && v < 0.3) {
      const h = pose.heading;
      path = [{ x: pose.x, y: pose.y, z: pose.z }, { x: pose.x + Math.sin(h) * 0.5, y: pose.y, z: pose.z + Math.cos(h) * 0.5 }];
      action = 'wait';
    } else {
      const d = Math.max(0.05, target);
      const r = this.pathFrom(pose, layer, legs, d);
      path = r.path;
      const len = d + r.extra;
      ramps = rampsForLegs([{ len, v: Math.max(v, 0.5) }], v, 0, Math.max(ACCEL[n.kind as 'driver'], (v * v) / (2 * len)));
      msgs.push(this.replan(n, tick, path, ramps, action, legs));
      this.setShift(n, path, r.extra);
      n.hold = true;
      n.nextPlanAt = Infinity;
      n.lastTraffic = tick;
      return;
    }
    msgs.push(this.replan(n, tick, path, ramps, action, legs));
    n.hold = true;
    n.nextPlanAt = Infinity;
    n.lastTraffic = tick;
  }

  private resume(n: NpcState, tick: number, msgs: NpcMsg[]): void {
    n.hold = false;
    n.waitingSince = null;
    n.lastTraffic = tick;
    this.extend(n, tick, msgs);
  }

  /** Checks what lies ahead of a moving NPC and stops, follows, resumes or overtakes. */
  private traffic(n: NpcState, tick: number, msgs: NpcMsg[]): void {
    const pose = planAt(n.plan, tick);
    if (n.hold && pose.speed < 0.1) n.waitingSince ??= tick;
    if (n.kind === 'walker') return this.walkerTraffic(n, tick, pose, msgs);
    const kind = n.kind as 'driver' | 'cyclist';
    const layer = n.layer as 'drive' | 'cycle';
    const me = kind === 'driver' ? SIZE.car : SIZE.bike;
    const v = pose.speed;
    const look = Math.max(25, (v * v) / (2 * STOP_DECEL_T) + 15 + me.len);
    const legs = this.legsFrom(n, pose.s);
    const overtaking = n.overtakeUntil > tick;
    const pts = overtaking ? n.plan.path.slice(0) : this.routePoints(layer, legs, look);
    const ahead = NpcDirector.samples(overtaking ? trimPath(pts, pose.s) : pts, look);
    const hx = Math.sin(pose.heading), hz = Math.cos(pose.heading);

    let stop = Infinity, leader: Obstacle | null = null, leaderD = Infinity;
    for (const o of this.nearObstacles(pose.x, pose.z, look + 5)) {
      if (o.npc === n) continue;
      if ((o.x - pose.x) * hx + (o.z - pose.z) * hz <= 0) continue; // behind
      for (const sm of ahead) {
        if (Math.hypot(o.x - sm.x, o.z - sm.z) > me.half + o.half + 0.3) continue;
        const dStop = sm.d - (me.len / 2 + o.len / 2 + GAP[kind]);
        if (dStop < stop) {
          stop = dStop;
          leader = o;
          leaderD = sm.d;
        }
        break;
      }
    }
    // a player standing in the way: say something, go round, give up
    if (leader && !leader.npc && Math.hypot(leader.vx, leader.vz) < 0.8) {
      if (this.blockedByPlayer(n, tick, pose, legs, leader, leaderD, stop, msgs)) return;
    } else if (n.blockedSince !== null && (!leader || leader.npc)) n.blockedSince = null;
    if (leader?.npc && leader.npc.kind === 'sitter') leader = null;
    // a moving leader: follow at its speed (or overtake a slow cyclist) instead of stopping
    if (leader) {
      const lv = Math.hypot(leader.vx, leader.vz);
      const along = leader.vx * hx + leader.vz * hz;
      if (lv > 0.8 && along > 0.7 * lv && stop > 1) {
        if (kind === 'driver' && leader.npc?.kind === 'cyclist' && !overtaking && this.tryOvertake(n, tick, pose, legs, leaderD, lv, msgs)) return;
        const room = Math.max(0.5, stop);
        const capTo = stop < Math.max(0, v * v - lv * lv) / (2 * ACCEL[kind]) + 2 * lv + 8 ? lv : Infinity;
        if (n.hold) this.resume(n, tick, msgs);
        else if ((capTo < n.cap - 0.5) || (Math.abs(capTo - n.cap) > 1 && tick - n.lastTraffic >= TRAFFIC_CALM)) {
          n.cap = capTo;
          n.lastTraffic = tick;
          this.extend(n, tick, msgs, Math.max(ACCEL[kind], (v * v - lv * lv) / (2 * room)));
        }
        stop = Infinity;
      }
    }
    if (!leader && n.cap !== Infinity && tick - n.lastTraffic >= TRAFFIC_CALM) {
      n.cap = Infinity;
      n.lastTraffic = tick;
      if (!n.hold) this.extend(n, tick, msgs);
    }

    // a claimed turn arc is released once the vehicle is past it
    const claim = this.claims.get(n.id);
    if (claim && legs[0] && legs[0].edge !== claim.turn && this.tables.approachOf[claim.layer].get(legs[0].edge)?.j !== claim.j) this.claims.delete(n.id);
    // the next junction on the route
    let off = 0;
    for (let k = 0; k < legs.length && off < look + 10; k++) {
      const leg = legs[k]!, next = legs[k + 1];
      const ref = this.tables.approachOf[layer].get(leg.edge);
      if (ref && next && this.tables.turnOf[layer].get(next.edge) === ref.j) {
        const dStop = off + (ref.ap.stopS - leg.from);
        if (dStop > -0.5 && !this.claims.has(n.id)) {
          if (!this.mayEnter(n, tick, layer, ref, next.edge, dStop, v)) stop = Math.min(stop, Math.max(0, dStop));
          else if (dStop <= (v * v) / (2 * STOP_DECEL_T) + 2 + v * (TRAFFIC_EVERY / TICK_HZ)) this.claims.set(n.id, { j: ref.j, layer, turn: next.edge });
        }
        break;
      }
      if (this.tables.turnOf[layer].has(leg.edge)) break; // inside a junction: committed
      off += Math.abs(leg.to - leg.from);
    }

    if (Number.isFinite(stop)) {
      const target = Math.max(0, stop);
      const braking = (v * v) / (2 * STOP_DECEL_T);
      if (n.hold || target <= braking + 8 + v) this.holdAt(n, tick, pose, legs, target, msgs);
    } else if (n.hold) this.resume(n, tick, msgs);
  }

  /** Whether n may drive into junction ref.j onto turn edge `turn` now (lights, crossing traffic, right of way). */
  private mayEnter(n: NpcState, tick: number, layer: 'drive' | 'cycle', ref: { j: number; ap: { group: 0 | 1; rank: number; edge: number; stopS: number }; index: number }, turn: number, dStop: number, v: number): boolean {
    const j = this.tables.junction(ref.j);
    if (j.signal && !lightAllows(signalAt(j, ref.ap.group, tick), dStop, v)) return false;
    for (const [id, c] of this.claims) {
      if (id !== n.id && c.j === ref.j && c.layer === layer && this.tables.conflict(ref.j, layer, turn, c.turn)) return false;
    }
    const near = this.nearObstacles(j.x, j.z, 45);
    // someone on a crossing arc of this junction
    for (const o of near) {
      if (!o.npc || o.npc === n || o.npc.layer !== layer) continue;
      const leg = this.currentLeg(o.npc, tick);
      if (leg && this.tables.turnOf[layer].get(leg.edge) === ref.j && this.tables.conflict(ref.j, layer, turn, leg.edge)) return false;
    }
    if (j.signal) return true;
    // right of way: higher rank first, equal rank: the one from the right
    const g = this.net[layer];
    const ap = g.edges[ref.ap.edge]!;
    const [ax, az] = ap.pts[ap.pts.length - 2]!, [bx, bz] = ap.pts[ap.pts.length - 1]!;
    const dl = Math.hypot(bx - ax, bz - az) || 1;
    const rx = -(bz - az) / dl, rz = (bx - ax) / dl;
    const yieldTo: Obstacle[] = [];
    for (const o of near) {
      if (o.npc === n || o.mode === 'walk') continue;
      let rank: number, eta: number;
      if (o.npc) {
        if (o.npc.kind === 'walker') continue;
        const oLayer = o.npc.layer as 'drive' | 'cycle';
        const leg = this.currentLeg(o.npc, tick);
        const r2 = leg && this.tables.approachOf[oLayer].get(leg.edge);
        if (!leg || !r2 || r2.j !== ref.j || (oLayer === layer && r2.index === ref.index)) continue;
        const dO = r2.ap.stopS - leg.from;
        if (dO < -0.5) continue;
        const vO = Math.hypot(o.vx, o.vz);
        eta = dO / Math.max(vO, 0.1);
        if (eta > PRIORITY_ETA && dO > 3) continue;
        rank = r2.ap.rank;
      } else {
        const vO = Math.hypot(o.vx, o.vz);
        const tx = j.x - o.x, tz = j.z - o.z;
        const dist = Math.hypot(tx, tz);
        if (vO < 0.5 || (o.vx * tx + o.vz * tz) <= 0 || dist < 3) continue;
        eta = dist / vO;
        if (eta > PRIORITY_ETA) continue;
        rank = this.rankAt(ref.j, layer, o.x, o.z);
      }
      const ux = o.x - j.x, uz = o.z - j.z, ul = Math.hypot(ux, uz) || 1;
      const fromRight = (ux * rx + uz * rz) / ul > Math.SQRT1_2;
      if (rank > ref.ap.rank || (rank === ref.ap.rank && fromRight)) yieldTo.push(o);
    }
    if (!yieldTo.length) return true;
    // a standoff: everyone waits for someone; the one waiting longest goes
    const mine = n.waitingSince;
    if (mine === null || tick - mine < STANDOFF) return false;
    return yieldTo.every((o) => o.npc && o.npc.waitingSince !== null && (o.npc.waitingSince > mine || (o.npc.waitingSince === mine && o.npc.id > n.id)));
  }

  /** Rank of the approach of junction j whose stop point lies nearest to (x, z). */
  private rankAt(j: number, layer: 'drive' | 'cycle', x: number, z: number): number {
    const info = this.tables.junction(j);
    let best = 2, bd = Infinity;
    for (const ap of layer === 'drive' ? info.approaches : info.cycleApproaches) {
      const e = this.net[layer].edges[ap.edge]!;
      const [ex, ez] = e.pts[e.pts.length - 1]!;
      const d = Math.hypot(ex - x, ez - z);
      if (d < bd) [best, bd] = [ap.rank, d];
    }
    return best;
  }

  /** Walkers wait at signalled crossings until the green man. */
  private walkerTraffic(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, msgs: NpcMsg[]): void {
    const legs = this.legsFrom(n, pose.s);
    // a player in the way (2.5 m ahead)
    if (n.overtakeUntil <= tick && this.players.length) {
      const pts = this.routePoints('walk', legs, 4);
      const ahead = NpcDirector.samples(pts, 4, 0.4);
      let hit: { o: Obstacle; d: number } | null = null;
      for (const pl of this.players) {
        if (Math.abs(pl.x - pose.x) > 6 || Math.abs(pl.z - pose.z) > 6) continue;
        const o = this.playerObstacle(pl);
        for (const sm of ahead) {
          if (Math.hypot(o.x - sm.x, o.z - sm.z) <= SIZE.person.half + o.half + 0.1) {
            if (!hit || sm.d < hit.d) hit = { o, d: sm.d };
            break;
          }
        }
      }
      if (hit && Math.hypot(hit.o.vx, hit.o.vz) < 0.8) {
        if (this.blockedByPlayer(n, tick, pose, legs, hit.o, hit.d, hit.d - (SIZE.person.half + hit.o.half + 0.45), msgs)) return;
        return;
      }
      if (n.blockedSince !== null) n.blockedSince = null;
    }
    let off = 0;
    for (let k = 0; k < legs.length && off <= PED_WAIT + 1; k++) {
      const leg = legs[k]!;
      const len = Math.abs(leg.to - leg.from);
      const ped = this.tables.pedOf.get(leg.edge);
      if (ped) {
        const full = this.ix.walk.length(leg.edge);
        const startOf = leg.to >= leg.from ? 0 : full;
        const into = k === 0 ? Math.abs(leg.from - startOf) : 0;
        if (into > 0.3) break; // already crossing
        const green = pedSignalAt(this.tables.junction(ped.j), ped.group, tick) === 'green';
        if (!green) return this.holdAt(n, tick, pose, legs, off, msgs);
        break;
      }
      off += len;
    }
    if (n.hold) this.resume(n, tick, msgs);
  }

  /**
   * Overtakes the slow cyclist `leaderD` m ahead on the oncoming lane if it is clear for OVERTAKE.clear m and no junction
   * comes before the manoeuvre ends; returns whether it started.
   */
  private tryOvertake(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, legs: Leg[], leaderD: number, lv: number, msgs: NpcMsg[]): boolean {
    const layer = n.layer as 'drive' | 'cycle';
    const vme = legs[0] ? legs[0].v : 0;
    if (vme - lv < 2) return false;
    const gain = leaderD + SIZE.car.len + 6;
    const along = (vme * gain) / (vme - lv);
    // round a standing obstacle close ahead: swerve over the room there is (at least 3 m); a moving one: OVERTAKE.ramp
    const ramp = lv < 0.8 ? Math.min(OVERTAKE.ramp, Math.max(3, leaderD - SIZE.car.len / 2 - 0.8)) : OVERTAKE.ramp;
    const total = along + 2 * ramp;
    // no junction within the manoeuvre (+ margin)
    let off = 0;
    for (const leg of legs) {
      if (this.tables.approachOf[layer].has(leg.edge) || this.tables.turnOf[layer].has(leg.edge)) {
        const ref = this.tables.approachOf[layer].get(leg.edge);
        const toJ = off + (ref ? ref.ap.stopS - leg.from : 0);
        if (toJ < total + OVERTAKE.junction) return false;
        break;
      }
      off += Math.abs(leg.to - leg.from);
      if (off > total + OVERTAKE.junction) break;
    }
    // the planned route must reach beyond the manoeuvre (else wait until it has been extended)
    const routeLen = legs.reduce((a, l) => a + Math.abs(l.to - l.from), 0);
    if (routeLen < total + 5) return false;
    const hx = Math.sin(pose.heading), hz = Math.cos(pose.heading);
    for (const o of this.nearObstacles(pose.x, pose.z, OVERTAKE.clear)) {
      if (o.npc === n || o.mode === 'walk') continue;
      const dx = o.x - pose.x, dz = o.z - pose.z;
      const fwd = dx * hx + dz * hz, lat = -(dx * -hz + dz * hx); // left of travel > 0
      const oncoming = o.vx * hx + o.vz * hz < -0.5;
      if (fwd > -5 && fwd < OVERTAKE.clear && lat > 1 && lat < 7 && (oncoming || Math.hypot(o.vx, o.vz) < 0.5)) return false;
    }
    const base = densifyPath(this.routePoints(layer, legs, Math.min(routeLen, total + 40)), 2);
    let acc = 0;
    const path = base.map((p, i) => {
      if (i > 0) acc += Math.hypot(p.x - base[i - 1]!.x, p.z - base[i - 1]!.z);
      const k = acc < ramp ? acc / ramp : acc > total - ramp ? Math.max(0, (total - acc) / ramp) : 1;
      const o = OVERTAKE.offset * smooth(k);
      const q = base[Math.min(base.length - 1, i + 1)]!, r = base[Math.max(0, i - 1)]!;
      const dl = Math.hypot(q.x - r.x, q.z - r.z) || 1;
      // left of travel: (dz, -dx) / l in x east, z south
      return { x: p.x + ((q.z - r.z) / dl) * o, y: p.y, z: p.z - ((q.x - r.x) / dl) * o };
    });
    const legsLen = acc;
    let pathLen = 0;
    for (let i = 1; i < path.length; i++) pathLen += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
    const routeLegs = this.trimLegs(legs, legsLen);
    const ramps = rampsForLegs([{ len: pathLen, v: vme }], pose.speed, vme, ACCEL[n.kind as 'driver']);
    msgs.push(this.replan(n, tick, path, ramps, 'move', routeLegs));
    this.setShift(n, path, pathLen - legsLen);
    n.overtakeUntil = tick + Math.ceil((pathLen / vme) * TICK_HZ);
    n.hold = false;
    n.waitingSince = null;
    n.cap = Infinity;
    n.lastTraffic = tick;
    return true;
  }

  /**
   * A player stands in n's way `d` m ahead (stop: how far n can go). After NPC_SAY_AFTER_S n says something (cooldown,
   * one NPC per player at a time; drivers honk), then goes round if there is room, else waits; after NPC_GIVE_UP_S it
   * turns back. Returns whether it changed n's plan beyond holding.
   */
  private blockedByPlayer(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, legs: Leg[], o: Obstacle, d: number, stop: number, msgs: NpcMsg[]): boolean {
    const playerId = -o.id - 1;
    n.blockedSince ??= tick;
    const since = tick - n.blockedSince;
    if (since >= NPC_SAY_AFTER_S * TICK_HZ && pose.speed < 0.3) {
      const sc = this.scolding.get(playerId);
      const free = !sc || sc.until <= tick || sc.npc === n.id || !this.npcs.has(sc.npc);
      if (free && tick - n.saidAt >= NPC_SAY_COOLDOWN_S * TICK_HZ) {
        const lines = linesFor(n.kind === 'driver' ? 'blockedCar' : 'blocked');
        msgs.push({ t: 'say', id: n.id, line: lines[Math.floor(this.rng() * lines.length)]! });
        if (n.kind === 'driver') msgs.push({ t: 'honk', id: n.id });
        n.saidAt = tick;
        this.scolding.set(playerId, { npc: n.id, until: tick + 3 * TICK_HZ });
      }
      if (since >= NPC_GIVE_UP_S * TICK_HZ) {
        if (this.turnBack(n, tick, pose, legs, msgs)) {
          n.blockedSince = null;
          return true;
        }
      } else if (n.kind === 'walker' ? this.stepAround(n, tick, pose, legs, o, d, msgs) : this.tryOvertake(n, tick, pose, legs, d, 0, msgs)) {
        n.blockedSince = null;
        return true;
      }
    }
    this.holdAt(n, tick, pose, legs, Math.max(0, stop), msgs);
    return true;
  }

  /** A walker goes round a person on a wide enough way: sideways past them and back onto its line. */
  private stepAround(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, legs: Leg[], o: Obstacle, d: number, msgs: NpcMsg[]): boolean {
    const leg = legs[0];
    if (!leg) return false;
    const width = this.net.walk.edges[leg.edge]!.width;
    const hx = Math.sin(pose.heading), hz = Math.cos(pose.heading);
    const lat = (o.x - pose.x) * -hz + (o.z - pose.z) * hx; // the obstacle's offset right of n's line
    const clear = o.half + SIZE.person.half + 0.25;
    const side = lat > 0 ? -1 : 1; // pass on the side away from it
    const target = lat + side * clear; // n's offset right of its line while passing
    if (Math.abs(target) > width / 2 - 0.2) return false;
    const total = d + clear + 2.5;
    const routeLen = legs.reduce((a, l) => a + Math.abs(l.to - l.from), 0);
    if (routeLen < total + 1) return false;
    const base = densifyPath(this.routePoints('walk', legs, Math.min(routeLen, total + 10)), 0.5);
    const rampIn = Math.max(0.6, d - 0.6), rampOut = 1.5;
    let acc = 0;
    const path = base.map((p, i) => {
      if (i > 0) acc += Math.hypot(p.x - base[i - 1]!.x, p.z - base[i - 1]!.z);
      const k = acc < rampIn ? acc / rampIn : acc > total - rampOut ? Math.max(0, (total - acc) / rampOut) : 1;
      const off = target * smooth(Math.min(1, k));
      const q = base[Math.min(base.length - 1, i + 1)]!, r = base[Math.max(0, i - 1)]!;
      const dl = Math.hypot(q.x - r.x, q.z - r.z) || 1;
      // right of travel: (-dz, dx) / l
      return { x: p.x - ((q.z - r.z) / dl) * off, y: p.y, z: p.z + ((q.x - r.x) / dl) * off };
    });
    let pathLen = 0;
    for (let i = 1; i < path.length; i++) pathLen += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
    const ramps = rampsForLegs([{ len: pathLen, v: n.cruise }], pose.speed, n.cruise, ACCEL.walker);
    msgs.push(this.replan(n, tick, path, ramps, 'move', this.trimLegs(legs, acc)));
    this.setShift(n, path, pathLen - acc);
    n.hold = false;
    n.waitingSince = null;
    n.overtakeUntil = tick + Math.ceil((pathLen / n.cruise) * TICK_HZ);
    n.lastTraffic = tick;
    return true;
  }

  /** Gives up: walkers walk back the way they came, vehicles turn onto the lane the other way. */
  private turnBack(n: NpcState, tick: number, pose: ReturnType<typeof planAt>, legs: Leg[], msgs: NpcMsg[]): boolean {
    const layer = n.layer as NetLayer;
    const leg = legs[0];
    if (!leg) return false;
    let back: Leg | null = null;
    const e = this.net[layer].edges[leg.edge]!;
    if (!e.oneway) {
      back = { ...leg, to: leg.to >= leg.from ? 0 : this.ix[layer].length(leg.edge) };
    } else {
      // the nearest edge running the other way within 5 m to the left
      const hx = Math.sin(pose.heading), hz = Math.cos(pose.heading);
      const lx = pose.x + hz * 3, lz = pose.z - hx * 3;
      const ix = this.ix[layer];
      for (const i of ix.near(lx, lz, 6)) {
        const f = this.net[layer].edges[i]!;
        const [ax, az] = f.pts[0]!, [bx, bz] = f.pts[f.pts.length - 1]!;
        const fl = Math.hypot(bx - ax, bz - az) || 1;
        if (((bx - ax) * hx + (bz - az) * hz) / fl > -0.7) continue;
        const near = ix.nearestEdge(lx, lz, 6);
        if (!near || near.edge !== i) continue;
        back = { edge: i, from: near.s, to: ix.length(i), v: this.legSpeed(n, layer, i) };
        break;
      }
    }
    if (!back) return false;
    n.legs = [back];
    n.shift = undefined;
    n.plan = { ...n.plan, path: [{ x: pose.x, y: pose.y, z: pose.z }], ramps: [{ s0: 0, s1: 0, v0: 0.3, v1: 0.3 }], action: 'move' };
    n.hold = false;
    n.waitingSince = null;
    n.cap = Infinity;
    n.lastTraffic = tick;
    this.extend(n, tick, msgs);
    return true;
  }

  /** Players in cars or on bikes faster than KNOCKDOWN_KMH knock down the walkers and cyclists they run into. */
  private knocks(tick: number, msgs: NpcMsg[]): void {
    for (const pl of this.players) {
      if (pl.mode === 'walk') continue;
      const v = Math.hypot(pl.vx, pl.vz);
      if (v < 0.5) continue;
      const size = pl.mode === 'drive' ? SIZE.car : SIZE.bike;
      const fx = pl.vx / v, fz = pl.vz / v;
      for (const o of this.nearNpcObstacles(pl.x, pl.z, 8)) {
        const n = o.npc!;
        if ((n.kind !== 'walker' && n.kind !== 'cyclist') || n.downUntil || n.getupUntil) continue;
        const p = planAt(n.plan, tick);
        const dx = p.x - pl.x, dz = p.z - pl.z;
        const along = dx * fx + dz * fz, lat = Math.abs(dx * -fz + dz * fx);
        const r = n.kind === 'walker' ? SIZE.person.half : SIZE.bike.half;
        if (Math.abs(along) > size.len / 2 + r + v / TICK_HZ || lat > size.half + r) continue;
        if (v * 3.6 > KNOCKDOWN_KMH) this.knockDown(n, tick, p, fx, fz, v, msgs);
        else this.shove(n, tick, p, dx * -fz + dz * fx >= 0 ? -fz : fz, dx * -fz + dz * fx >= 0 ? fx : -fx, msgs);
      }
    }
  }

  private knockDown(n: NpcState, tick: number, p: ReturnType<typeof planAt>, fx: number, fz: number, v: number, msgs: NpcMsg[]): void {
    const fly = 0.9 * v, t = 0.4, dist = fly * t;
    const end = { x: p.x + fx * dist, z: p.z + fz * dist };
    const layer = n.layer as NetLayer;
    const path: PathPt[] = [
      { x: p.x, y: p.y, z: p.z },
      { x: (p.x + end.x) / 2, y: p.y + 0.5, z: (p.z + end.z) / 2 },
      { x: end.x, y: this.heightAt(end.x, end.z, layer), z: end.z },
    ];
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y, path[i]!.z - path[i - 1]!.z);
    msgs.push(this.replan(n, tick, path, [{ s0: 0, s1: len, v0: len / t, v1: len / t }], 'down', n.legs));
    n.hold = true;
    n.nextPlanAt = Infinity;
    n.downUntil = tick + Math.round((t + KNOCKDOWN_S) * TICK_HZ);
    n.blockedSince = null;
    n.overtakeUntil = -1;
    this.claims.delete(n.id);
  }

  /** A slow vehicle pushes a person or cyclist aside (0.8 m to the side, away from its path). */
  private shove(n: NpcState, tick: number, p: ReturnType<typeof planAt>, sx: number, sz: number, msgs: NpcMsg[]): void {
    if (tick - n.lastTraffic < 10) return;
    const to = { x: p.x + sx * 0.8, z: p.z + sz * 0.8 };
    const path = [{ x: p.x, y: p.y, z: p.z }, { x: to.x, y: this.heightAt(to.x, to.z, n.layer as NetLayer), z: to.z }];
    msgs.push(this.replan(n, tick, path, rampsForLegs([{ len: 0.8, v: 2 }], 2, 0, 6), 'move', n.legs));
    n.hold = true;
    n.nextPlanAt = Infinity;
    n.lastTraffic = tick;
  }

  /** Lying → getting up → on its way again (saying what it thinks of that). */
  private timers(n: NpcState, tick: number, msgs: NpcMsg[]): void {
    if (n.downUntil && tick >= n.downUntil) {
      const p = planAt(n.plan, tick);
      const h = p.heading;
      msgs.push(this.replan(n, tick, [{ x: p.x, y: p.y, z: p.z }, { x: p.x + Math.sin(h) * 0.5, y: p.y, z: p.z + Math.cos(h) * 0.5 }], [], 'getup', n.legs));
      n.downUntil = 0;
      n.getupUntil = tick + TICK_HZ;
      if (this.rng() < 0.3) msgs.push({ t: 'say', id: n.id, line: linesFor('getup')[0]! });
    } else if (n.getupUntil && tick >= n.getupUntil) {
      n.getupUntil = 0;
      msgs.push({ t: 'say', id: n.id, line: linesFor('hit')[0]! });
      n.saidAt = tick;
      n.hold = true;
      this.resume(n, tick, msgs);
    }
  }

  /** NPCs within r of any of the points at tick, as physics bodies need them. */
  bodiesNear(tick: number, points: readonly { x: number; z: number }[], r: number): NpcBody[] {
    const out: NpcBody[] = [];
    const seen = new Set<number>();
    // candidates from the positions of the last refresh (at most TRAFFIC_EVERY ticks old: 20 m margin), then exact
    const cached = this.obstacles.length || !this.npcs.size;
    const cand = cached ? new Set<NpcState>() : new Set(this.npcs.values());
    if (cached) for (const q of points) for (const o of this.nearNpcObstacles(q.x, q.z, r + 20)) cand.add(o.npc!);
    for (const n of cand) {
      if (seen.has(n.id) || !this.npcs.has(n.id)) continue;
      const p = planAt(n.plan, tick);
      if (!points.some((q) => Math.hypot(p.x - q.x, p.z - q.z) <= r)) continue;
      seen.add(n.id);
      out.push({ id: n.id, kind: n.kind, x: p.x, y: p.y, z: p.z, heading: p.heading, pitch: p.pitch, vehicleType: n.look.vehicleType, lying: n.plan.action === 'down' });
    }
    return out;
  }

  /** legs cut to their first `len` m. */
  private trimLegs(legs: Leg[], len: number): Leg[] {
    const out: Leg[] = [];
    let done = 0;
    for (const leg of legs) {
      const l = Math.abs(leg.to - leg.from);
      if (done + l >= len - 1e-6) {
        out.push({ ...leg, to: leg.from + Math.sign(leg.to - leg.from) * (len - done) });
        break;
      }
      out.push(leg);
      done += l;
    }
    return out;
  }

  private remove(n: NpcState, msgs: NpcMsg[]): void {
    this.npcs.delete(n.id);
    this.claims.delete(n.id);
    if (n.ring !== undefined) {
      const left = (this.rings.get(n.ring) ?? []).filter((id) => id !== n.id);
      if (left.length) this.rings.set(n.ring, left);
      else {
        this.rings.delete(n.ring);
        this.talkAt.delete(n.ring);
      }
    }
    msgs.push({ t: 'gone', id: n.id });
  }

  private lookFor(kind: NpcKind): NpcLook {
    const r = this.rng;
    const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
    const look: NpcLook = { variant: r() < 0.5 ? 0 : 1, tint: pick(TINTS), scale: Math.round((0.95 + r() * 0.1) * 1000) / 1000, vehicleType: -1, vehicleColor: 0 };
    if (kind === 'driver') {
      look.vehicleType = Math.floor(r() * 4); // kleinwagen, mittelklasse, smart, transporter
      look.vehicleColor = pick(PAINT);
    } else if (kind === 'cyclist') {
      look.vehicleType = pick([0, 0, 0, 1, 1, 2, 3]); // mostly city bikes; no trike, no sound bike
      look.vehicleColor = pick(PAINT);
    }
    return look;
  }

  private census(tick: number, foci: readonly Focus[], msgs: NpcMsg[]): void {
    const pos = new Map<number, { x: number; z: number; n: NpcState }>();
    for (const n of this.npcs.values()) {
      const p = planAt(n.plan, tick);
      pos.set(n.id, { x: p.x, z: p.z, n });
    }
    const minFocus = (x: number, z: number): number => foci.reduce((m, f) => Math.min(m, Math.hypot(f.x - x, f.z - z)), Infinity);
    for (const [id, p] of pos) {
      if (minFocus(p.x, p.z) > NPC_DESPAWN) {
        this.remove(p.n, msgs);
        pos.delete(id);
      }
    }
    if (!foci.length) return;

    let budget = SPAWN_PER_CENSUS;
    const start = Math.floor(tick / CENSUS_EVERY) % foci.length;
    for (let k = 0; k < foci.length && budget > 0; k++) {
      const f = foci[(start + k) % foci.length]!;
      const counts = { walker: 0, cyclist: 0, driver: 0, groups: new Set<number>() };
      for (const p of pos.values()) {
        if (Math.hypot(p.x - f.x, p.z - f.z) > AREA) continue;
        if (p.n.kind === 'sitter') counts.groups.add(p.n.ring!);
        else counts[p.n.kind]++;
      }
      const moving = NPC_TARGETS.walker + NPC_TARGETS.cyclist + NPC_TARGETS.driver;
      const populated = counts.walker + counts.cyclist + counts.driver >= POPULATED * moving * this.density;
      // seat groups first: they can only appear while the area is unpopulated or far enough away
      const wantGroups = Math.round(NPC_TARGETS.groups * this.density);
      for (let c = counts.groups.size; c < wantGroups && budget > 0 && this.npcs.size < NPC_MAX - 4; c++) {
        const ids = this.spawnGroup(f, foci, populated, tick, msgs);
        budget--;
        if (!ids) break;
        for (const n of ids) pos.set(n.id, { x: planAt(n.plan, tick).x, z: planAt(n.plan, tick).z, n });
      }
      for (const kind of ['walker', 'driver', 'cyclist'] as const) {
        const want = Math.round(NPC_TARGETS[kind] * this.density);
        for (let c = counts[kind]; c < want && budget > 0 && this.npcs.size < NPC_MAX; c++) {
          const n = this.spawnMoving(kind, f, foci, populated, pos, tick, msgs);
          budget--;
          if (!n) break;
          const p = planAt(n.plan, tick);
          pos.set(n.id, { x: p.x, z: p.z, n });
        }
      }
    }
    this.smallTalk(tick, foci, msgs);
  }

  /** Whether (x, z) is a fair spawn spot for all foci: far enough away and, in populated areas, out of view. */
  private spawnOk(x: number, z: number, foci: readonly Focus[], populated: boolean): boolean {
    const min = populated ? NPC_SPAWN_MIN : NPC_SPAWN_FIRST_MIN;
    for (const g of foci) {
      const d = Math.hypot(x - g.x, z - g.z);
      if (d < min) return false;
      if (populated && d <= NPC_SPAWN_MAX) {
        const a = Math.atan2(x - g.x, z - g.z) - g.heading;
        if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < VIEW_HALF) return false;
      }
    }
    return true;
  }

  private spawnMoving(
    kind: 'walker' | 'cyclist' | 'driver', f: Focus, foci: readonly Focus[], populated: boolean,
    pos: ReadonlyMap<number, { x: number; z: number; n: NpcState }>, tick: number, msgs: NpcMsg[],
  ): NpcState | null {
    const layer = LAYER_OF[kind];
    const ix = this.ix[layer];
    const g = this.net[layer];
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const d = populated ? NPC_SPAWN_MIN + this.rng() * (NPC_SPAWN_MAX - NPC_SPAWN_MIN) : NPC_SPAWN_FIRST_MIN + this.rng() * (NPC_SPAWN_MAX - NPC_SPAWN_FIRST_MIN);
      const near = ix.nearestEdge(f.x + Math.sin(a) * d, f.z + Math.cos(a) * d, 40);
      if (!near) continue;
      const e = g.edges[near.edge]!;
      const len = ix.length(near.edge);
      const s = Math.min(len, Math.max(0, near.s));
      const leg0: Leg = e.oneway || this.rng() < 0.5 ? { edge: near.edge, from: s, to: len, v: 0 } : { edge: near.edge, from: s, to: 0, v: 0 };
      const p = this.legPoints(layer, { ...leg0, to: leg0.from })[0]!;
      if (!this.spawnOk(p.x, p.z, foci, populated)) continue;
      if (kind !== 'walker' && [...pos.values()].some((q) => q.n.layer === layer && Math.hypot(q.x - p.x, q.z - p.z) < SPAWN_GAP)) continue;
      const cruise = this.cruiseFor(kind);
      const id = this.nextId++;
      const look = this.lookFor(kind);
      const n = this.newMoving(id, kind, look, layer, cruise, tick);
      n.plan = { ...n.plan, path: [p] };
      leg0.v = this.legSpeed(n, layer, leg0.edge);
      n.legs = [leg0];
      // start at cruising speed: the plan's "previous speed" is the leg's
      n.plan = { ...n.plan, action: 'move', ramps: [{ s0: 0, s1: 0, v0: leg0.v, v1: leg0.v }] };
      this.npcs.set(id, n);
      this.extend(n, tick, msgs);
      return this.npcs.get(id) ?? null;
    }
    return null;
  }

  private spawnGroup(f: Focus, foci: readonly Focus[], populated: boolean, tick: number, msgs: NpcMsg[]): NpcState[] | null {
    const free: number[] = [];
    this.net.seats.forEach((r, i) => {
      if (this.rings.has(i) || Math.hypot(r.x - f.x, r.z - f.z) > AREA) return;
      if (this.spawnOk(r.x, r.z, foci, populated)) free.push(i);
    });
    if (!free.length) return null;
    const ringIx = free[Math.floor(this.rng() * free.length)]!;
    const ring = this.net.seats[ringIx]!;
    const n = Math.min(ring.seats.length, 2 + Math.floor(this.rng() * 3));
    const out: NpcState[] = [];
    for (let k = 0; k < n; k++) {
      const seat = ring.seats[k]!;
      const id = this.nextId++;
      const look = this.lookFor('sitter');
      const y = this.heightAt(seat.x, seat.z, 'walk');
      const path = [{ x: seat.x, y, z: seat.z }, { x: seat.x + Math.sin(seat.heading) * 0.5, y, z: seat.z + Math.cos(seat.heading) * 0.5 }];
      const st: NpcState = {
        id, kind: 'sitter', look, layer: 'seat', legs: [], cruise: 0, nextPlanAt: Infinity, ring: ringIx, seat: k,
        hold: false, waitingSince: null, cap: Infinity, lastTraffic: -Infinity, overtakeUntil: -1,
        blockedSince: null, saidAt: -Infinity, downUntil: 0, getupUntil: 0,
        plan: { id, kind: 'sitter', look, startTick: tick, path, ramps: [], action: 'sit', seq: 0 },
      };
      this.npcs.set(id, st);
      msgs.push({ t: 'plan', plan: st.plan });
      out.push(st);
    }
    this.rings.set(ringIx, out.map((s) => s.id));
    return out;
  }

  private smallTalk(tick: number, foci: readonly Focus[], msgs: NpcMsg[]): void {
    const talk = linesFor('smalltalk');
    for (const [ringIx, ids] of this.rings) {
      const r = this.net.seats[ringIx]!;
      const near = foci.some((f) => Math.hypot(f.x - r.x, f.z - r.z) <= TALK_RADIUS);
      if (!near) {
        this.talkAt.delete(ringIx);
        continue;
      }
      const at = this.talkAt.get(ringIx);
      if (at === undefined) this.talkAt.set(ringIx, tick + Math.round((TALK_MIN_S + this.rng() * (TALK_MAX_S - TALK_MIN_S)) * TICK_HZ));
      else if (tick >= at) {
        msgs.push({ t: 'say', id: ids[Math.floor(this.rng() * ids.length)]!, line: talk[Math.floor(this.rng() * talk.length)]! });
        this.talkAt.set(ringIx, tick + Math.round((TALK_MIN_S + this.rng() * (TALK_MAX_S - TALK_MIN_S)) * TICK_HZ));
      }
    }
  }
}
