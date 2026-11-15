import { describe, expect, test } from 'vitest';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import { TUNING } from '../physics/tuning';
import { fixtureAssets } from './fixture.test-util';
import { WorldSim, type SimEvent } from './world-sim';

const N = NEUTRAL_INPUT(0);
const R = TUNING.character.radius;

async function newSim(): Promise<WorldSim> {
  return WorldSim.create(fixtureAssets());
}

/** Car 0 stands at (5, 0) facing +z; give it speed `v` m/s along +z. */
function launch(sim: WorldSim, v: number): void {
  sim.cars.vehicle(0)!.chassis.setLinvel({ x: 0, y: 0, z: v }, true);
}

const kmh = (v: number) => v / 3.6;

describe('people and cars', () => {
  test('car at 30 km/h knocks a walker down for 1 s', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: 5, z: 10 });
    sim.step(new Map());
    sim.step(new Map());
    const start = sim.player(1).pos;
    const ev: SimEvent[] = [];
    let downTicks = 0;
    for (let t = 0; t < 240; t++) {
      if (!ev.some((e) => e.t === 'knock')) launch(sim, kmh(30)); // an undriven car brakes: hold 30 km/h up to the hit
      ev.push(...sim.step(new Map()));
      if (sim.player(1).mode === 'down') downTicks++;
    }
    expect(ev.filter((e) => e.t === 'knock')).toEqual([{ t: 'knock', id: 1, by: 0 }]);
    expect(ev.filter((e) => e.t === 'impact')).toHaveLength(1);
    expect(Math.abs(downTicks - 60)).toBeLessThanOrEqual(1);
    expect(sim.player(1).mode).toBe('walk');
    expect(sim.player(1).pos.z - start.z).toBeGreaterThan(0); // displaced in the driving direction (+z)
  }, 30_000);

  test('the car keeps its speed through a knockdown', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: 5, z: 10 });
    sim.step(new Map());
    let hit = false;
    for (let t = 0; t < 400 && !hit; t++) {
      launch(sim, kmh(30));
      hit = sim.step(new Map()).some((e) => e.t === 'knock');
    }
    expect(hit).toBe(true);
    const v = sim.cars.vehicle(0)!.chassis.linvel();
    expect(Math.hypot(v.x, v.z) * 3.6).toBeGreaterThanOrEqual(25);
  }, 30_000);

  test('car at 5 km/h pushes without knockdown', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: 5, z: 4 });
    sim.step(new Map());
    const ev: SimEvent[] = [];
    for (let t = 0; t < 150; t++) {
      launch(sim, kmh(5));
      ev.push(...sim.step(new Map()));
    }
    expect(ev.filter((e) => e.t === 'knock')).toEqual([]);
    expect(sim.player(1).mode).toBe('walk');
    // ahead of the bumper, outside the chassis
    const c = sim.cars.poses[0]!, p = sim.player(1).pos;
    expect(p.z).toBeGreaterThan(c.z + TUNING.vehicle.length / 2 - 0.1);
  }, 30_000);

  test('walkers do not overlap', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: -40, z: -4 });
    sim.addPlayer(2, { x: -40, z: 4 });
    sim.step(new Map());
    let min = Infinity;
    for (let t = 0; t < 360; t++) {
      sim.step(new Map([[1, { ...NEUTRAL_INPUT(0), forward: 1 }], [2, { ...NEUTRAL_INPUT(Math.PI), forward: 1 }]]));
      const a = sim.player(1).pos, b = sim.player(2).pos;
      min = Math.min(min, Math.hypot(a.x - b.x, a.z - b.z));
    }
    expect(min).toBeGreaterThanOrEqual(2 * R - 0.05);
  }, 30_000);

  test('down player ignores input', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: -40, z: 0 });
    sim.step(new Map());
    sim.onFoot()[0]!.char.knock({ x: 0, y: 0, z: 0 }, 60);
    const start = sim.player(1).pos;
    const walk: PlayerInput = { ...N, forward: 1, run: true };
    for (let t = 0; t < 30; t++) {
      sim.step(new Map([[1, walk]]));
      expect(sim.player(1).mode).toBe('down');
    }
    const p = sim.player(1).pos;
    expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeLessThan(0.01);
    for (let t = 0; t < 40; t++) sim.step(new Map([[1, walk]]));
    expect(sim.player(1).pos.z).toBeGreaterThan(start.z + 0.5); // up again and walking
  }, 30_000);

  test('a down player cannot get into a car', async () => {
    const sim = await newSim();
    sim.addPlayer(1, { x: 2.5, z: 0 });
    sim.step(new Map());
    sim.onFoot()[0]!.char.knock({ x: 0, y: 0, z: 0 }, 60);
    sim.step(new Map());
    const ev = sim.step(new Map([[1, { ...N, use: true }]]));
    expect(ev.some((e) => e.t === 'enter')).toBe(false);
    expect(sim.player(1).mode).toBe('down');
    expect(sim.cars.driver[0]).toBeNull();
    sim.step(new Map()); // E released
    for (let t = 0; t < 70; t++) sim.step(new Map());
    expect(sim.step(new Map([[1, { ...N, use: true }]]))).toContainEqual({ t: 'enter', id: 1, car: 0 });
  }, 30_000);
});
