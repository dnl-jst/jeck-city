import { expect, test } from 'vitest';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import { TUNING } from '../physics/tuning';
import { RESET_AFTER_S } from '../net/constants';
import type { WorldAssets } from './assets';
import { fixtureAssets } from './fixture.test-util';
import { WorldSim, type SimEvent } from './world-sim';

const N = NEUTRAL_INPUT(0);
const USE: PlayerInput = { ...N, use: true };

function run(sim: WorldSim, ticks: number, input: PlayerInput = N, id = 1): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) ev.push(...sim.step(new Map([[id, input]])));
  return ev;
}

/** The fixture with its bikes replaced. */
function withBikes(bikes: WorldAssets['manifest']['bikes']): WorldAssets {
  const a = fixtureAssets();
  return { ...a, manifest: { ...a.manifest, bikes } };
}

test('E next to a bike: mount, pedal off along the heading, step off to the side', async () => {
  const sim = await WorldSim.create(fixtureAssets());
  sim.addPlayer(1, { x: -5, z: -30 }); // 1 m left of bike 0 (at (−6, −30), facing +z)
  run(sim, 10);
  let ev = sim.step(new Map([[1, USE]]));
  expect(ev).toContainEqual({ t: 'mount', id: 1, bike: 0 });
  let p = sim.player(1);
  expect(p.mode).toBe('ride');
  expect(p.bikeId).toBe(0);
  expect(sim.bikes.rider[0]).toBe(1);
  expect(sim.riddenBike(1)!.type).toBe('dutch');
  run(sim, 60, { ...N, forward: 1 });
  p = sim.player(1);
  expect(p.pos.z).toBeGreaterThan(-29);
  expect(Math.abs(p.pos.x + 6)).toBeLessThan(0.05);
  expect(p.bike!.speed).toBeGreaterThan(1);
  expect(p.bike!.speed * 3.6).toBeLessThan(TUNING.bike.dismountJumpKmh); // slow: steps off, the bike stops
  ev = sim.step(new Map([[1, USE]]));
  const off = ev.find((e) => e.t === 'dismount');
  expect(off).toMatchObject({ t: 'dismount', id: 1, bike: 0, crash: false });
  p = sim.player(1);
  expect(p.mode).toBe('walk');
  expect(p.bikeId).toBeNull();
  expect(sim.bikes.rider[0]).toBeNull();
  const b = sim.bikes.poses[0]!;
  expect(Math.hypot(p.pos.x - b.x, p.pos.z - b.z)).toBeCloseTo(1, 1);
  run(sim, 30);
  expect(sim.player(1).char.grounded).toBe(true);
}, 30_000);

test('two players press E at one bike in the same tick: the first in the queue rides, the other is refused', async () => {
  const sim = await WorldSim.create(fixtureAssets());
  sim.addPlayer(1, { x: -5, z: -30 }); // 1 m left of bike 0
  sim.addPlayer(2, { x: -7, z: -30 }); // 1 m right of it
  for (let t = 0; t < 10; t++) sim.step(new Map([[1, N], [2, N]]));
  const ev = sim.step(new Map([[2, USE], [1, USE]])); // 2 arrived first
  expect(ev).toContainEqual({ t: 'mount', id: 2, bike: 0 });
  expect(ev).toContainEqual({ t: 'mountDenied', id: 1 });
  expect(sim.player(1).mode).toBe('walk');
  expect(sim.player(2).mode).toBe('ride');
  expect(sim.bikes.rider[0]).toBe(2);
}, 30_000);

test('E with a car and a bike in reach picks the one the figure faces', async () => {
  // car 0 at (5, 0), a bike at (1.5, 0): the player at (3.2, 0) has both in reach
  for (const [yaw, want] of [[Math.PI / 2, 'car'], [-Math.PI / 2, 'bike']] as const) {
    const sim = await WorldSim.create(withBikes([{ x: 1.5, z: 0, heading: 0, type: 1, color: 0 }]));
    sim.addPlayer(1, { x: 3.2, z: 0 });
    run(sim, 10);
    run(sim, 5, { ...N, forward: 1, yaw }); // a step towards it turns the figure
    run(sim, 20, NEUTRAL_INPUT(yaw));
    const ev = sim.step(new Map([[1, { ...NEUTRAL_INPUT(yaw), use: true }]]));
    expect(ev.find((e) => e.t === 'mount' || e.t === 'enter')?.t).toBe(want === 'car' ? 'enter' : 'mount');
  }
}, 30_000);

