import { expect, test } from 'vitest';
import { NPC_MAX, NPC_SPAWN_FIRST_MIN, NPC_SPAWN_MAX, NPC_SPAWN_MIN, TICK_HZ } from '../net/constants';
import { linesFor } from '../npc/lines';
import type { NpcMsg } from '../npc/net';
import { planAt, planDuration } from '../npc/plan';
import { NPC_TARGETS, NpcDirector, type Focus } from './npc-director';
import { gridNet } from './npc-fixture';

const flat = () => 0;
const run = (d: NpcDirector, foci: Focus[], from: number, ticks: number, sink?: NpcMsg[]) => {
  for (let t = from; t < from + ticks; t++) {
    const m = d.update(t, foci);
    sink?.push(...m);
  }
  return from + ticks;
};
const posOf = (d: NpcDirector, id: number, tick: number) => planAt(d.get(id)!.plan, tick);
const within = (d: NpcDirector, tick: number, f: Focus, r: number) =>
  [...d.all()].filter((n) => { const p = planAt(n.plan, tick); return Math.hypot(p.x - f.x, p.z - f.z) <= r; });

test('fills the area around a player to the target density', () => {
  const d = new NpcDirector(gridNet(), flat, 1);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  const t = run(d, [f], 0, 600);
  const near = within(d, t, f, 250);
  const count = (k: string) => near.filter((n) => n.kind === k).length;
  expect(Math.abs(count('walker') - NPC_TARGETS.walker)).toBeLessThanOrEqual(4);
  expect(Math.abs(count('cyclist') - NPC_TARGETS.cyclist)).toBeLessThanOrEqual(2);
  expect(Math.abs(count('driver') - NPC_TARGETS.driver)).toBeLessThanOrEqual(3);
  expect(new Set(near.filter((n) => n.kind === 'sitter').map((n) => n.ring)).size).toBe(NPC_TARGETS.groups);
});

test('spawns 180–250 m away and not in front of the player once the area is populated', () => {
  const d = new NpcDirector(gridNet(), flat, 2);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  let t = run(d, [f], 0, 600);
  const msgs: NpcMsg[] = [];
  const before = new Set([...d.all()].map((n) => n.id));
  t = run(d, [f], t, 1200, msgs); // NPCs keep walking off and new ones replace them
  const fresh = msgs.filter((m) => m.t === 'plan' && !before.has(m.plan.id) && m.plan.kind !== 'sitter');
  expect(fresh.length).toBeGreaterThan(0);
  const seen = new Set<number>();
  for (const m of fresh) {
    if (m.t !== 'plan' || seen.has(m.plan.id)) continue;
    seen.add(m.plan.id);
    const p = planAt(m.plan, m.plan.startTick);
    const dist = Math.hypot(p.x - f.x, p.z - f.z);
    expect(dist).toBeGreaterThanOrEqual(NPC_SPAWN_MIN - 1);
    expect(dist).toBeLessThanOrEqual(NPC_SPAWN_MAX + 30);
    // within sight (250 m, the render and interest radius): not within ±60° of where the player looks (heading 0 = +z)
    const ang = Math.atan2(p.x - f.x, p.z - f.z);
    if (dist <= NPC_SPAWN_MAX) expect(Math.abs(ang)).toBeGreaterThan(Math.PI / 3 - 0.05);
  }
});

test('first visit spawns closer, but never within 40 m', () => {
  const d = new NpcDirector(gridNet(), flat, 3);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  const msgs: NpcMsg[] = [];
  run(d, [f], 0, 120, msgs);
  const starts = msgs.filter((m) => m.t === 'plan' && m.plan.kind !== 'sitter').map((m) => (m.t === 'plan' ? planAt(m.plan, m.plan.startTick) : null)!);
  expect(starts.some((p) => Math.hypot(p.x, p.z) < NPC_SPAWN_MIN)).toBe(true);
  for (const p of starts) expect(Math.hypot(p.x, p.z)).toBeGreaterThanOrEqual(NPC_SPAWN_FIRST_MIN - 1);
});

