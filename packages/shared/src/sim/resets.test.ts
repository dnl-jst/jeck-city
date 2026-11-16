import { describe, expect, test } from 'vitest';
import { fixtureAssets } from './fixture.test-util';
import { WorldSim, type SimEvent } from './world-sim';

const IDLE = 36_000; // RESET_AFTER_S at 60 Hz

function run(sim: WorldSim, ticks: number): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) ev.push(...sim.step(new Map()));
  return ev;
}

/** Puts player `id` (on foot) at (x, z). */
function moveTo(sim: WorldSim, id: number, x: number, z: number): void {
  sim.onFoot().find((p) => p.id === id)!.char.teleport({ x, y: 0.02, z });
  run(sim, 2);
}

describe('idle resets', () => {
  test('lamp falls once, reset after 600 s only without players near', async () => {
    const sim = await WorldSim.create(fixtureAssets());
    sim.addPlayer(1, { x: 30, z: 50 }); // 50 m from the lamp at (30, 0)
    run(sim, 2);
    expect(sim.lampState(0)).toBe('standing');
    expect(sim.lampsDown()).toEqual([]);
    // car 2 stands at (-20, 0) facing +x: send it into lamp 0 at 54 km/h
    const ev: SimEvent[] = [];
    for (let t = 0; t < 300 && !ev.some((e) => e.t === 'lamp'); t++) {
      sim.cars.vehicle(2)!.chassis.setLinvel({ x: 15, y: 0, z: 0 }, true);
      ev.push(...sim.step(new Map()));
    }
    ev.push(...run(sim, 600));
    expect(ev.filter((e) => e.t === 'lamp')).toEqual([{ t: 'lamp', i: 0 }]);
    expect(sim.lampState(0)).toBe('lying');
    expect(sim.lampsDown()).toEqual([0]);

    sim.advanceIdleTicks(IDLE);
    run(sim, 120);
    expect(sim.lampState(0)).toBe('lying'); // a player is 50 m away

    moveTo(sim, 1, -100, 90); // ~158 m from the lamp
    sim.advanceIdleTicks(IDLE);
    run(sim, 120);
    expect(sim.lampState(0)).toBe('standing');
    expect(sim.lampsDown()).toEqual([]);
  }, 60_000);

  test('moved car resets after 600 s', async () => {
    const sim = await WorldSim.create(fixtureAssets());
    sim.addPlayer(1, { x: 0, z: 90 }); // 50 m from car 3 at (0, 40)
    run(sim, 2);
    const home = { ...sim.cars.poses[3]! };
    expect(sim.cars.isMoved(3)).toBe(false);
    sim.cars.vehicle(3)!.chassis.setTranslation({ x: 3, y: home.y + 0.1, z: 40 }, true);
    run(sim, 600);
    expect(sim.cars.awake()).not.toContain(3);
    expect(sim.cars.isMoved(3)).toBe(true);

    sim.advanceIdleTicks(IDLE);
    run(sim, 120);
    expect(sim.cars.isMoved(3)).toBe(true); // a player is 50 m away

    moveTo(sim, 1, -100, -100);
    sim.advanceIdleTicks(IDLE);
    run(sim, 120);
    expect(sim.cars.isMoved(3)).toBe(false);
  }, 60_000);
});
