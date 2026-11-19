import { expect, test } from 'vitest';
import { NEUTRAL_INPUT } from './net/codec';
import { fixtureAssets } from './sim/fixture.test-util';
import { WorldSim } from './sim/world-sim';
import { nextArrivals, SECTION_STRIDE, sectionOffset, sectionStates, TRAIN_LENGTH, TRAIN_SECTIONS, transitModel, type Transit } from './transit';

/** A straight track along +z at x = 60, its rail top 0.35 m below the ground (so the train's floor is level with it), one stop in the middle. */
const transit: Transit = {
  headway: 300,
  stations: [{ name: 'Mitte', x: 62, y: 0, z: 0 }],
  tracks: [{ pts: [60, -0.35, -120, 60, -0.35, 120], stops: [{ station: 0, s: 120, side: 1 }] }],
  openings: [[-60, -60, -56, -60, -56, -56, -60, -56]],
};
const S = SECTION_STRIDE;

test('a train runs from the start of the track to its end, standing at the stop with the platform doors open', () => {
  const m = transitModel(transit);
  expect(m.tracks[0]!.slots).toBe(2);
  let stood = 0, last = -Infinity, opened = false;
  for (let tick = 0; tick < 70 * 60; tick += 6) {
    const s = sectionStates(m, tick);
    if (s[0] !== 1) continue;
    const z = s[3]!; // tail section
    expect(z).toBeGreaterThanOrEqual(last - 1e-9); // never backwards, no jumps
    expect(z - last === Infinity || z - last < 2).toBe(true);
    last = z;
    if (s[9] === 0) {
      stood++;
      expect(s[8]).toBe(0);
      expect(s[7]).toBe(0); // the other side stays shut
      if (s[6] === 1) opened = true;
    } else expect(s[6]).toBe(0);
  }
  expect(stood).toBeGreaterThan(100);
  expect(opened).toBe(true);
  expect(last).toBeGreaterThan(120 - TRAIN_LENGTH - 5);
});

test('the sections of a train follow each other along the track', () => {
  const m = transitModel(transit), s = sectionStates(m, 25 * 60);
  for (let i = 0; i < TRAIN_SECTIONS; i++) {
    expect(s[i * S]).toBe(1);
    expect(s[i * S + 1]).toBeCloseTo(60, 6);
    expect(s[i * S + 3]).toBeCloseTo(sectionOffset(i), 6); // standing at the stop (z = 0 is s = 120)
    expect(s[i * S + 4]).toBeCloseTo(0, 6);
  }
});

test('someone standing in a train is carried along when it leaves', async () => {
  const a = fixtureAssets();
  a.manifest.transit = transit;
  const sim = await WorldSim.create(a);
  sim.setTransitTick(39 * 60); // standing at the stop, about to leave
  const z0 = sectionOffset(3);
  sim.addPlayer(1, { x: 60.3, z: z0 });
  const N = NEUTRAL_INPUT(0);
  for (let i = 0; i < 9 * 60; i++) sim.step(new Map([[1, N]]));
  const p = sim.player(1).pos, s = sectionStates(sim.trains!.model, sim.transitTick);
  expect(s[3 * S + 3]! - z0).toBeGreaterThan(5); // the train has left
  expect(p.z - s[3 * S + 3]!).toBeCloseTo(0, 1); // … and the player with it, where they stood in it
  expect(p.x).toBeCloseTo(60.3, 1);
});

test('inside an opening in the ground the terrain does not hold a person', async () => {
  const a = fixtureAssets();
  a.manifest.transit = transit;
  const sim = await WorldSim.create(a);
  sim.addPlayer(1, { x: -58, z: -58 });
  sim.addPlayer(2, { x: -50, z: -58 });
  const N = NEUTRAL_INPUT(0);
  for (let i = 0; i < 60; i++) sim.step(new Map([[1, N], [2, N]]));
  expect(sim.player(1).pos.y).toBeLessThan(-2);
  expect(sim.player(2).pos.y).toBeCloseTo(0, 1);
});

