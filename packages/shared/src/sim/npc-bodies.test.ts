import { expect, test } from 'vitest';
import type { CollisionAsset } from '../assets/collision';
import { CAR_SPECS } from '../physics/cartypes';
import { Character } from '../physics/character';
import { TUNING } from '../physics/tuning';
import { Vehicle } from '../physics/vehicle';
import { createPhysicsWorld } from '../physics/world';
import { decodeSnapshot, encodeSnapshot, NEUTRAL_INPUT } from '../net/codec';
import { Interest } from '../net/interest';
import { fixtureAssets } from './fixture.test-util';
import { NpcBodies } from './npc-bodies';
import type { NpcBody } from './npc-director';
import { ownStateOf } from './replay';
import { buildSnapshot } from './snapshot';
import { WorldSim } from './world-sim';

const snapOwn = (sim: WorldSim) => decodeSnapshot(encodeSnapshot(buildSnapshot(sim, 1, new Interest(), 0, [], (i) => i)))!.own;

function flat(): CollisionAsset {
  return {
    vertices: new Float32Array([-300, 0, -300, -300, 0, 300, 300, 0, 300, 300, 0, -300]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}
const carAt = (z: number): NpcBody => ({ id: 1, kind: 'driver', x: 0, y: 0, z, heading: Math.PI / 2, pitch: 0, vehicleType: 0, lying: false });

test('a player car bounces off a standing npc car', async () => {
  const pw = await createPhysicsWorld(flat());
  const bodies = new NpcBodies(pw);
  const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
  car.setOccupied(true);
  let maxSpeed = 0;
  for (let i = 0; i < 6 * 60; i++) {
    bodies.sync([carAt(25)]); // across the road, 25 m ahead
    car.applyInput({ throttle: car.speed() * 3.6 < 30 ? 1 : 0, steer: 0, brake: false });
    pw.step();
    maxSpeed = Math.max(maxSpeed, car.speed());
  }
  const spec = CAR_SPECS.kleinwagen;
  expect(maxSpeed).toBeGreaterThan(7);
  // stopped at the npc car's side (its half width) plus the own car's half length, not through it
  expect(car.pose().z).toBeLessThan(25 - spec.width / 2 - TUNING.vehicle.length / 2 + 0.3);
  expect(Math.abs(car.speed())).toBeLessThan(0.3 * maxSpeed);
});

test('a walking character cannot pass through an npc walker', async () => {
  const pw = await createPhysicsWorld(flat());
  const bodies = new NpcBodies(pw);
  const ch = new Character(pw, { x: 0, y: 0.02, z: 0 });
  for (let i = 0; i < 4 * 60; i++) {
    bodies.sync([{ id: 2, kind: 'walker', x: 0, y: 0, z: 3, heading: 0, pitch: 0, vehicleType: -1, lying: false }]);
    ch.applyInput({ forward: 1, right: 0, run: false, yaw: 0, jump: false });
    pw.step();
  }
  expect(ch.position().z).toBeLessThan(3 - 2 * TUNING.character.radius + 0.05);
});

test('WorldSim places npc bodies at the coming tick each step, and per replayed input', async () => {
  const sim = await WorldSim.create(fixtureAssets());
  const asked: number[] = [];
  sim.attachNpcs({ bodiesNear: (tick) => (asked.push(tick), []) });
  sim.addPlayer(1);
  sim.step(new Map());
  sim.step(new Map());
  expect(asked).toEqual([1, 2]); // server clock: the sim tick
  sim.npcClock = 'external';
  sim.npcTick = 500;
  asked.length = 0;
  sim.step(new Map());
  expect(asked).toEqual([501]);
  asked.length = 0;
  const from = { ...ownStateOf(snapOwn(sim)), use: false };
  sim.replay(1, from, [NEUTRAL_INPUT(0), NEUTRAL_INPUT(0), NEUTRAL_INPUT(0)], undefined, (k) => 490 + k);
  expect(asked).toEqual([491, 492, 493]);
});

test('bodies follow sync and go when no longer listed or lying', async () => {
  const pw = await createPhysicsWorld(flat());
  const bodies = new NpcBodies(pw);
  bodies.sync([carAt(10), { id: 2, kind: 'walker', x: 5, y: 0, z: 5, heading: 0, pitch: 0, vehicleType: -1, lying: false }]);
  pw.step();
  expect(bodies.count).toBe(2);
  bodies.sync([{ id: 2, kind: 'walker', x: 5, y: 0, z: 5, heading: 0, pitch: 0, vehicleType: -1, lying: true }]);
  expect(bodies.count).toBe(0);
});