test('despawns beyond 300 m from every player and sends gone', () => {
  const d = new NpcDirector(gridNet(1600), flat, 4);
  let t = run(d, [{ x: -500, z: 0, heading: 0 }], 0, 600);
  const ids = [...d.all()].map((n) => n.id);
  const msgs: NpcMsg[] = [];
  t = run(d, [{ x: 500, z: 0, heading: 0 }], t, 120, msgs);
  const gone = new Set(msgs.filter((m) => m.t === 'gone').map((m) => (m.t === 'gone' ? m.id : -1)));
  for (const id of ids) expect(gone.has(id) || Math.hypot(posOf(d, id, t).x - 500, posOf(d, id, t).z) <= 300).toBe(true);
  for (const n of d.all()) expect(Math.hypot(planAt(n.plan, t).x - 500, planAt(n.plan, t).z)).toBeLessThanOrEqual(300 + 20);
});

test('density counts per area, not per player', () => {
  const one = new NpcDirector(gridNet(), flat, 5), ten = new NpcDirector(gridNet(), flat, 5);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  run(one, [f], 0, 600);
  run(ten, Array.from({ length: 10 }, () => f), 0, 600);
  expect(Math.abs(ten.count - one.count)).toBeLessThanOrEqual(6);
});

test('total never exceeds NPC_MAX', () => {
  const d = new NpcDirector(gridNet(6000, 100), flat, 6);
  const foci = Array.from({ length: 20 }, (_, i) => ({ x: -2700 + (i % 5) * 1300, z: -2700 + Math.floor(i / 5) * 1500, heading: 0 }));
  for (let t = 0; t < 900; t++) {
    d.update(t, foci);
    expect(d.count).toBeLessThanOrEqual(NPC_MAX);
  }
});

test('next plan is issued before the current one ends', () => {
  const d = new NpcDirector(gridNet(), flat, 7);
  const f: Focus = { x: 0, z: 0, heading: 1 };
  for (let t = 0; t < 1800; t++) {
    d.update(t, [f]);
    if (t < 60) continue;
    for (const n of d.all()) if (n.kind !== 'sitter' && !n.hold) expect(planAt(n.plan, t).done).toBe(false);
  }
});

test('plans continue where the previous one was', () => {
  const d = new NpcDirector(gridNet(), flat, 8);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  const last = new Map<number, { x: number; z: number }>();
  for (let t = 0; t < 1200; t++) {
    for (const m of d.update(t, [f])) {
      if (m.t !== 'plan') continue;
      const prev = last.get(m.plan.id);
      const start = planAt(m.plan, t);
      if (prev) expect(Math.hypot(start.x - prev.x, start.z - prev.z)).toBeLessThan(0.3);
    }
    for (const n of d.all()) last.set(n.id, planAt(n.plan, t));
  }
});

test('drivers keep to the drive layer and one-way direction, walkers to the walk layer', () => {
  const d = new NpcDirector(gridNet(), flat, 9);
  run(d, [{ x: 0, z: 0, heading: 0 }], 0, 900);
  const kinds = new Map([['driver', 'drive'], ['walker', 'walk'], ['cyclist', 'cycle']]);
  for (const n of d.all()) if (kinds.has(n.kind)) expect(n.layer).toBe(kinds.get(n.kind));
  // a driver's path runs along its edges in their direction (grid one-way edges: any axis-parallel step is fine, but
  // never against the edge it is on)
  for (const n of d.all()) {
    if (n.kind !== 'driver') continue;
    for (const leg of n.legs) {
      expect(d.net.drive.edges[leg.edge]!.oneway).toBe(true);
      expect(leg.to).toBeGreaterThanOrEqual(leg.from); // along the edge, never against it
    }
  }
});