test('crashing into a tree throws the rider off: no control until up again', async () => {
  // the fixture's tree stands at (−10, −10); a bike 30 m before it, facing it
  const sim = await WorldSim.create(withBikes([{ x: -10, z: -40, heading: 0, type: 1, color: 0 }]));
  sim.addPlayer(1, { x: -9, z: -40 });
  run(sim, 10);
  sim.step(new Map([[1, USE]]));
  expect(sim.player(1).mode).toBe('ride');
  let crash: SimEvent | undefined;
  for (let t = 0; t < 600 && !crash; t++) crash = sim.step(new Map([[1, { ...N, forward: 1, run: true }]])).find((e) => e.t === 'dismount');
  expect(crash).toMatchObject({ t: 'dismount', id: 1, bike: 0, crash: true });
  expect(sim.bikes.poses[0]!.z).toBeLessThan(-10);
  const p = sim.player(1);
  expect(p.mode).toBe('down');
  expect(p.falling).toBe(true);
  // thrown from the saddle into the tree: bounces off it and comes down in front of it, never past it; meanwhile
  // walking input (sideways here) and E do nothing
  const bike = sim.bikes.poses[0]!;
  let top = 0, past = -Infinity;
  const ev: SimEvent[] = [];
  for (let t = 0; t < Math.round(TUNING.bike.getUpSeconds * 60) - 2; t++) {
    ev.push(...sim.step(new Map([[1, { ...N, forward: 1, use: true, yaw: Math.PI / 2 }]])));
    const q = sim.player(1).pos;
    top = Math.max(top, q.y);
    past = Math.max(past, q.z);
  }
  expect(ev.filter((e) => e.t === 'mount' || e.t === 'enter')).toEqual([]);
  const at = sim.player(1).pos;
  expect(top).toBeGreaterThan(0.6); // in the air from the saddle
  expect(past).toBeLessThan(-10 - 0.3); // the trunk at z = −10 stops it
  expect(Math.hypot(at.x - bike.x, at.z - bike.z)).toBeLessThan(4.5); // (bounced back off the trunk)
  expect(at.y).toBeLessThan(0.1); // lying on the ground by now
  run(sim, 5);
  expect(sim.player(1).mode).toBe('walk');
  expect(sim.player(1).falling).toBe(false);
  run(sim, 30, { ...N, forward: 1, yaw: Math.PI });
  expect(Math.hypot(sim.player(1).pos.x - at.x, sim.player(1).pos.z - at.z)).toBeGreaterThan(0.5);
}, 30_000);

test('head-on into the side of a car: thrown over the handlebar onto or over it, not stuck against its side', async () => {
  // the bike at (0, −60) facing +z, car 0 across its path 14 m ahead
  const a = withBikes([{ x: 0, z: -60, heading: 0, type: 1, color: 0 }]);
  a.manifest.parked[0] = { x: 0, z: -46, heading: Math.PI / 2, color: 0xff0000 };
  const sim = await WorldSim.create(a);
  sim.addPlayer(1, { x: 1, z: -60 });
  run(sim, 10);
  sim.step(new Map([[1, USE]]));
  expect(sim.player(1).mode).toBe('ride');
  let crash: SimEvent | undefined;
  for (let t = 0; t < 600 && !crash; t++) crash = sim.step(new Map([[1, { ...N, forward: 1, run: true }]])).find((e) => e.t === 'dismount');
  expect(crash).toMatchObject({ crash: true });
  let top = 0;
  for (let t = 0; t < Math.round(TUNING.bike.getUpSeconds * 60) - 2; t++) {
    sim.step(new Map([[1, N]]));
    top = Math.max(top, sim.player(1).pos.y);
  }
  const at = sim.player(1).pos, car = sim.cars.poses[0]!;
  expect(top).toBeGreaterThan(1.3); // up over the roof line
  // lying on the car or beyond its far side (the car is ~1.8 m wide, across z)
  expect(at.y > 1 || at.z > car.z + 0.9).toBe(true);
}, 30_000);