test('nextArrivals counts down to the moment the train stands at the stop', () => {
  const m = transitModel(transit);
  // when trip 0 arrives: the first tick its sections report the station
  let arrive = 0;
  while (sectionStates(m, arrive)[9] !== 0) arrive++;
  const before = nextArrivals(m, 0, 0, arrive - 600);
  expect(before[0]!.wait).toBeCloseTo(10, 1);
  expect(before[0]!.trip).toBe(0);
  expect(before[1]!.wait).toBeCloseTo(310, 1);
  expect(nextArrivals(m, 0, 0, arrive + 300)[0]).toEqual({ wait: 0, trip: 0 }); // standing
  let leave = arrive;
  while (sectionStates(m, leave)[9] === 0) leave++;
  const after = nextArrivals(m, 0, 0, leave + 60)[0]!;
  expect(after.trip).toBe(1);
  expect(after.wait).toBeCloseTo(300 - (leave + 60 - arrive) / 60, 1);
});

test('a car over an opening in the ground is not held by the terrain either', async () => {
  const a = fixtureAssets();
  // car 0 of the fixture stands at (5, 0): the opening around it
  a.manifest.transit = { ...transit, openings: [[3, -3, 7, -3, 7, 3, 3, 3]] };
  const sim = await WorldSim.create(a);
  sim.addPlayer(1, { x: 7.5, z: 0 });
  const N = NEUTRAL_INPUT(0);
  sim.step(new Map([[1, { ...N, use: true }]]));
  expect(sim.player(1).mode).toBe('drive');
  for (let i = 0; i < 240; i++) sim.step(new Map([[1, { ...N, forward: 1 }]]));
  expect(sim.player(1).pos.y).toBeLessThan(-2);
});

test('someone in a standing train walks out through the open door onto the platform, and back in', async () => {
  const a = fixtureAssets();
  // the train's floor 1 m above the ground, and a platform slab level with it from 1.45 m beside the track
  a.manifest.transit = { ...transit, tracks: [{ ...transit.tracks[0]!, pts: [60, 0.65, -120, 60, 0.65, 120] }] };
  a.collision = {
    ...a.collision,
    vertices: new Float32Array([61.45, 1, -20, 80, 1, -20, 80, 1, 30, 61.45, 1, 30, 61.45, 0, -20, 61.45, 0, 30]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 3, 4, 3, 0]),
  };
  const sim = await WorldSim.create(a);
  sim.setTransitTick(25 * 60); // standing at the stop, doors open on the left (+x)
  sim.addPlayer(1, { x: 70, z: sectionOffset(3) }); // on the platform
  const walk = (yaw: number) => ({ ...NEUTRAL_INPUT(yaw), forward: 1 });
  for (let i = 0; i < 400 && sim.player(1).pos.x > 60.2; i++) sim.step(new Map([[1, walk(-Math.PI / 2)]]));
  expect(sim.player(1).pos.x).toBeLessThan(60.3); // in
  expect(sim.player(1).pos.y).toBeCloseTo(1, 1);
  for (let i = 0; i < 150; i++) sim.step(new Map([[1, walk(Math.PI / 2)]]));
  expect(sim.player(1).pos.x).toBeGreaterThan(63); // out again, onto the platform
  expect(sim.player(1).pos.y).toBeCloseTo(1, 1);
});

test('E in a train sits down on the nearest bench and stands up again; the benches are solid', async () => {
  const a = fixtureAssets();
  a.manifest.transit = { ...transit, tracks: [{ ...transit.tracks[0]!, pts: [60, 0.65, -120, 60, 0.65, 120] }] };
  const sim = await WorldSim.create(a);
  sim.setTransitTick(25 * 60);
  const z0 = sectionOffset(4); // a middle section: benches both sides of its door
  sim.addPlayer(1, { x: 20, z: 20 });
  const ch = (sim as unknown as { list: Map<number, { char: { teleport(p: { x: number; y: number; z: number }): void } }> }).list.get(1)!.char;
  ch.teleport({ x: 60, y: 1.02, z: z0 }); // in the aisle at the door
  const N = NEUTRAL_INPUT(0);
  // walking along the aisle is free, walking sideways into a bench is not
  for (let i = 0; i < 60; i++) sim.step(new Map([[1, { ...N, forward: 1 }]]));
  expect(sim.player(1).pos.z).toBeGreaterThan(z0 + 1.2);
  for (let i = 0; i < 60; i++) sim.step(new Map([[1, { ...NEUTRAL_INPUT(Math.PI / 2), forward: 1 }]]));
  expect(sim.player(1).pos.x).toBeLessThan(60.35);
  expect(sim.player(1).pos.y).toBeCloseTo(1, 1);
  // E: up onto the cushion, half a metre above the floor, beside the aisle
  sim.step(new Map([[1, { ...N, use: true }]]));
  for (let i = 0; i < 30; i++) sim.step(new Map([[1, N]]));
  const sat = sim.player(1).pos;
  expect(sat.y).toBeCloseTo(1.5, 1);
  expect(Math.abs(sat.x - 60)).toBeGreaterThan(0.4);
  // E again: back down into the aisle
  sim.step(new Map([[1, { ...N, use: true }]]));
  for (let i = 0; i < 30; i++) sim.step(new Map([[1, N]]));
  expect(sim.player(1).pos.y).toBeCloseTo(1, 1);
  expect(Math.abs(sim.player(1).pos.x - 60)).toBeLessThan(0.1);
});

