import { describe, expect, test } from 'vitest';
import { decodeSnapshot, encodeSnapshot, NEUTRAL_INPUT, type PlayerInput, type Snapshot } from '../net/codec';
import { Interest } from '../net/interest';
import type { WorldAssets } from './assets';
import { fixtureAssets, haveRealAssets, realAssets } from './fixture.test-util';
import { ownStateOf } from './replay';
import { headingOf, type CarPose } from './rules';
import { buildSnapshot } from './snapshot';
import { WorldSim, type SimEvent } from './world-sim';

const N = NEUTRAL_INPUT(0);
const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Point d m to the left of a car (left = (cos h, −sin h)). */
function leftOf(c: CarPose, d: number): { x: number; z: number } {
  const h = headingOf(c);
  return { x: c.x + Math.cos(h) * d, z: c.z - Math.sin(h) * d };
}

/** The fixture with car 0 moved to (−60, −120) facing +z: 10 s of full throttle along x = −60 hit nothing. */
function openRoadAssets(): WorldAssets {
  const a = fixtureAssets();
  a.manifest.parked[0] = { x: -60, z: -120, heading: 0, color: 0xff0000 };
  return a;
}

/** A car near the spawn with no other car within 12 m (room to drive off). */
function lonelyCar(a: WorldAssets): number {
  const p = a.manifest.parked, sp = a.manifest.spawn;
  let best = -1, bestD = Infinity;
  p.forEach((c, i) => {
    const lonely = p.every((o, j) => j === i || Math.hypot(o.x - c.x, o.z - c.z) > 12);
    const d = Math.hypot(c.x - sp.x, c.z - sp.z);
    if (lonely && d < bestD) [best, bestD] = [i, d];
  });
  return best;
}

/** Feet or chassis centre of the player. */
const where = (sim: WorldSim, id: number) => sim.player(id).pos;

describe('WorldSim.replay', () => {
  test('replay leaves other dynamic bodies untouched', async () => {
    const sim = await WorldSim.create(fixtureAssets());
    sim.addPlayer(1, leftOf(sim.cars.poses[0]!, 2.5));
    for (let t = 0; t < 10; t++) sim.step(new Map());
    sim.step(new Map([[1, { ...N, use: true }]]));
    for (let t = 0; t < 90; t++) sim.step(new Map([[1, N]]));
    // car 1 (5, 20, right ahead of car 0) gets a shove and rolls towards the own car
    const pushed = sim.cars.vehicle(1)!.chassis;
    pushed.setLinvel({ x: 1.5, y: 0, z: -3 }, true);
    for (let t = 0; t < 20; t++) sim.step(new Map([[1, { ...N, forward: 1 }]]));
    expect(sim.cars.awake()).toContain(1);

    const before = { t: pushed.translation(), r: pushed.rotation(), lv: pushed.linvel(), av: pushed.angvel() };
    const from = { ...ownStateOf(snapOwn(sim, 1)), use: false };
    sim.replay(1, from, Array.from({ length: 10 }, () => ({ ...N, forward: 1, right: 0.5 })));
    expect(pushed.translation()).toEqual(before.t);
    expect(pushed.rotation()).toEqual(before.r);
    expect(pushed.linvel()).toEqual(before.lv);
    expect(pushed.angvel()).toEqual(before.av);
    expect(pushed.isSleeping()).toBe(false);
  }, 30_000);

  test('replay from a saved state retraces the stepped path', async () => {
    const sim = await WorldSim.create(fixtureAssets());
    sim.addPlayer(1, { x: -30, z: -30 });
    for (let t = 0; t < 10; t++) sim.step(new Map());
    const from = ownStateOf(snapOwn(sim, 1));
    const inputs: PlayerInput[] = Array.from({ length: 20 }, (_, k) => ({ ...N, forward: 1, run: true, yaw: 0.02 * k, jump: k === 3 }));
    for (const i of inputs) sim.step(new Map([[1, i]]));
    const stepped = where(sim, 1);
    sim.replay(1, from, inputs);
    expect(dist3(where(sim, 1), stepped)).toBeLessThan(1e-4);
  }, 30_000);
});

/** The own part of a snapshot for player id, through the codec. */
function snapOwn(sim: WorldSim, id: number): Snapshot['own'] {
  return decodeSnapshot(encodeSnapshot(buildSnapshot(sim, id, new Interest(), 0, [], (i) => i)))!.own;
}

const worlds: [string, () => Promise<WorldAssets>, boolean][] = [
  ['fixture', async () => openRoadAssets(), false],
  [haveRealAssets ? 'real assets' : 'real assets [SKIPPED: apps/client/public/world not found — run the pipeline]', realAssets, !haveRealAssets],
];

for (const [name, assets, skip] of worlds) {
  describe.skipIf(skip)(`prediction (${name})`, () => {
    /**
     * Spec 13.3: a server sim (own player 1 plus a bystander, player 2) and a client prediction sim (player 1, the
     * bystander as a proxy) run the same inputs; after every 3rd tick the snapshot goes through the codec and the
     * client reconciles at once (0 ms latency). Returns the largest position error seen before a reconciliation.
     */
    async function run(ticks: number, input: (t: number, s: WorldSim) => PlayerInput, car: number | null): Promise<number> {
      const a = await assets();
      const server = await WorldSim.create(a);
      const client = await WorldSim.create(a);
      const at = car !== null ? leftOf(server.cars.poses[car]!, 2.5) : a.manifest.spawn;
      server.addPlayer(1, at);
      client.addPlayer(1, at);
      server.addPlayer(2, { x: at.x + 1.5, z: at.z - 1.5 });
      const interest = new Interest();
      let events: SimEvent[] = [];
      let err = 0;
      for (let t = 0; t < ticks; t++) {
        const i = input(t, client);
        events.push(...server.step(new Map([[1, i], [2, NEUTRAL_INPUT(0)]])));
        client.step(new Map([[1, i]]));
        if (server.tick % 3 !== 0) continue;
        const snap = decodeSnapshot(encodeSnapshot(buildSnapshot(server, 1, interest, t, events, (id) => id)))!;
        events = [];
        err = Math.max(err, dist3(where(client, 1), ownStateOf(snap.own).car ?? snap.own.char));
        client.replay(1, { ...ownStateOf(snap.own), ignition: client.player(1).carId !== null ? client.ignition(client.player(1).carId!).save() : undefined, use: i.use, jump: i.jump }, []);
        client.setProxies(
          new Map(snap.walkers.map((w) => [w.slot, w])),
          new Map(snap.cars.map((c) => [c.id, c])),
        );
      }
      expect(client.player(1).mode).toBe(server.player(1).mode);
      return err;
    }

    test('prediction matches server at 0 ms latency: walking', async () => {
      const err = await run(600, () => ({ ...N, forward: 1, run: true }), null);
      expect(err).toBeLessThan(0.01);
    }, 60_000);

    test('prediction matches server at 0 ms latency: driving', async () => {
      const a = await assets();
      const car = name === 'fixture' ? 0 : lonelyCar(a);
      const err = await run(60 + 600, (t, s) => {
        if (t === 5) return { ...N, use: true };
        // straight on, after the engine runs (1.4 s); yaw follows the car like the follow camera
        const p = s.player(1);
        return { ...N, forward: t > 100 ? 1 : 0, yaw: p.car ? headingOf(p.car) : 0 };
      }, car);
      expect(err).toBeLessThan(0.01);
    }, 60_000);
  });
}
