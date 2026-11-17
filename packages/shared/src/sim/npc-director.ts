import { NPC_DESPAWN, NPC_MAX, NPC_PLAN_LEAD_S, NPC_SPAWN_FIRST_MIN, NPC_SPAWN_MAX, NPC_SPAWN_MIN, TICK_HZ } from '../net/constants';
import { linesFor } from '../npc/lines';
import type { NpcMsg } from '../npc/net';
import { GraphIndex, type NetLayer, type NpcNet } from '../npc/netgraph';
import { planAt, planDuration, rampsForLegs } from '../npc/plan';
import type { NpcKind, NpcLook, PathPt, Plan } from '../npc/types';
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
};

const LAYER_OF: Record<'walker' | 'cyclist' | 'driver', NetLayer> = { walker: 'walk', cyclist: 'cycle', driver: 'drive' };

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

  constructor(readonly net: NpcNet, private readonly heightAt: (x: number, z: number, layer: NetLayer) => number, seed: number) {
    this.rng = prng(seed);
    this.ix = { walk: new GraphIndex(net.walk), drive: new GraphIndex(net.drive), cycle: new GraphIndex(net.cycle) };
    this.slowEdges = {
      walk: new Set(),
      drive: new Set(net.junctions.flatMap((j) => j.turns)),
      cycle: new Set(net.junctions.flatMap((j) => j.cycleTurns)),
    };
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
    for (const n of this.npcs.values()) if (n.kind !== 'sitter' && tick >= n.nextPlanAt) this.extend(n, tick, msgs);
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
  extend(n: NpcState, tick: number, msgs: NpcMsg[]): void {
    const kind = n.kind as 'walker' | 'cyclist' | 'driver';
    const layer = n.layer as NetLayer;
    const pose = planAt(n.plan, tick);
    // where on the current legs n is
    const legs: Leg[] = [];
    let s = pose.s;
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
    const path: PathPt[] = [];
    for (const leg of route) {
      const pts = this.legPoints(layer, leg);
      if (path.length) pts.shift();
      path.push(...pts);
    }
    const ramps = rampsForLegs(route.map((l) => ({ len: Math.abs(l.to - l.from), v: l.v })), Math.max(pose.speed, n.plan.ramps.length ? 0.3 : route[0]!.v), dead ? 0 : route[route.length - 1]!.v, ACCEL[kind]);
    msgs.push(this.replan(n, tick, path, ramps, 'move', route));
    if (dead) n.nextPlanAt = Infinity;
  }

  private remove(n: NpcState, msgs: NpcMsg[]): void {
    this.npcs.delete(n.id);
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
      const cruise = kind === 'walker' ? WALK_SPEED[0] + this.rng() * (WALK_SPEED[1] - WALK_SPEED[0])
        : kind === 'cyclist' ? CYCLE_SPEED[0] + this.rng() * (CYCLE_SPEED[1] - CYCLE_SPEED[0]) : 0.9 + this.rng() * 0.15;
      const id = this.nextId++;
      const look = this.lookFor(kind);
      const n: NpcState = {
        id, kind, look, layer, legs: [], cruise, nextPlanAt: tick,
        plan: { id, kind, look, startTick: tick, path: [p], ramps: [], action: 'wait', seq: -1 },
      };
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