/** The fixture with one bike at (0, −60) facing +z and car 0 `gap` m behind it on the same line, facing it. */
function carBehindBike(gap: number): WorldAssets {
  const a = withBikes([{ x: 0, z: -60, heading: 0, type: 0, color: 0 }]);
  a.manifest.parked[0] = { x: 0, z: -60 - gap, heading: 0, color: 0xff0000 };
  return a;
}

/** Player 1 rides the bike (mounted from its left), player 2 sits in car 0 with the engine running. */
async function riderAndDriver(gap = 30): Promise<WorldSim> {
  const sim = await WorldSim.create(carBehindBike(gap));
  sim.addPlayer(1, { x: 1, z: -60 });
  sim.addPlayer(2, { x: 2.5, z: -60 - gap });
  for (let t = 0; t < 10; t++) sim.step(new Map([[1, N], [2, N]]));
  sim.step(new Map([[1, USE], [2, USE]]));
  expect(sim.player(1).mode).toBe('ride');
  expect(sim.player(2).mode).toBe('drive');
  for (let t = 0; t < 360; t++) sim.step(new Map([[1, N], [2, N]])); // the figure gets in, the engine starts
  return sim;
}

test('a car faster than KNOCKDOWN_KMH throws a rider off: crash, knock, no control while lying', async () => {
  const sim = await riderAndDriver();
  let ev: SimEvent[] = [];
  for (let t = 0; t < 600 && !ev.some((e) => e.t === 'knock'); t++) ev = sim.step(new Map([[1, N], [2, { ...N, forward: 1 }]]));
  expect(ev).toContainEqual({ t: 'knock', id: 1, by: 0 });
  expect(ev.find((e) => e.t === 'dismount')).toMatchObject({ id: 1, bike: 0, crash: true });
  expect(ev.some((e) => e.t === 'impact')).toBe(true);
  const p = sim.player(1);
  expect(p.mode === 'walk' || p.mode === 'down').toBe(true);
  expect(p.falling).toBe(true);
  expect(sim.bikes.rider[0]).toBeNull();
}, 30_000);

test('a slow car shoves a rider along without throwing them off', async () => {
  const sim = await riderAndDriver(8);
  const z0 = sim.player(1).pos.z;
  const ev: SimEvent[] = [];
  // creep: a little throttle, then let it roll; the car stays under KNOCKDOWN_KMH
  for (let t = 0; t < 900; t++) {
    const v = sim.cars.vehicle(0)!.speed();
    ev.push(...sim.step(new Map([[1, N], [2, { ...N, forward: v < 1.2 ? 0.4 : 0 }]])));
  }
  expect(ev.filter((e) => e.t === 'knock' || e.t === 'dismount')).toEqual([]);
  expect(sim.player(1).mode).toBe('ride');
  expect(sim.player(1).pos.z).toBeGreaterThan(z0 + 0.5);
}, 30_000);

test('a moved bike goes home after RESET_AFTER_S without riders, only with nobody near', async () => {
  const sim = await WorldSim.create(fixtureAssets());
  sim.addPlayer(1, { x: -5, z: -30 });
  run(sim, 10);
  sim.step(new Map([[1, USE]]));
  run(sim, 60, { ...N, forward: 1 });
  sim.step(new Map([[1, USE]]));
  run(sim, 120);
  expect(sim.bikes.isMoved(0)).toBe(true);
  sim.advanceIdleTicks(RESET_AFTER_S * 60);
  run(sim, 61);
  expect(sim.bikes.isMoved(0)).toBe(true); // the player is still near
  sim.removePlayer(1);
  sim.addPlayer(1, { x: 120, z: 120 }); // > RESET_CLEAR_RADIUS away
  sim.advanceIdleTicks(RESET_AFTER_S * 60);
  run(sim, 61);
  expect(sim.bikes.isMoved(0)).toBe(false);
  expect(sim.bikes.poses[0]).toMatchObject({ x: -6, z: -30, heading: 0 });
}, 30_000);

test('bell held every tick yields at most one event per 15 ticks', async () => {
  const sim = await riderAndDriver();
  const ticks: number[] = [];
  for (let t = 0; t < 120; t++) {
    if (sim.step(new Map([[1, { ...N, bell: true }], [2, N]])).some((e) => e.t === 'bell')) ticks.push(t);
  }
  expect(ticks).toEqual([0, 15, 30, 45, 60, 75, 90, 105]);
}, 30_000);

