import { expect, test } from 'vitest';
import { TICK_HZ } from '../net/constants';
import { linesFor } from '../npc/lines';
import type { NpcMsg } from '../npc/net';
import { planAt } from '../npc/plan';
import { crossNet } from './npc-cross-fixture';
import { NpcDirector, type Focus, type NpcState, type PlayerNear } from './npc-director';

const F: Focus[] = [{ x: -50, z: 0, heading: 0 }];

/** A walker on the west sidewalk (z = 5, walking east from x = -100 + at). */
function setup(walkWidth: number) {
  const c = crossNet({ walkWidth });
  const d = new NpcDirector(c.net, () => 0, 1);
  d.density = 0;
  const walker = (at: number) => d.spawnAt('walker', [{ edge: c.sidewalk.W, from: at }], 0, 1.4);
  return { c, d, walker };
}
function run(d: NpcDirector, from: number, to: number, players: (t: number) => PlayerNear[], sink?: NpcMsg[]) {
  for (let t = from; t < to; t++) {
    d.setPlayers(players(t));
    const m = d.update(t, F);
    sink?.push(...m);
  }
  return to;
}
const P = (x: number, z: number, mode: PlayerNear['mode'] = 'walk', vx = 0, vz = 0): PlayerNear => ({ id: 7, x, z, vx, vz, mode });
const says = (msgs: NpcMsg[], id: number) => msgs.filter((m) => m.t === 'say' && m.id === id);
const pos = (n: NpcState, t: number) => planAt(n.plan, t);

test('walker waits for a player standing in its way and says a blocked line after 0.7 s', () => {
  const { d, walker } = setup(1.5);
  const w = walker(40); // x = -60
  const msgs: NpcMsg[] = [];
  let stoppedAt = -1;
  run(d, 0, 10 * TICK_HZ, (t) => {
    const p = pos(w, t);
    if (stoppedAt < 0 && t > 10 && p.speed < 0.05) stoppedAt = t;
    return [P(-50, 5)];
  }, msgs);
  expect(stoppedAt).toBeGreaterThan(0);
  expect(pos(w, 10 * TICK_HZ).x).toBeLessThan(-50 - 0.7);
  const s = says(msgs, w.id);
  expect(s.length).toBe(1);
  expect(linesFor('blocked')).toContain((s[0] as { line: number }).line);
});

test('walker steps around on a wide sidewalk', () => {
  const { d, walker } = setup(4);
  const w = walker(40);
  let minD = Infinity;
  run(d, 0, 30 * TICK_HZ, (t) => {
    const p = pos(w, t);
    minD = Math.min(minD, Math.hypot(p.x + 50, p.z - 5));
    return [P(-50, 5)];
  });
  expect(pos(w, 30 * TICK_HZ).x).toBeGreaterThan(-50 + 1);
  expect(minD).toBeGreaterThanOrEqual(0.4);
});

test('walker waits on a narrow sidewalk and goes on when the player leaves', () => {
  const { d, walker } = setup(1.5);
  const w = walker(40);
  run(d, 0, 8 * TICK_HZ, () => [P(-50, 5)]);
  const held = pos(w, 8 * TICK_HZ).x;
  expect(held).toBeLessThan(-50.7);
  run(d, 8 * TICK_HZ, 14 * TICK_HZ, () => []);
  expect(pos(w, 14 * TICK_HZ).x).toBeGreaterThan(held + 3);
});

test('turns back after 20 s', () => {
  const { d, walker } = setup(1.5);
  const w = walker(40);
  // it reaches the player after about 5 s and gives up 20 s later
  run(d, 0, 24 * TICK_HZ, () => [P(-50, 5)]);
  const a = pos(w, 24 * TICK_HZ);
  expect(a.speed).toBeLessThan(0.05); // still waiting
  run(d, 24 * TICK_HZ, 30 * TICK_HZ, () => [P(-50, 5)]);
  const b = pos(w, 30 * TICK_HZ);
  expect(b.x).toBeLessThan(a.x - 2); // walking back west
});

test('cooldown: a second block within 8 s says nothing', () => {
  const { d, walker } = setup(1.5);
  const w = walker(40);
  const msgs: NpcMsg[] = [];
  // blocked from 0 s, gone at 2.5 s, back in the way at 3.5 s until 7 s
  run(d, 0, 7 * TICK_HZ, (t) => {
    const x = pos(w, t).x;
    if (t < 2.5 * TICK_HZ) return [P(-50, 5)];
    if (t < 3.5 * TICK_HZ) return [];
    return [P(x + 1.6, 5)];
  }, msgs);
  expect(says(msgs, w.id).length).toBe(1);
});

test('only one npc scolds a player at a time', () => {
  const { c, d } = setup(1.5);
  const a = d.spawnAt('walker', [{ edge: c.sidewalk.W, from: 40 }], 0, 1.4);
  // a second walker coming the other way on the same sidewalk
  const b = d.spawnAt('walker', [{ edge: c.sidewalk.W, from: 58, to: 0 }], 0, 1.4);
  const msgs: NpcMsg[] = [];
  const at: number[] = [];
  for (let t = 0; t < 12 * TICK_HZ; t++) {
    d.setPlayers([P(-50.5, 5)]);
    for (const m of d.update(t, F)) if (m.t === 'say' && (m.id === a.id || m.id === b.id)) at.push(t);
  }
  expect(at.length).toBeGreaterThanOrEqual(1);
  // never two scolding the same player within 3 s of each other
  for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(3 * TICK_HZ);
});

