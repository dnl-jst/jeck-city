import { expect, test } from 'vitest';
import { createPhysicsWorld } from '../physics/world';
import { CAR_PHYSICS_FAR, CAR_PHYSICS_NEAR, CarPool } from './cars';
import { fixtureAssets } from './fixture.test-util';

async function pool() {
  const a = fixtureAssets();
  // car 0 at (5, 0), car 1 at (5, 20), car 2 at (−20, 0), car 3 at (0, 40); plus one far away
  a.manifest.parked.push({ x: 130, z: 130, heading: 0, color: 0 });
  const pw = await createPhysicsWorld(a.collision, a.terrain);
  return { pw, cars: new CarPool(pw, a.manifest.parked, a.terrain) };
}

const step = (pw: { step(): void }, cars: CarPool, n: number) => {
  for (let i = 0; i < n; i++) { pw.step(); cars.sync(); }
};

test('proximity: physics cars within 150 m of any focus, released beyond 200 m of all', async () => {
  const { cars } = await pool();
  expect([CAR_PHYSICS_NEAR, CAR_PHYSICS_FAR]).toEqual([150, 200]);
  expect(cars.physicsCount()).toBe(0);
  cars.updateProximity([{ x: -100, z: -100 }]);
  // (−100, −100) → car 2 at 128 m, car 0 at 145 m, car 1 at 159 m, car 3 at 172 m
  expect([0, 1, 2, 3, 4].map((i) => cars.vehicle(i) !== null)).toEqual([true, false, true, false, false]);
  cars.updateProximity([{ x: -100, z: -100 }, { x: 130, z: 100 }]);
  expect([0, 1, 2, 3, 4].map((i) => cars.vehicle(i) !== null)).toEqual([true, true, true, true, true]);
  // hysteresis: still within 200 m of the remaining focus
  cars.updateProximity([{ x: 130, z: 100 }]);
  expect(cars.vehicle(2)).not.toBeNull(); // 180 m
  cars.updateProximity([{ x: 200, z: 200 }]);
  expect(cars.physicsCount()).toBe(1);
  expect(cars.vehicle(4)).not.toBeNull();
  // no foci: everything without a driver goes
  cars.updateProximity([]);
  expect(cars.physicsCount()).toBe(0);
});

test('enter/exit: driver, radio cleared, driven car kept with no focus; pose remembered after release', async () => {
  const { pw, cars } = await pool();
  const v = cars.enter(0, 7);
  expect(cars.driver[0]).toBe(7);
  expect(cars.candidates()[0]!.occupied).toBe(true);
  cars.radio[0] = 'radiokoeln';
  cars.updateProximity([]);
  expect(cars.vehicle(0)).toBe(v); // never released under its driver
  for (let i = 0; i < 120; i++) {
    v.applyInput({ throttle: 1, steer: 0, brake: false });
    pw.step();
    cars.sync();
  }
  expect(cars.awake()).toEqual([0]);
  expect(cars.poses[0]!.z).toBeGreaterThan(1);
  cars.exit(0);
  expect(cars.driver[0]).toBeNull();
  expect(cars.radio[0]).toBeNull();
  step(pw, cars, 300);
  const left = { ...cars.poses[0]! };
  cars.updateProximity([]);
  expect(cars.vehicle(0)).toBeNull();
  expect(cars.poses[0]).toEqual(left);
  // a new body appears where the car was left
  cars.updateProximity([{ x: 0, z: 0 }]);
  expect(cars.vehicle(0)!.pose().z).toBeCloseTo(left.z, 3);
});

test('isMoved / reset', async () => {
  const { pw, cars } = await pool();
  cars.updateProximity([{ x: 0, z: 0 }]);
  step(pw, cars, 30);
  expect(cars.isMoved(0)).toBe(false); // settling on its springs stays within 5 cm
  expect(cars.awake()).toEqual([]);
  const v = cars.vehicle(0)!;
  v.chassis.setTranslation({ x: 5.2, y: cars.poses[0]!.y, z: 0 }, true);
  expect(cars.isMoved(0)).toBe(true);
  v.chassis.setTranslation({ x: 5, y: cars.poses[0]!.y, z: 0 }, true);
  const h = 3 * Math.PI / 180;
  v.chassis.setRotation({ x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) }, true);
  expect(cars.isMoved(0)).toBe(true);
  cars.enter(0, 1);
  cars.reset(0); // driven: ignored
  expect(cars.vehicle(0)).toBe(v);
  cars.exit(0);
  cars.reset(0);
  expect(cars.isMoved(0)).toBe(false);
  expect(cars.vehicle(0)).not.toBe(v);
  expect(cars.vehicle(0)!.chassis.isSleeping()).toBe(true);
});

test('place: a car at rest on a given pose (body, no body, followed); homePose', async () => {
  const { pw, cars } = await pool();
  const home = cars.homePose(0);
  expect(home).toEqual(cars.poses[0]);
  const at = { ...home, x: 12, z: -7 };
  // no body: only the stored pose (a body later appears there)
  cars.place(0, at);
  expect(cars.poses[0]).toEqual(at);
  cars.updateProximity([{ x: 0, z: 0 }]);
  expect(cars.vehicle(0)!.pose().x).toBeCloseTo(12, 3);
  // body, moving: set there, still, asleep
  const v = cars.vehicle(0)!;
  v.chassis.setLinvel({ x: 3, y: 0, z: 0 }, true);
  cars.place(0, home);
  expect(v.pose().x).toBeCloseTo(home.x, 3);
  expect(v.chassis.isSleeping()).toBe(true);
  expect(v.chassis.linvel().x).toBe(0);
  expect(cars.poses[0]).toEqual(home);
  // followed: released (dynamic again) on the pose
  cars.follow(1, { ...cars.poses[1]!, x: 8 });
  pw.step();
  cars.place(1, at);
  expect(cars.following().has(1)).toBe(false);
  expect(cars.vehicle(1)!.pose().x).toBeCloseTo(12, 3);
  expect(cars.vehicle(1)!.chassis.isSleeping()).toBe(true);
  // driven: ignored
  cars.enter(2, 1);
  const p2 = cars.vehicle(2)!.pose();
  cars.place(2, at);
  expect(cars.vehicle(2)!.pose().x).toBeCloseTo(p2.x, 3);
});
