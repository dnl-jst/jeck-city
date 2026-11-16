import { describe, expect, test } from 'vitest';
import { NEUTRAL_INPUT } from '../net/codec';
import { Interest } from '../net/interest';
import { fixtureAssets } from './fixture.test-util';
import { buildSnapshot } from './snapshot';
import { WorldSim } from './world-sim';

const slotOf = (id: number) => id + 10;
const N = NEUTRAL_INPUT(0);

async function world(): Promise<WorldSim> {
  const sim = await WorldSim.create(fixtureAssets());
  sim.addPlayer(1, { x: 0, z: 10 });
  sim.addPlayer(2, { x: 0, z: 14 });
  for (let t = 0; t < 120; t++) sim.step(new Map());
  return sim;
}

describe('buildSnapshot', () => {
  test('own player not in walkers; the other one is', async () => {
    const sim = await world();
    const s = buildSnapshot(sim, 1, new Interest(), 7, [], slotOf);
    expect(s.ackSeq).toBe(7);
    expect(s.walkers.map((w) => w.slot)).toEqual([12]);
    expect(s.walkers[0]!.state).toBe(0);
    expect(s.own.mode).toBe(0);
  });

  test('sleeping parked cars are never in snapshots', async () => {
    const sim = await world();
    expect(sim.cars.awake()).toEqual([]);
    expect(buildSnapshot(sim, 1, new Interest(), 0, [], slotOf).cars).toEqual([]);
  });

  test('pushed car is streamed while awake', async () => {
    const sim = await world();
    sim.cars.vehicle(0)!.chassis.wakeUp();
    const s = buildSnapshot(sim, 1, new Interest(), 0, [], slotOf);
    expect(s.cars.map((c) => c.id)).toEqual([0]);
    expect(s.cars[0]!.hasDriver).toBe(false);
  });

  test('driver is a car, not a walker, and the own car is not duplicated', async () => {
    const sim = await world();
    sim.addPlayer(3, { x: 6.5, z: 0 });
    sim.step(new Map([[3, { ...N, use: true }]]));
    const other = buildSnapshot(sim, 1, new Interest(), 0, [], slotOf);
    expect(other.walkers.map((w) => w.slot)).toEqual([12]);
    expect(other.cars.filter((c) => c.hasDriver)).toHaveLength(1);
    const mine = buildSnapshot(sim, 3, new Interest(), 0, [], slotOf);
    expect(mine.cars).toEqual([]);
    expect(mine.own.mode).toBe(1);
    expect(mine.own.car).not.toBeNull();
  });

  test('brake light follows the driver input, not the speed', async () => {
    const sim = await world();
    sim.addPlayer(3, { x: 6.5, z: 0 });
    sim.step(new Map([[3, { ...N, use: true }]]));
    const light = () => buildSnapshot(sim, 1, new Interest(), 0, [], slotOf).cars.find((c) => c.hasDriver)!.brakeLight;
    expect(light()).toBe(false); // standing, no brake
    sim.step(new Map([[3, { ...N, brake: true }]]));
    expect(light()).toBe(true);
    sim.step(new Map([[3, N]]));
    expect(light()).toBe(false);
  });

  test('events: knock for oneself always, others by range', async () => {
    const sim = await world();
    const ev = [
      { t: 'knock' as const, id: 1, by: 0 }, { t: 'knock' as const, id: 2, by: 0 },
      { t: 'impact' as const, x: 1000, z: 0, strength: 1 }, { t: 'impact' as const, x: 3, z: 3, strength: 1 },
    ];
    const s = buildSnapshot(sim, 1, new Interest(), 0, ev, slotOf);
    expect(s.events).toEqual([{ t: 'knock', slot: 11 }, { t: 'knock', slot: 12 }, { t: 'impact', x: 3, z: 3, strength: 1 }]);
  });

  test('a rider is a rider entry (not a walker), the own riding state is in own; a bike that rolls away is streamed', async () => {
    const sim = await WorldSim.create(fixtureAssets());
    sim.addPlayer(1, { x: -5, z: -30 }); // next to bike 0
    sim.addPlayer(2, { x: -3, z: -34 });
    for (let t = 0; t < 10; t++) sim.step(new Map());
    sim.step(new Map([[1, { ...N, use: true }]]));
    for (let t = 0; t < 60; t++) sim.step(new Map([[1, { ...N, forward: 1 }]]));
    const other = buildSnapshot(sim, 2, new Interest(), 0, [], slotOf);
    expect(other.walkers).toEqual([]);
    expect(other.riders).toHaveLength(1);
    expect(other.riders[0]).toMatchObject({ slot: 11, bikeId: 0, pedalling: true, airborne: false });
    expect(other.riders[0]!.speed).toBeGreaterThan(1);
    const own = buildSnapshot(sim, 1, new Interest(), 0, [{ t: 'bell', id: 1, x: -6, z: -28 }], slotOf);
    expect(own.own.mode).toBe(3);
    expect(own.own.bikeId).toBe(0);
    expect(own.own.bike!.speed).toBeGreaterThan(1);
    expect(own.events).toEqual([]); // the own bell is never sent back
    expect(buildSnapshot(sim, 2, new Interest(), 0, [{ t: 'bell', id: 1, x: -6, z: -28 }], slotOf).events)
      .toEqual([{ t: 'bell', slot: 11, x: -6, z: -28 }]);
    // jump off fast: the bike rolls on, unridden, away from its spot
    for (let t = 0; t < 120; t++) sim.step(new Map([[1, { ...N, forward: 1, run: true }]]));
    sim.step(new Map([[1, { ...N, use: true }]]));
    sim.step(new Map());
    const after = buildSnapshot(sim, 2, new Interest(), 0, [], slotOf);
    expect(after.riders).toEqual([]);
    expect(after.bikes.map((b) => b.id)).toEqual([0]);
  });
});