test('walking along a train at full speed crosses the joint between two sections', async () => {
  const a = fixtureAssets();
  a.manifest.transit = { ...transit, tracks: [{ pts: [60, 0.65, -140, 60, 0.65, 140], stops: [] }] };
  const sim = await WorldSim.create(a);
  const S = SECTION_STRIDE;
  // under way, fast
  let tick = 0;
  while (sectionStates(sim.trains!.model, tick)[8]! < 12) tick += 30;
  sim.setTransitTick(tick);
  const s0 = sectionStates(sim.trains!.model, tick);
  sim.addPlayer(1, { x: 20, z: 20 });
  const ch = (sim as unknown as { list: Map<number, { char: { teleport(p: { x: number; y: number; z: number }): void } }> }).list.get(1)!.char;
  ch.teleport({ x: 60, y: s0[1 * S + 2]! + 0.37, z: s0[1 * S + 3]! + 3 }); // in the middle section of the rear unit, near its front
  for (let i = 0; i < 150; i++) sim.step(new Map([[1, { ...NEUTRAL_INPUT(0), forward: 1 }]]));
  const s1 = sectionStates(sim.trains!.model, sim.transitTick), p = sim.player(1).pos;
  // 2.5 s of walking (1.6 m/s): from 3 m ahead of section 1's middle to about 2.4 m behind section 2's
  expect(p.z - s1[2 * S + 3]!).toBeGreaterThan(-3.2);
  expect(p.z - s1[2 * S + 3]!).toBeLessThan(-1.6);
});

test('someone sitting on a bench stays there while the train leaves and runs', async () => {
  const a = fixtureAssets();
  a.manifest.transit = { ...transit, tracks: [{ ...transit.tracks[0]!, pts: [60, 0.65, -120, 60, 0.65, 120] }] };
  const sim = await WorldSim.create(a);
  sim.setTransitTick(39 * 60); // about to leave
  const S = SECTION_STRIDE, z0 = sectionOffset(4);
  sim.addPlayer(1, { x: 20, z: 20 });
  const ch = (sim as unknown as { list: Map<number, { char: { teleport(p: { x: number; y: number; z: number }): void } }> }).list.get(1)!.char;
  ch.teleport({ x: 60, y: 1.02, z: z0 + 1.6 });
  const N = NEUTRAL_INPUT(0);
  sim.step(new Map([[1, { ...N, use: true }]]));
  for (let i = 0; i < 20; i++) sim.step(new Map([[1, N]]));
  const sat = sim.player(1).pos, s0 = sectionStates(sim.trains!.model, sim.transitTick);
  expect(sat.y).toBeCloseTo(1.5, 1);
  const rel = { x: sat.x - s0[4 * S + 1]!, z: sat.z - s0[4 * S + 3]! };
  for (let i = 0; i < 600; i++) sim.step(new Map([[1, N]]));
  const p = sim.player(1).pos, s1 = sectionStates(sim.trains!.model, sim.transitTick);
  expect(s1[4 * S + 3]! - s0[4 * S + 3]!).toBeGreaterThan(20); // the train is on its way
  expect(p.y).toBeCloseTo(1.5, 1);
  expect(p.x - s1[4 * S + 1]!).toBeCloseTo(rel.x, 2);
  expect(p.z - s1[4 * S + 3]!).toBeCloseTo(rel.z, 2);
});