test('npc car stops for a player who appears in its corridor in the same tick', () => {
  const c = crossNet({ len: 200 });
  const d = new NpcDirector(c.net, () => 0, 1);
  d.density = 0;
  const car = d.spawnAt('driver', [{ edge: c.inLane.W, from: 20 }], 0);
  let appear = -1, py = 0;
  for (let t = 0; t < 8 * TICK_HZ; t++) {
    const p = pos(car, t);
    if (appear < 0 && t > 3 * TICK_HZ) {
      appear = t;
      py = p.x + 4.5; // steps out 4.5 m in front of the car's centre
    }
    d.setPlayers(appear >= 0 ? [P(py, 1.5)] : []);
    d.update(t, [{ x: -100, z: 0, heading: 0 }]);
    if (appear >= 0) {
      const q = pos(car, t);
      // in the player's lane: the car's front stays clear of them; going round on the other lane: beside them
      if (Math.abs(q.z - 1.5) < 1) expect(Math.abs(py - q.x)).toBeGreaterThan(2.6);
      else expect(Math.hypot(py - q.x, 1.5 - q.z)).toBeGreaterThan(1.5);
    }
  }
});

test('npc car stops for a car a player left across its lane, and never drives into it', () => {
  const c = crossNet({ len: 200 });
  const d = new NpcDirector(c.net, () => 0, 1);
  d.density = 0;
  const car = d.spawnAt('driver', [{ edge: c.inLane.W, from: 20 }], 0);
  const at = pos(car, 0).x + 60;
  // left standing diagonally in the lane, nobody in it, the player gone
  d.setLeftVehicles([{ x: at, z: 1.5, heading: Math.PI / 4, kind: 'car' }]);
  for (let t = 0; t < 20 * TICK_HZ; t++) {
    d.update(t, [{ x: -100, z: 0, heading: 0 }]);
    const q = pos(car, t);
    if (Math.abs(q.z - 1.5) < 1) expect(at - q.x).toBeGreaterThan(3.4); // own half 2.25 + the left car's reach ~1.2
  }
});

test('a player car at 30 km/h knocks a walker down; it gets up and says "Bes do jeck?!"', () => {
  const { d, walker } = setup(3);
  const w = walker(40);
  const msgs: NpcMsg[] = [];
  let downAt = -1;
  run(d, 0, 8 * TICK_HZ, (t) => {
    const s = t / TICK_HZ;
    // a car drives along the sidewalk eastwards and reaches the walker at about 1 s
    const x = -70 + s * 8.3;
    return x < -40 ? [P(x, 5, 'drive', 8.3, 0)] : [];
  }, msgs);
  for (const m of msgs) if (m.t === 'plan' && m.plan.id === w.id && m.plan.action === 'down' && downAt < 0) downAt = m.plan.startTick;
  expect(downAt).toBeGreaterThan(0);
  expect(msgs.some((m) => m.t === 'plan' && m.plan.id === w.id && m.plan.action === 'getup')).toBe(true);
  expect(says(msgs, w.id).some((m) => (m as { line: number }).line === linesFor('hit')[0])).toBe(true);
  // thrown along the car's direction
  const landed = msgs.find((m) => m.t === 'plan' && m.plan.id === w.id && m.plan.action === 'down');
  if (landed?.t === 'plan') expect(landed.plan.path[landed.plan.path.length - 1]!.x).toBeGreaterThan(landed.plan.path[0]!.x + 1);
});

test('after being knocked down a walker goes on from where it landed, never back along its old route', () => {
  const { d, walker } = setup(3);
  const w = walker(20); // x = -80, walking east
  let knockX = NaN, minAfter = Infinity;
  run(d, 0, 24 * TICK_HZ, (t) => {
    const p = pos(w, t);
    if (Number.isNaN(knockX) && w.plan.action === 'down') knockX = p.x;
    if (!Number.isNaN(knockX)) minAfter = Math.min(minAfter, p.x);
    // after 10 s (the walker's plan started some 14 m back) a car along the sidewalk catches it up
    const x = -100 + (t / TICK_HZ - 10) * 8.3;
    return t > 10 * TICK_HZ && x < -40 ? [P(x, 5, 'drive', 8.3, 0)] : [];
  });
  expect(Number.isNaN(knockX)).toBe(false);
  expect(minAfter).toBeGreaterThan(knockX - 1);
});

test('bodiesNear lists only NPCs within the radius of a point', () => {
  const { d, walker } = setup(3);
  walker(40); // x = -60
  walker(85); // x = -15
  expect(d.bodiesNear(0, [{ x: -60, z: 5 }], 20).length).toBe(1);
  // people get bodies only within NPC_PERSON_BODY_RADIUS (25 m), even when a larger radius is asked
  expect(d.bodiesNear(0, [{ x: -60, z: 5 }], 60).length).toBe(1);
  expect(d.bodiesNear(0, [{ x: -37, z: 5 }], 60).length).toBe(2);
});
