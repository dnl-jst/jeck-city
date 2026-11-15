import { PerspectiveCamera } from 'three';
import { expect, test } from 'vitest';
import type { PhysicsWorld } from '@nn/shared';
import { CAMERA_FOV, CAMERA_WALK, FollowCamera } from './camera';

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
