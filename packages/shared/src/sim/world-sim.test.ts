import { afterEach, describe, expect, test } from 'vitest';
import { NEUTRAL_INPUT, type PlayerInput } from '../net/codec';
import type { WorldAssets } from './assets';
import { fixtureAssets, haveRealAssets, realAssets, WHOLE_CITY_TIMEOUT } from './fixture.test-util';
import { headingOf, type CarPose } from './rules';
import { WorldSim, type SimEvent } from './world-sim';

/** Ticks after pressing E by which the engine runs: the walk to the door, getting in, door, starter. */
const STARTED = 240;

const N = NEUTRAL_INPUT(0);
const USE: PlayerInput = { ...N, use: true };
const GAS: PlayerInput = { ...N, forward: 1 };

/** Point d m to the left of a car (left = (cos h, −sin h)), offset `along` m forwards. */
function leftOf(c: CarPose, d: number, along = 0): { x: number; z: number } {
  const h = headingOf(c), s = Math.sin(h), co = Math.cos(h);
  return { x: c.x + co * d + s * along, z: c.z - s * d + co * along };
}

/** A car near the spawn with no other car within 12 m (room to drive off and nobody else's car in reach). */
function pickCar(a: WorldAssets): number {
  const p = a.manifest.parked, sp = a.manifest.spawn;
  let best = -1, bestD = Infinity;
  p.forEach((c, i) => {
    const lonely = p.every((o, j) => j === i || Math.hypot(o.x - c.x, o.z - c.z) > 12);
    const d = Math.hypot(c.x - sp.x, c.z - sp.z);
    if (lonely && d < bestD) [best, bestD] = [i, d];
  });
  if (best < 0) throw new Error('no free-standing car');
  return best;
}

function run(sim: WorldSim, ticks: number, inputs: () => Map<number, PlayerInput> = () => new Map()): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let t = 0; t < ticks; t++) ev.push(...sim.step(inputs()));
  return ev;
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

const worlds: [string, () => Promise<WorldAssets>, boolean][] = [
  ['fixture', async () => fixtureAssets(), false],
  [haveRealAssets ? 'real assets' : 'real assets [SKIPPED: apps/client/public/world not found — run the pipeline]', realAssets, !haveRealAssets],
];