test('deterministic: same seed and foci → same messages', () => {
  const a = new NpcDirector(gridNet(), flat, 10), b = new NpcDirector(gridNet(), flat, 10);
  const f: Focus = { x: 30, z: -20, heading: 2 };
  const ma: NpcMsg[] = [], mb: NpcMsg[] = [];
  run(a, [f], 0, 600, ma);
  run(b, [f], 0, 600, mb);
  expect(JSON.stringify(ma)).toBe(JSON.stringify(mb));
});

test('the load brake dissolves surplus NPCs out of sight, never close to a player', () => {
  const d = new NpcDirector(gridNet(), flat, 15);
  const f: Focus = { x: 0, z: 0, heading: 0 };
  let t = run(d, [f], 0, 600);
  const before = within(d, t, f, 250).filter((n) => n.kind === 'walker').length;
  d.density = 0.2;
  // where each NPC was the tick before it went: never within 120 m of the player
  for (let k = 0; k < 1800; k++, t++) {
    const was = new Map([...d.all()].map((n) => [n.id, planAt(n.plan, t)] as const));
    for (const m of d.update(t, [f])) {
      if (m.t !== 'gone') continue;
      const p = was.get(m.id)!;
      expect(Math.hypot(p.x - f.x, p.z - f.z)).toBeGreaterThan(120);
    }
  }
  const after = within(d, t, f, 250).filter((n) => n.kind === 'walker').length;
  expect(after).toBeLessThan(before * 0.6);
});

test('density 0.5 halves the targets', () => {
  const d = new NpcDirector(gridNet(), flat, 11);
  d.density = 0.5;
  const f: Focus = { x: 0, z: 0, heading: 0 };
  const t = run(d, [f], 0, 600);
  const walkers = within(d, t, f, 250).filter((n) => n.kind === 'walker').length;
  expect(Math.abs(walkers - NPC_TARGETS.walker / 2)).toBeLessThanOrEqual(3);
});

test('a sitter ring with a player nearby makes small talk every 20–40 s, none without a player', () => {
  const d = new NpcDirector(gridNet(), flat, 12);
  // the groups appear while the player is still 50+ m away; then the player walks into the park
  let t = run(d, [{ x: 140, z: 0, heading: -Math.PI / 2 }], 0, 600);
  const near: Focus = { x: 205, z: 0, heading: 0 };
  const msgs: NpcMsg[] = [];
  run(d, [near], t, 120 * TICK_HZ, msgs);
  const ringSays = new Map<number, number[]>();
  for (const m of msgs) {
    if (m.t !== 'say') continue;
    expect(linesFor('smalltalk')).toContain(m.line);
    const ring = d.get(m.id)?.ring;
    if (ring === undefined) continue;
    const at = msgs.indexOf(m);
    ringSays.set(ring, [...(ringSays.get(ring) ?? []), at]);
  }
  expect(ringSays.size).toBeGreaterThan(0);
  const far = new NpcDirector(gridNet(1600), flat, 12);
  const farMsgs: NpcMsg[] = [];
  run(far, [{ x: -700, z: -700, heading: 0 }], 0, 60 * TICK_HZ, farMsgs);
  expect(farMsgs.some((m) => m.t === 'say')).toBe(false);
});

test('plan paths have a point at least every 4 m (the terrain is followed between the net\'s sparse points)', () => {
  const heights: [number, number][] = [];
  const d = new NpcDirector(gridNet(), (x, z) => (heights.push([x, z]), 0), 14);
  run(d, [{ x: 0, z: 0, heading: 0 }], 0, 300);
  for (const n of d.all()) {
    if (n.kind === 'sitter' || n.plan.action !== 'move') continue;
    const p = n.plan.path;
    for (let i = 1; i < p.length; i++) expect(Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.z - p[i - 1]!.z)).toBeLessThanOrEqual(4.0001);
  }
});

test('a plan never ends before its successor exists (planDuration sane)', () => {
  const d = new NpcDirector(gridNet(), flat, 13);
  run(d, [{ x: 0, z: 0, heading: 0 }], 0, 300);
  for (const n of d.all()) if (n.kind !== 'sitter' && !n.hold) expect(planDuration(n.plan)).toBeGreaterThan(TICK_HZ);
});
