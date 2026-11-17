import { expect, test } from 'vitest';
import { TICK_HZ } from '../net/constants';
import { planAt } from '../npc/plan';
import { crossNet, type Arm } from './npc-cross-fixture';
import { NpcDirector, type Focus, type NpcState, type PlayerNear } from './npc-director';
import { lightAllows } from './npc-junctions';

const flat = () => 0;
const F: Focus[] = [{ x: 0, z: 0, heading: 0 }];

function setup(opts: Parameters<typeof crossNet>[0] = {}) {
  const c = crossNet(opts);
  const d = new NpcDirector(c.net, flat, 1);
  d.density = 0; // only the NPCs a test places
  return { c, d };
}
/** A car on arm a's in-lane, `back` m before the lane's end, routed through the junction to arm b. */
function car(d: NpcDirector, c: ReturnType<typeof crossNet>, a: Arm, b: Arm, back: number, tick = 0, kind: 'driver' | 'cyclist' = 'driver'): NpcState {
  const L = c.armLength - 8;
  return d.spawnAt(kind, [{ edge: c.inLane[a], from: L - back }, { edge: c.turn(a, b), from: 0 }, { edge: c.outLane[b], from: 0 }], tick);
}
const pos = (n: NpcState, t: number) => planAt(n.plan, t);
const step = (d: NpcDirector, from: number, to: number, each?: (t: number) => void, foci: Focus[] = F) => {
  for (let t = from; t < to; t++) {
    d.update(t, foci);
    each?.(t);
  }
  return to;
};
const onTurn = (d: NpcDirector, c: ReturnType<typeof crossNet>, n: NpcState, t: number) => c.net.junctions[0]!.turns.includes(d.currentLeg(n, t)?.edge ?? -1);

test('lightAllows: green goes, red stops, amber goes only when it cannot stop', () => {
  expect(lightAllows('green', 30, 10)).toBe(true);
  expect(lightAllows('red', 30, 10)).toBe(false);
  expect(lightAllows('redAmber', 30, 10)).toBe(false);
  expect(lightAllows('amber', 5, 13.9)).toBe(true);
  expect(lightAllows('amber', 60, 13.9)).toBe(false);
});

test('a following car never closes below the gap', () => {
  const { c, d } = setup({ signal: true }); // E/W red for the first 25 s
  const a = car(d, c, 'W', 'E', 40), b = car(d, c, 'W', 'E', 70);
  step(d, 0, 30 * TICK_HZ, (t) => {
    const p = pos(a, t), q = pos(b, t);
    expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(6);
  });
});

test('stops at red on the stop line and goes on green', () => {
  const { c, d } = setup({ signal: true });
  const a = car(d, c, 'W', 'E', 40);
  const stopX = -(8 + 3);
  step(d, 0, 25 * TICK_HZ);
  const p = pos(a, 25 * TICK_HZ);
  expect(p.x).toBeLessThanOrEqual(stopX + 0.05);
  expect(p.x).toBeGreaterThan(stopX - 1);
  expect(p.speed).toBeLessThan(0.05);
  // E/W green from 26 s: moving within a second
  step(d, 25 * TICK_HZ, 27 * TICK_HZ + 1);
  expect(pos(a, 27 * TICK_HZ).x).toBeGreaterThan(stopX + 0.2);
});

test('walker waits for the green man', () => {
  const { c, d } = setup({ signal: true });
  // the sidewalk right of the north arm's in-lane ends at the west end (-5, -10) of the north crossing (group 1:
  // green from 26 s); the walker crosses it eastwards
  const L = c.armLength - 10;
  const w = d.spawnAt('walker', [{ edge: c.sidewalk.N, from: L - 6 }, { edge: c.crossing.N, from: 10, to: 0 }], 0);
  let entered = -1;
  step(d, 0, 40 * TICK_HZ, (t) => {
    const p = pos(w, t);
    if (entered < 0 && p.x > -4.7 && Math.abs(p.z + 10) < 0.5) entered = t;
  });
  expect(entered).toBeGreaterThanOrEqual(26 * TICK_HZ);
  expect(entered).toBeLessThan(28 * TICK_HZ);
});

test('right before left', () => {
  const { c, d } = setup();
  const w = car(d, c, 'W', 'E', 30), s = car(d, c, 'S', 'N', 30); // S lies right of a car going east
  let first: string | null = null;
  step(d, 0, 20 * TICK_HZ, (t) => {
    if (first) return;
    if (onTurn(d, c, s, t)) first = 'S';
    else if (onTurn(d, c, w, t)) first = 'W';
  });
  expect(first).toBe('S');
});

test('the major road goes first', () => {
  const { c, d } = setup({ ranks: { W: 4, E: 4, N: 2, S: 2 } });
  const w = car(d, c, 'W', 'E', 30), s = car(d, c, 'S', 'N', 30);
  let first: string | null = null;
  step(d, 0, 20 * TICK_HZ, (t) => {
    if (first) return;
    if (onTurn(d, c, w, t)) first = 'W';
    else if (onTurn(d, c, s, t)) first = 'S';
  });
  expect(first).toBe('W');
});

test('four-way standoff resolves by longest wait', () => {
  const { c, d } = setup();
  const cars = (['N', 'E', 'S', 'W'] as Arm[]).map((a) => car(d, c, a, a === 'N' ? 'S' : a === 'S' ? 'N' : a === 'E' ? 'W' : 'E', 20));
  const through = new Set<number>();
  step(d, 0, 30 * TICK_HZ, (t) => {
    for (const n of cars) if (onTurn(d, c, n, t)) through.add(n.id);
  });
  expect(through.size).toBe(4);
});

