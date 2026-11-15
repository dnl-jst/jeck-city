import { describe, expect, test } from 'vitest';
import type { CollisionAsset } from '../assets/collision';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { Character } from './character';
import { StreetProps, treeScale } from './props';
import { TUNING } from './tuning';
import { Vehicle } from './vehicle';
import { createPhysicsWorld, staticWorldFilter, type PhysicsWorld } from './world';

/** Flat ground ±300 m at y = 0, boundary square ±250. */
function flat(): CollisionAsset {
  return {
    vertices: new Float32Array([-300, 0, -300, -300, 0, 300, 300, 0, 300, 300, 0, -300]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}

/** Drives along +z from the origin, holding about `kmh` (throttle on below, off above), for `seconds`. */
function drive(pw: PhysicsWorld, car: Vehicle, kmh: number, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    car.applyInput({ throttle: car.speed() * 3.6 < kmh ? 1 : 0, steer: 0, brake: false });
    pw.step();
  }
}

/** Angle (rad) between the lamp's up axis and world up. */
function tilt(q: { qx: number; qy: number; qz: number; qw: number }): number {
  // y component of the rotated up vector
  const upY = 1 - 2 * (q.qx * q.qx + q.qz * q.qz);
  return Math.acos(Math.max(-1, Math.min(1, upY)));
}

async function scene(lamps: [number, number][], trees: [number, number][]) {
  const pw = await createPhysicsWorld(flat());
  const props = new StreetProps(pw, lamps, trees);
  const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
  car.setOccupied(true);
  return { pw, props, car };
}

describe('street props', () => {
  test('a fast car knocks a lamp over, away from the car, and drives on', async () => {
    const { pw, props, car } = await scene([[0, 40]], []);
    drive(pw, car, 50, 9);
    expect(props.takeFallen()).toEqual([0]);
    expect(props.isStanding(0)).toBe(false);
    const p = props.lampPose(0);
    expect(tilt(p)).toBeGreaterThan(1.2); // lying (almost) flat
    expect(p.z).toBeGreaterThan(40); // pushed along the direction of travel
    expect(car.pose().z).toBeGreaterThan(45); // the car did not stop at the post
    expect(props.takeFallen()).toEqual([]);
    // the car rolls over the lying post instead of shoving it down the road
    expect(car.pose().z).toBeGreaterThan(p.z + 10);
  });

  test('a slow car stops at a lamp, which stays standing', async () => {
    const { pw, props, car } = await scene([[0, 15]], []);
    drive(pw, car, 10, 12);
    expect(props.takeFallen()).toEqual([]);
    expect(props.isStanding(0)).toBe(true);
    expect(car.pose().z).toBeLessThan(15 - TUNING.vehicle.length / 2 + 0.1);
    expect(tilt(props.lampPose(0))).toBe(0);
  });

  test('a tree stops even a fast car', async () => {
    const { pw, car } = await scene([], [[0, 40]]);
    drive(pw, car, 50, 6);
    const r = TUNING.props.trunkRadius * treeScale(0, 40);
    expect(car.pose().z).toBeLessThan(40 - r - TUNING.vehicle.length / 2 + 0.1);
  });

  test('a walking character cannot pass through a tree or a lamp (it slides around them)', async () => {
    const pw = await createPhysicsWorld(flat());
    new StreetProps(pw, [[3, 5]], [[-3, 5]]);
    pw.step(); // broad phase
    for (const [x, r] of [[3, TUNING.props.lampRadius], [-3, TUNING.props.trunkRadius * treeScale(-3, 5)]] as const) {
      const c = new Character(pw, { x, y: 0.02, z: 0 });
      let closest = Infinity;
      for (let i = 0; i < 4 * 60; i++) {
        c.applyInput({ forward: 1, right: 0, run: true, yaw: 0 });
        pw.step();
        const p = c.position();
        closest = Math.min(closest, Math.hypot(p.x - x, p.z - 5));
      }
      expect(closest).toBeGreaterThan(r + TUNING.character.radius - 0.03);
      c.dispose();
    }
  });

  test('scene queries see props only when asked', async () => {
    const pw = await createPhysicsWorld(flat());
    new StreetProps(pw, [[0, 5]], []);
    pw.step(); // broad phase
    const { rapier: R, world } = pw;
    const ray = () => new R.Ray({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
    expect(world.castRay(ray(), 10, true, undefined, undefined, undefined, undefined, staticWorldFilter())).toBeNull();
    expect(world.castRay(ray(), 10, true, undefined, undefined, undefined, undefined, staticWorldFilter(false, undefined, true))?.timeOfImpact).toBeCloseTo(5 - TUNING.props.lampRadius, 1);
  });

  test('props stand on the terrain', async () => {
    const n = 101;
    const heights = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = 3 + 0.1 * c + 0.05 * r;
    const terrain: TerrainGrid = { x0: -50, z0: -50, cols: n, rows: n, datum: 40, heights };
    const pw = await createPhysicsWorld(flat(), terrain);
    const props = new StreetProps(pw, [[10.5, 20.25]], [[-5, 7]], terrain);
    expect(props.lampPose(0).y).toBeCloseTo(heightAt(terrain, 10.5, 20.25), 5);
    pw.step();
    const { rapier: R, world } = pw;
    // a horizontal ray just above the terrain at the tree hits the trunk (it starts on the ground, not at y = 0)
    const y = heightAt(terrain, -5, 7) + 0.5;
    const hit = world.castRay(new R.Ray({ x: -5, y, z: 0 }, { x: 0, y: 0, z: 1 }), 10, true, undefined, undefined, undefined, undefined, staticWorldFilter(false, undefined, true));
    expect(hit?.timeOfImpact).toBeCloseTo(7 - TUNING.props.trunkRadius * treeScale(-5, 7), 1);
  });
});

describe('lamp reset and follow', () => {
  async function knocked() {
    const { pw, props, car } = await scene([[0, 40]], []);
    drive(pw, car, 50, 9);
    expect(props.isStanding(0)).toBe(false);
    return { pw, props, car };
  }

  test('standUp restores a knocked lamp', async () => {
    const { pw, props, car } = await knocked();
    car.dispose();
    expect(props.isResting(0)).toBe(false); // still rolling
    props['lamps'][0]!.sleep(); // an undamped post rolls on for a minute or more; force the rest
    expect(props.isResting(0)).toBe(true);
    props.standUp(0);
    expect(props.isStanding(0)).toBe(true);
    expect(props.isResting(0)).toBe(false);
    const p = props.lampPose(0);
    expect([p.x, p.y, p.z]).toEqual([0, 0, 40]);
    expect(tilt(p)).toBeCloseTo(0, 5);
    pw.step();
    // solid again for scene queries with props, and a fast car breaks it once more
    const { rapier: R, world } = pw;
    const ray = new R.Ray({ x: 0, y: 1, z: 30 }, { x: 0, y: 0, z: 1 });
    expect(world.castRay(ray, 20, true, undefined, undefined, undefined, undefined, staticWorldFilter(false, undefined, true))?.timeOfImpact).toBeCloseTo(10 - TUNING.props.lampRadius, 1);
    const car2 = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
    car2.setOccupied(true);
    drive(pw, car2, 50, 9);
    expect(props.takeFallen()).toContain(0);
  });

  test('follow makes a lamp kinematic at the pose', async () => {
    const { pw, props } = await scene([[0, 40]], []);
    const pose = { x: 3, y: 0.2, z: 41, qx: 0, qy: 0, qz: Math.SQRT1_2, qw: Math.SQRT1_2 };
    props.follow(0, pose);
    expect(props.isStanding(0)).toBe(false);
    expect(props.isResting(0)).toBe(false);
    expect(props.lampPose(0).y).toBeCloseTo(0.2, 5);
    expect(props.lampPose(0).z).toBeCloseTo(41, 5);
    props.follow(0, { ...pose, x: 4 });
    pw.step();
    expect(props.lampPose(0).x).toBeCloseTo(4, 5);
    expect(props.takeFallen()).toEqual([]);
    // a fast car no longer treats it as a standing post
    const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
    car.setOccupied(true);
    drive(pw, car, 50, 3);
    expect(props.takeFallen()).toEqual([]);
  });
});
