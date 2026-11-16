import { expect, test } from 'vitest';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import { TUNING } from '../physics/tuning';
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
  const sim = await WorldSim.create(fixtureAssets(), { riding: true });
  sim.addPlayer(1, { x: -5, z: -30 }); // 1 m left of bike 0 (at (−6, −30), facing +z)
  run(sim, 10);
  let ev = sim.step(new Map([[1, USE]]));
  expect(ev).toContainEqual({ t: 'mount', id: 1, bike: 0 });
  let p = sim.player(1);
  expect(p.mode).toBe('ride');
  expect(p.bikeId).toBe(0);
  expect(sim.bikes.ridden).toBe(0);
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
  expect(sim.bikes.ridden).toBeNull();
  const b = sim.bikes.poses[0]!;
  expect(Math.hypot(p.pos.x - b.x, p.pos.z - b.z)).toBeCloseTo(1, 1);
  run(sim, 30);
  expect(sim.player(1).char.grounded).toBe(true);
}, 30_000);

test('riding off (online sims): E next to a bike does nothing, the parked bike still has a body', async () => {
  const sim = await WorldSim.create(fixtureAssets());
  sim.addPlayer(1, { x: -5, z: -30 });
  run(sim, 10);
  const ev = sim.step(new Map([[1, USE]]));
  expect(ev.filter((e) => e.t === 'mount')).toEqual([]);
  expect(sim.player(1).mode).toBe('walk');
  expect(sim.bikes.activeIds()).toContain(0);
}, 30_000);

test('E with a car and a bike in reach picks the one the figure faces', async () => {
  // car 0 at (5, 0), a bike at (1.5, 0): the player at (3.2, 0) has both in reach
  for (const [yaw, want] of [[Math.PI / 2, 'car'], [-Math.PI / 2, 'bike']] as const) {
    const sim = await WorldSim.create(withBikes([{ x: 1.5, z: 0, heading: 0, type: 1, color: 0 }]), { riding: true });
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
  const sim = await WorldSim.create(withBikes([{ x: -10, z: -40, heading: 0, type: 1, color: 0 }]), { riding: true });
  sim.addPlayer(1, { x: -9, z: -40 });
  run(sim, 10);
  sim.step(new Map([[1, USE]]));
  expect(sim.player(1).mode).toBe('ride');
  let crash: SimEvent | undefined;
  for (let t = 0; t < 600 && !crash; t++) crash = sim.step(new Map([[1, { ...N, forward: 1, run: true }]])).find((e) => e.t === 'dismount');
  expect(crash).toMatchObject({ t: 'dismount', id: 1, bike: 0, crash: true });
  expect(sim.bikes.poses[0]!.z).toBeLessThan(-10);
  const p = sim.player(1);
  expect(p.mode).toBe('walk');
  expect(p.falling).toBe(true);
  // lying: walking input and E do nothing
  const at = p.pos;
  const ev = run(sim, Math.round(TUNING.bike.getUpSeconds * 60) - 2, { ...N, forward: 1, use: true });
  expect(ev.filter((e) => e.t === 'mount' || e.t === 'enter')).toEqual([]);
  expect(Math.hypot(sim.player(1).pos.x - at.x, sim.player(1).pos.z - at.z)).toBeLessThan(0.1);
  run(sim, 5);
  expect(sim.player(1).falling).toBe(false);
  run(sim, 30, { ...N, forward: 1, yaw: Math.PI });
  expect(Math.hypot(sim.player(1).pos.x - at.x, sim.player(1).pos.z - at.z)).toBeGreaterThan(0.5);
}, 30_000);