test('a player car coming from the right makes the npc wait', () => {
  const { c, d } = setup();
  const w = car(d, c, 'W', 'E', 25);
  let entered = -1;
  step(d, 0, 12 * TICK_HZ, (t) => {
    // a player drives north on the S arm's in-lane at 8 m/s, passing the centre at t = 3 s, gone after 6 s
    const z = 24 - (t / TICK_HZ) * 8;
    const players: PlayerNear[] = t < 6 * TICK_HZ ? [{ id: 1, x: 1.5, z, vx: 0, vz: -8, mode: 'drive' }] : [];
    d.setPlayers(players);
    if (entered < 0 && onTurn(d, c, w, t)) entered = t;
  });
  expect(entered).toBeGreaterThan(2.5 * TICK_HZ);
});

test('a player blocking the junction centre holds all approaches and they clear after he leaves', () => {
  const { c, d } = setup();
  const cars = (['N', 'E', 'S', 'W'] as Arm[]).map((a) => car(d, c, a, a === 'N' ? 'S' : a === 'S' ? 'N' : a === 'E' ? 'W' : 'E', 25));
  d.setPlayers([{ id: 1, x: 0, z: 0, vx: 0, vz: 0, mode: 'walk' }]);
  step(d, 0, 15 * TICK_HZ, (t) => {
    for (const n of cars) {
      const p = pos(n, t);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(2.5); // nobody runs into the player
    }
  });
  d.setPlayers([]);
  const through = new Set<number>();
  step(d, 15 * TICK_HZ, 45 * TICK_HZ, (t) => {
    for (const n of cars) if (onTurn(d, c, n, t)) through.add(n.id);
  });
  expect(through.size).toBe(4);
});

test('never two vehicles on crossing turn edges of one junction', () => {
  const { c, d } = setup({ len: 200 });
  const arms: Arm[] = ['N', 'E', 'S', 'W'];
  let k = 0;
  for (const a of arms) for (let i = 0; i < 6; i++) car(d, c, a, arms[(arms.indexOf(a) + 1 + (k++ % 3)) % 4]!, 20 + i * 25);
  const conflicts = d.turnConflicts(0);
  step(d, 0, 120 * TICK_HZ, (t) => {
    if (t % 6) return;
    const on = [...d.all()].map((n) => d.currentLeg(n, t)?.edge).filter((e): e is number => e !== undefined && c.net.junctions[0]!.turns.includes(e));
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) expect(conflicts.has(`${Math.min(on[i]!, on[j]!)},${Math.max(on[i]!, on[j]!)}`)).toBe(false);
  });
});

test('car waits for a walker on an unsignalled crossing', () => {
  const { c, d } = setup();
  const L = c.armLength - 10;
  // the walker steps onto the crossing over the east arm (its out-lane is where the car turns onto)
  const w = d.spawnAt('walker', [{ edge: c.sidewalk.E, from: L - 1 }, { edge: c.crossing.E, from: 10, to: 0 }], 0);
  const n = car(d, c, 'W', 'E', 15);
  let met = false;
  step(d, 0, 12 * TICK_HZ, (t) => {
    const p = pos(w, t), q = pos(n, t);
    if (Math.abs(p.x - 10) < 0.5 && p.z > -4.5 && p.z < 4.5) {
      met = true;
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThan(2.5);
    }
  });
  expect(met).toBe(true);
});

test('car overtakes a slow cyclist when the oncoming lane is clear, else follows; never near a junction', () => {
  const { c, d } = setup({ len: 400 });
  const L = 400 - 8;
  const bike = d.spawnAt('cyclist', [{ edge: c.inLane.W, from: L - 300 }], 0, 3.5);
  const n = d.spawnAt('driver', [{ edge: c.inLane.W, from: L - 340 }], 0);
  let passed = -1, beside = 0;
  // the player stands by the road (NPCs farther than 300 m from every player are dissolved)
  const watch: Focus[] = [{ x: -200, z: 10, heading: 0 }];
  step(d, 0, 40 * TICK_HZ, (t) => {
    const p = pos(n, t), b = pos(bike, t);
    if (passed < 0 && p.x > b.x + 5) passed = t;
    if (Math.abs(p.z - b.z) > 2) beside++;
    // never alongside within 30 m of the junction; never through the cyclist
    if (Math.abs(p.x) < 38 && Math.abs(p.z - b.z) > 1) expect(Math.abs(p.x - b.x)).toBeGreaterThan(8);
    if (Math.abs(p.z - b.z) < 1) expect(Math.abs(p.x - b.x)).toBeGreaterThan(3);
  }, watch);
  expect(passed).toBeGreaterThan(0);
  expect(beside).toBeGreaterThan(0); // it went round on the other lane

  // with oncoming traffic on the E→W lane the car follows
  const s2 = setup({ len: 400 });
  const bike2 = s2.d.spawnAt('cyclist', [{ edge: s2.c.inLane.W, from: L - 300 }], 0, 3.5);
  const car2 = s2.d.spawnAt('driver', [{ edge: s2.c.inLane.W, from: L - 340 }], 0);
  // a steady oncoming flow for the whole 15 s (every 20 m)
  for (let i = 0; i < 19; i++) s2.d.spawnAt('driver', [{ edge: s2.c.outLane.W, from: 10 + i * 20 }], 0);
  step(s2.d, 0, 15 * TICK_HZ, (t) => {
    expect(pos(car2, t).x).toBeLessThan(pos(bike2, t).x - 3);
  }, watch);
});