test('bell rings as a positional event while riding; the horn shows on the car while held', async () => {
  const sim = await riderAndDriver();
  const ev = sim.step(new Map([[1, { ...N, bell: true }], [2, { ...N, horn: true }]]));
  const bell = ev.find((e) => e.t === 'bell');
  expect(bell).toMatchObject({ t: 'bell', id: 1 });
  expect(Math.hypot((bell as { x: number }).x - 0, (bell as { z: number }).z + 60)).toBeLessThan(0.5);
  expect(sim.horning(0)).toBe(true);
  sim.step(new Map([[1, N], [2, N]]));
  expect(sim.horning(0)).toBe(false);
}, 30_000);

test('standing on a car that drives off (and turns): rides along on the roof, not swept off', async () => {
  const a = withBikes([]);
  a.manifest.parked[0] = { x: 0, z: -60, heading: 0, color: 0xff0000 };
  const sim = await WorldSim.create(a);
  sim.addPlayer(1, { x: 4, z: -60 });
  sim.addPlayer(2, { x: 1.5, z: -60 });
  for (let t = 0; t < 10; t++) sim.step(new Map([[1, N], [2, N]]));
  sim.step(new Map([[1, N], [2, USE]]));
  expect(sim.player(2).mode).toBe('drive');
  for (let t = 0; t < 360; t++) sim.step(new Map([[1, N], [2, N]])); // the figure gets in, the engine starts
  // player 1 onto the middle of the roof
  const car = sim.cars.vehicle(0)!.pose();
  sim.onFoot().find((p) => p.id === 1)!.char.teleport({ x: car.x, y: car.y + 1.2, z: car.z });
  for (let t = 0; t < 30; t++) sim.step(new Map([[1, N], [2, N]]));
  const roof = sim.player(1).pos.y;
  expect(roof).toBeGreaterThan(1);
  // 4 s: full throttle, then steering
  for (let t = 0; t < 240; t++) sim.step(new Map([[1, N], [2, { ...N, forward: 1, right: t > 120 ? 0.6 : 0 }]]));
  const now = sim.cars.vehicle(0)!.pose(), p = sim.player(1);
  expect(Math.hypot(now.x - car.x, now.z - car.z)).toBeGreaterThan(15); // the car went somewhere
  expect(Math.hypot(p.pos.x - now.x, p.pos.z - now.z)).toBeLessThan(1.2); // still on it
  expect(p.pos.y).toBeGreaterThan(roof - 0.3);
  expect(Math.hypot(p.vel.x, p.vel.z)).toBeLessThan(1); // standing (relative to the car): no running animation
}, 30_000);

test('a passenger standing on a cargo bike rides along; the bike does not crash into them', async () => {
  const sim = await WorldSim.create(withBikes([{ x: 0, z: -60, heading: 0, type: 3, color: 0 }]));
  sim.addPlayer(1, { x: 1, z: -60 });
  sim.addPlayer(2, { x: -1.5, z: -60 });
  for (let t = 0; t < 10; t++) sim.step(new Map([[1, N], [2, N]]));
  sim.step(new Map([[1, USE], [2, N]]));
  expect(sim.player(1).mode).toBe('ride');
  const b0 = sim.bikes.poses[0]!;
  sim.onFoot().find((p) => p.id === 2)!.char.teleport({ x: b0.x, y: b0.y + 1, z: b0.z });
  for (let t = 0; t < 30; t++) sim.step(new Map([[1, N], [2, N]]));
  const on = sim.player(2).pos.y;
  expect(on).toBeGreaterThan(0.7);
  const ev: SimEvent[] = [];
  for (let t = 0; t < 240; t++) ev.push(...sim.step(new Map([[1, { ...N, forward: 1, right: t > 150 ? 0.4 : 0 }], [2, N]])));
  expect(ev.filter((e) => e.t === 'dismount')).toEqual([]);
  const b = sim.riddenBike(1)!.state(), p = sim.player(2);
  expect(Math.hypot(b.x - b0.x, b.z - b0.z)).toBeGreaterThan(8);
  expect(Math.hypot(p.pos.x - b.x, p.pos.z - b.z)).toBeLessThan(0.8);
  expect(p.pos.y).toBeGreaterThan(on - 0.2);
  expect(Math.hypot(p.vel.x, p.vel.z)).toBeLessThan(0.5);
}, 30_000);
