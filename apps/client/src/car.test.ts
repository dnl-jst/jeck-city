import { expect, test } from 'vitest';
import { MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { headingOf, parkedPose, terrainNormal, VEHICLE_REST_Y, type TerrainGrid } from '@nn/shared';
import { CAR_REBUILD_MOVE, CAR_RENDER_RADIUS, beamPattern, carMaterial, isClearGlass, setMirrorNight, lampPower, needsCarRebuild, visibleCars } from './car';

test('visibleCars: indices of the cars within the render radius, in manifest order', () => {
  const poses = [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 0, z: -249 }, { x: 176, z: 176 }, { x: 177, z: 178 }];
  expect(CAR_RENDER_RADIUS).toBe(150);
  expect(visibleCars(poses, 0, 0, 250)).toEqual([0, 2, 3]);
  expect(visibleCars(poses, 300, 0, 250)).toEqual([1, 3, 4]);
  expect(visibleCars(poses, 0, 0, 10)).toEqual([0]);
});

test('needsCarRebuild: only after the camera moved more than 20 m since the last rebuild', () => {
  expect(CAR_REBUILD_MOVE).toBe(20);
  expect(needsCarRebuild(null, 5, 5)).toBe(true);
  expect(needsCarRebuild({ x: 0, z: 0 }, 12, 16)).toBe(false); // exactly 20 m
  expect(needsCarRebuild({ x: 0, z: 0 }, 12, 16.1)).toBe(true);
});

test('visibleCars: physics-active and occupied cars are always drawn, whatever the distance', () => {
  const poses = [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 0, z: 400 }, { x: 10, z: 0 }];
  expect(visibleCars(poses, 0, 0, CAR_RENDER_RADIUS, [2, 1, 3])).toEqual([0, 1, 2, 3]);
  expect(visibleCars(poses, 0, 0, CAR_RENDER_RADIUS, [])).toEqual([0, 3]);
});

test('lamp power: dark, flickering 0.25–0.6 while cranking (new each call), full once running', () => {
  expect(lampPower(0, () => 1)).toBe(0);
  expect(lampPower(0.5, () => 0)).toBeCloseTo(0.25);
  expect(lampPower(0.5, () => 1)).toBeCloseTo(0.6);
  expect(lampPower(1, () => 0)).toBe(1);
});

// headlight low beam: lamps 0.8 m above the road, so the road d m ahead lies at tangent -0.8/d below the axis
const road = (d: number) => beamPattern(0, -0.8 / d);
test('low beam: brightest just below the cutoff, which meets the road 20–30 m ahead', () => {
  expect(road(25)).toBeCloseTo(1, 5);
  expect(beamPattern(0, 0.01)).toBeLessThan(0.02); // above the cutoff only faint spill: no high beam
  expect(beamPattern(0, 0.2)).toBeLessThan(0.01);
});
test('low beam: road illuminance (∝ I / d³) stays even from 5 m to the cutoff instead of a hot spot at the bumper', () => {
  const e = (d: number) => road(d) / d ** 3;
  const near = e(5), mid = e(12), far = e(25);
  expect(near / far).toBeLessThan(8);
  expect(mid / far).toBeLessThan(4);
  expect(near / far).toBeGreaterThan(0.5);
});
test('low beam: falls off smoothly sideways, no hard edge', () => {
  const y = -0.8 / 15;
  const xs = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map((x) => beamPattern(x, y));
  for (let i = 1; i < xs.length; i++) {
    expect(xs[i]!).toBeLessThan(xs[i - 1]!);
    expect(xs[i - 1]! - xs[i]!).toBeLessThan(0.35);
  }
});
test('parked car rests on terrain and follows its slope', () => {
  const cols = 101, rows = 101;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 0.1 * c;
  const t: TerrainGrid = { x0: 0, z0: 0, cols, rows, datum: 0, heights };
  const p = parkedPose(40, 50, 0, t);
  expect(p.x).toBe(40);
  expect(p.z).toBe(50);
  expect(p.y).toBeCloseTo(0.1 * 40 + VEHICLE_REST_Y, 4);
  const q = new Quaternion(p.qx, p.qy, p.qz, p.qw);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  // tilt about the z axis: positive rotation turns up towards −x (the uphill side faces +x)
  expect(Math.atan2(-up.x, up.y)).toBeCloseTo(Math.atan(0.1), 2);
  expect(Math.abs(up.z)).toBeLessThan(1e-6);
  expect(headingOf(p)).toBeCloseTo(0, 5);
  // heading kept on a slope
  expect(headingOf(parkedPose(40, 50, 1.2, t))).toBeCloseTo(1.2, 2);
});

test('parkedPose (@nn/shared, plain math) equals the former Three.js version', () => {
  const up = new Vector3(0, 1, 0), n = new Vector3(), tilt = new Quaternion(), yaw = new Quaternion();
  const cols = 101, rows = 101;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 0.07 * c - 0.12 * r + 0.3 * Math.sin(c * 0.2) * Math.cos(r * 0.3);
  const t: TerrainGrid = { x0: 0, z0: 0, cols, rows, datum: 0, heights };
  for (const [x, z, h] of [[40, 50, 0], [12.3, 77.7, 1.2], [60.5, 20.25, -2.5], [80, 80, Math.PI]] as const) {
    const p = parkedPose(x, z, h, t);
    const tn = terrainNormal(t, x, z);
    const q = tilt.setFromUnitVectors(up, n.set(tn.x, tn.y, tn.z)).multiply(yaw.setFromAxisAngle(up, h));
    expect(p.qx).toBeCloseTo(q.x, 12);
    expect(p.qy).toBeCloseTo(q.y, 12);
    expect(p.qz).toBeCloseTo(q.z, 12);
    expect(p.qw).toBeCloseTo(q.w, 12);
  }
});

test('car glass: clear glass (blended in the model) is tuned for the game', () => {
  const g = new MeshStandardMaterial({ name: 'glass', transparent: true, opacity: 0.38 });
  expect(isClearGlass(g)).toBe(true);
  const m = carMaterial(g) as MeshStandardMaterial;
  expect(m).not.toBe(g);
  expect(m.transparent).toBe(true);
  expect(m.depthWrite).toBe(false);
  expect(m.opacity).toBeCloseTo(0.38);
  expect(isClearGlass(new MeshStandardMaterial({ name: 'lens_red', transparent: true, opacity: 0.6 }))).toBe(true);
});

test('car glass: the old models\' opaque glass and other materials stay untouched', () => {
  const g = new MeshStandardMaterial({ name: 'glass' });
  expect(isClearGlass(g)).toBe(false);
  expect(carMaterial(g)).toBe(g);
  const blendedPaint = new MeshStandardMaterial({ name: 'paint', transparent: true });
  expect(isClearGlass(blendedPaint)).toBe(false);
});

test('car mirrors: the mirror glass reflects a sky-and-street environment that dims at night', () => {
  const mirror = new MeshStandardMaterial({ name: 'mirror' });
  const m = carMaterial(mirror) as MeshStandardMaterial;
  expect(m).toBe(mirror); // shared by all cars of the type: tuned in place
  expect(m.envMap).not.toBeNull();
  expect(m.metalness).toBe(1);
  expect(m.roughness).toBeLessThan(0.1);
  setMirrorNight(0);
  const day = m.envMapIntensity;
  setMirrorNight(1);
  expect(m.envMapIntensity).toBeLessThan(day * 0.3);
  expect(m.envMapIntensity).toBeGreaterThan(0);
  expect((carMaterial(new MeshStandardMaterial({ name: 'chrome' })) as MeshStandardMaterial).envMap).toBeNull();
});
