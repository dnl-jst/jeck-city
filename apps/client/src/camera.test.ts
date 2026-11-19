import { PerspectiveCamera } from 'three';
import { expect, test } from 'vitest';
import type { PhysicsWorld } from '@nn/shared';
import { CAMERA_FOV, CAMERA_RIDE, CAMERA_WALK, FollowCamera, shakeAmount, shakeOffset, speedFov } from './camera';

/** Physics stub: the ray never hits anything. */
const open = { rapier: { Ray: class { constructor(readonly o: unknown, readonly d: unknown) {} } }, world: { castRay: () => null } } as unknown as PhysicsWorld;

test('on foot the camera sits 5 m behind and 2.3 m above the ground at a level view; 60° field of view', () => {
  expect(CAMERA_WALK.back).toBe(5);
  expect(CAMERA_WALK.up).toBe(2.3);
  expect(CAMERA_FOV).toBe(60);
  const cam = new PerspectiveCamera(CAMERA_FOV);
  const f = new FollowCamera(cam, open);
  f.yaw = 0; // looking along +z
  f.pitch = 0;
  for (let i = 0; i < 300; i++) f.update({ x: 10, y: 0.12, z: 20 }, 0, 1 / 60); // settled
  expect(cam.position.y).toBeCloseTo(0.12 + 2.3);
  expect(cam.position.x).toBeCloseTo(10);
  expect(cam.position.z).toBeCloseTo(20 - 5);
});

test('on a bike the camera sits closer and lower than on foot, behind the bike, from the ground under the wheels', () => {
  expect(CAMERA_RIDE.back).toBeLessThan(CAMERA_WALK.back);
  expect(CAMERA_RIDE.up).toBeLessThan(CAMERA_WALK.up);
  const cam = new PerspectiveCamera(CAMERA_FOV);
  const f = new FollowCamera(cam, open);
  f.pitch = 0;
  f.setDriving(true, Math.PI / 2, 'bike'); // bike faces +x
  for (let i = 0; i < 600; i++) f.update({ x: 10, y: 0.12, z: 20 }, Math.PI / 2, 1 / 60);
  expect(cam.position.y).toBeCloseTo(0.12 + CAMERA_RIDE.up, 2);
  expect(cam.position.x).toBeCloseTo(10 - CAMERA_RIDE.back, 2);
  expect(cam.position.z).toBeCloseTo(20, 2);
});

const kmh = (v: number) => v / 3.6;

test('the field of view stays at 60° up to 15 km/h and widens to 68–70° from 30 km/h on', () => {
  expect(speedFov(0)).toBe(CAMERA_FOV);
  expect(speedFov(kmh(15))).toBe(CAMERA_FOV);
  expect(speedFov(kmh(20))).toBeGreaterThan(CAMERA_FOV);
  expect(speedFov(kmh(20))).toBeLessThan(speedFov(kmh(25)));
  for (const v of [30, 50, 120]) {
    expect(speedFov(kmh(v))).toBeGreaterThanOrEqual(68);
    expect(speedFov(kmh(v))).toBeLessThanOrEqual(70);
  }
  expect(speedFov(-kmh(30))).toBe(speedFov(kmh(30))); // reversing counts too
});

test('shake: none on foot or below 15 km/h, grows with speed, bike shakes more than car, only a few cm', () => {
  expect(shakeAmount(kmh(40), 'walk')).toBe(0);
  expect(shakeAmount(kmh(14), 'bike')).toBe(0);
  expect(shakeAmount(kmh(25), 'bike')).toBeGreaterThan(shakeAmount(kmh(20), 'bike'));
  expect(shakeAmount(kmh(100), 'car')).toBe(1);
  let maxBike = 0, maxCar = 0, maxRoll = 0;
  for (let t = 0; t < 20; t += 0.01) {
    const b = shakeOffset(t, 1, 'bike'), c = shakeOffset(t, 1, 'car');
    maxBike = Math.max(maxBike, Math.hypot(b.x, b.y));
    maxCar = Math.max(maxCar, Math.hypot(c.x, c.y));
    maxRoll = Math.max(maxRoll, Math.abs(b.roll));
  }
  expect(maxBike).toBeGreaterThan(maxCar);
  expect(maxBike).toBeLessThan(0.05);
  expect(maxRoll).toBeLessThan((0.5 * Math.PI) / 180);
  expect(shakeOffset(3, 1, 'walk')).toEqual({ x: 0, y: 0, roll: 0 });
  // smooth, not random per frame
  const a = shakeOffset(5, 1, 'bike'), b = shakeOffset(5 + 1 / 120, 1, 'bike');
  expect(Math.abs(a.x - b.x)).toBeLessThan(0.005);
});

test('fast on a bike: wider view (smoothed), camera a little further back, shake only in the view; resetFov goes back to 60°', () => {
  const cam = new PerspectiveCamera(CAMERA_FOV);
  const f = new FollowCamera(cam, open);
  f.pitch = 0;
  f.setDriving(true, 0, 'bike'); // facing +z
  f.update({ x: 0, y: 0, z: 0 }, 0, 1 / 60, kmh(40));
  f.update({ x: 0, y: 0, z: 0 }, 0, 1 / 60, kmh(40));
  expect(cam.fov).toBeLessThan(62); // not a jump
  for (let i = 0; i < 300; i++) f.update({ x: 0, y: 0, z: 0 }, 0, 1 / 60, kmh(40));
  expect(cam.fov).toBeCloseTo(speedFov(kmh(40)), 1);
  expect(cam.position.z).toBeCloseTo(-(CAMERA_RIDE.back + 0.5), 1);
  expect(Math.abs(cam.position.x)).toBeLessThan(0.05); // shaken a few cm at most
  expect(Math.abs(cam.position.y - CAMERA_RIDE.up)).toBeLessThan(0.05);
  f.resetFov();
  expect(cam.fov).toBe(CAMERA_FOV);
});