for (const [name, assets, skip] of worlds) {
  describe.skipIf(skip)(`WorldSim (${name})`, () => {
    /**
     * Every sim a test creates, freed after it: the real city's physics world is large, and a whole file of them
     * left alive runs the Rapier (wasm) heap out of memory.
     */
    const live: WorldSim[] = [];
    const create = async (a: WorldAssets): Promise<WorldSim> => {
      const sim = await WorldSim.create(a);
      live.push(sim);
      return sim;
    };
    afterEach(() => {
      for (const sim of live.splice(0)) sim.pw.world.free();
    });
    /** A sim with player 1 standing 2.5 m left of the picked car. */
    async function nextToCar(): Promise<{ sim: WorldSim; car: number }> {
      const a = await assets();
      const sim = await create(a);
      const car = pickCar(a);
      sim.addPlayer(1, leftOf(sim.cars.poses[car]!, 2.5));
      run(sim, 10);
      return { sim, car };
    }

    test('two players spawn apart', async () => {
      const sim = await create(await assets());
      sim.addPlayer(0);
      sim.addPlayer(1);
      expect(dist(sim.player(0).pos, sim.player(1).pos)).toBeGreaterThanOrEqual(1.4);
      run(sim, 30);
      for (const id of [0, 1]) expect(sim.player(id).char.grounded).toBe(true);
      expect(dist(sim.player(0).pos, sim.player(1).pos)).toBeGreaterThanOrEqual(1.4);
    }, WHOLE_CITY_TIMEOUT);

    test('enter and exit', async () => {
      const { sim, car } = await nextToCar();
      let ev = sim.step(new Map([[1, USE]]));
      expect(ev).toContainEqual({ t: 'enter', id: 1, car });
      expect(sim.player(1).mode).toBe('drive');
      expect(sim.player(1).carId).toBe(car);
      expect(sim.cars.driver[car]).toBe(1);
      // E held: still one action
      ev = run(sim, 5, () => new Map([[1, USE]]));
      expect(sim.player(1).mode).toBe('drive');
      ev.push(...run(sim, STARTED));
      expect(ev.filter((e) => e.t === 'ignition').map((e) => e.t === 'ignition' && e.e)).toEqual(['doorClose', 'crank', 'running']);
      expect(sim.player(1).engine).toBe('running');
      ev = sim.step(new Map([[1, USE]]));
      expect(ev).toContainEqual({ t: 'exit', id: 1, car });
      expect(sim.player(1).mode).toBe('walk');
      expect(sim.cars.driver[car]).toBeNull();
      expect(sim.ignition(car).state).toBe('off');
      run(sim, 30);
      const p = sim.player(1);
      expect(p.char.grounded).toBe(true);
      expect(dist(p.pos, sim.cars.poses[car]!)).toBeLessThan(3.2);
    }, WHOLE_CITY_TIMEOUT);

    test('throttle is dead until running', async () => {
      const { sim, car } = await nextToCar();
      sim.step(new Map([[1, USE]]));
      const start = { ...sim.cars.poses[car]! };
      run(sim, 49, () => new Map([[1, GAS]]));
      expect(sim.player(1).engine).toBe('starting');
      expect(dist(sim.cars.poses[car]!, start)).toBeLessThan(0.05);
    }, WHOLE_CITY_TIMEOUT);

    test('same-tick enter: lower queue order wins', async () => {
      const a = await assets();
      const sim = await create(a);
      const car = pickCar(a);
      sim.addPlayer(1, leftOf(sim.cars.poses[car]!, 2.5));
      sim.addPlayer(2, leftOf(sim.cars.poses[car]!, 2, 1.2));
      run(sim, 10);
      // player 2 arrived first
      const ev = sim.step(new Map([[2, USE], [1, USE]]));
      expect(ev).toContainEqual({ t: 'enter', id: 2, car });
      expect(ev).toContainEqual({ t: 'enterDenied', id: 1 });
      expect(sim.player(2).mode).toBe('drive');
      expect(sim.player(1).mode).toBe('walk');
      expect(sim.cars.driver[car]).toBe(2);
    }, WHOLE_CITY_TIMEOUT);

    test('driver leaves → car free, engine off', async () => {
      const { sim, car } = await nextToCar();
      sim.step(new Map([[1, USE]]));
      run(sim, STARTED);
      sim.setRadio(1, 'einslive');
      expect(sim.cars.radio[car]).toBe('einslive');
      sim.removePlayer(1);
      expect([...sim.players()]).toEqual([]);
      expect(sim.cars.driver[car]).toBeNull();
      expect(sim.cars.radio[car]).toBeNull();
      expect(sim.ignition(car).state).toBe('off');
      sim.addPlayer(3, leftOf(sim.cars.poses[car]!, 2.5));
      run(sim, 10);
      expect(sim.step(new Map([[3, USE]]))).toContainEqual({ t: 'enter', id: 3, car });
    }, WHOLE_CITY_TIMEOUT);

    test('exit refused at speed', async () => {
      const { sim, car } = await nextToCar();
      sim.step(new Map([[1, USE]]));
      run(sim, STARTED);
      run(sim, 90, () => new Map([[1, GAS]]));
      expect(Math.abs(sim.cars.vehicle(car)!.speed())).toBeGreaterThan(2);
      const ev = sim.step(new Map([[1, { ...GAS, use: true }]]));
      expect(ev).toContainEqual({ t: 'exitDenied', id: 1, reason: 'speed' });
      expect(sim.player(1).mode).toBe('drive');
    }, WHOLE_CITY_TIMEOUT);

    test('braking: brake held, or throttle against the direction of travel; off once the driver is out', async () => {
      const { sim, car } = await nextToCar();
      sim.step(new Map([[1, USE]]));
      expect(sim.braking(car)).toBe(false);
      sim.step(new Map([[1, { ...N, brake: true }]]));
      expect(sim.braking(car)).toBe(true);
      run(sim, STARTED);
      expect(sim.braking(car)).toBe(false);
      run(sim, 90, () => new Map([[1, GAS]]));
      expect(sim.cars.vehicle(car)!.speed()).toBeGreaterThan(1);
      expect(sim.braking(car)).toBe(false);
      sim.step(new Map([[1, { ...N, forward: -1 }]]));
      expect(sim.braking(car)).toBe(true);
      run(sim, 200, () => new Map([[1, { ...N, brake: true }]]));
      expect(sim.braking(car)).toBe(true);
      sim.step(new Map([[1, USE]]));
      expect(sim.player(1).mode).toBe('walk');
      expect(sim.braking(car)).toBe(false);
    }, WHOLE_CITY_TIMEOUT);

    test('deterministic replay', async () => {
      const a = await assets();
      const car = pickCar(a);
      const play = async () => {
        const sim = await create(a);
        const c = sim.cars.poses[car]!;
        sim.addPlayer(1, leftOf(c, 2.5));
        sim.addPlayer(2);
        // player 1 walks into the car's side (yaw towards it), gets in after 5 s and drives a curve; player 2 strolls
        const towards = Math.atan2(c.x - leftOf(c, 2.5).x, c.z - leftOf(c, 2.5).z);
        for (let t = 0; t < 760; t++) {
          const p1: PlayerInput = t < 300 ? { ...NEUTRAL_INPUT(towards), forward: 0.5 } : t === 300 ? { ...N, use: true } : { ...N, forward: 1, right: t > 610 ? 0.6 : 0 };
          const p2: PlayerInput = { ...NEUTRAL_INPUT(t * 0.01), forward: 1, run: t % 200 < 100, jump: t % 90 === 0 };
          sim.step(new Map([[1, p1], [2, p2]]));
        }
        return sim;
      };
      const [s1, s2] = [await play(), await play()];
      expect(s1.player(1).mode).toBe('drive');
      for (const id of [1, 2]) {
        const p = s1.player(id).pos, q = s2.player(id).pos;
        expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(1e-6);
      }
      expect(dist(s1.cars.poses[car]!, a.manifest.parked[car]!)).toBeGreaterThan(5); // it really drove
    }, WHOLE_CITY_TIMEOUT);
  });
}
