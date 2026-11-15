import { describe, expect, test } from 'vitest';
import type { CollisionAsset } from '../assets/collision';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import type { WorldManifest } from '../assets/manifest';
import { RiddenBike } from './bike';
import { BikeRacks, dismountSpot, ParkedBikes } from './parkedbikes';
import { Vehicle } from './vehicle';
import { createPhysicsWorld, type PhysicsWorld } from './world';

const KMH = 1 / 3.6;

function flat(): CollisionAsset {
  return {
    vertices: new Float32Array([-300, 0, -300, -300, 0, 300, 300, 0, 300, 300, 0, -300]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}

function grid(x0: number, z0: number, cols: number, rows: number, f: (x: number, z: number) => number): TerrainGrid {
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(x0 + c, z0 + r);
  return { x0, z0, cols, rows, datum: 0, heights };
}

const bike = (x: number, z: number, heading = 0, type = 0): WorldManifest['bikes'][number] => ({ x, z, heading, type, color: 0 });

function steps(pw: PhysicsWorld, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    each?.();
    pw.step();
  }
}

/** Angle (rad) between the body's up axis and world up. */
function tilt(q: { x: number; y: number; z: number; w: number }): number {
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
}

describe('parked bikes', () => {
  test('car pushes a parked bike and it stays upright', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 0, Math.PI / 2)]);
    bikes.updatePhysics(0, 0);
    const car = new Vehicle(pw, { x: 0, z: -8, heading: 0 });
    car.setOccupied(true);
    let maxTilt = 0;
    steps(pw, 150, () => {
      car.applyInput({ throttle: car.speed() / KMH < 25 ? 1 : 0, steer: 0, brake: false });
      bikes.sync();
      const b = bikes.body(0)!;
      maxTilt = Math.max(maxTilt, tilt(b.rotation()));
    });
    bikes.sync();
    expect(Math.hypot(bikes.poses[0]!.x, bikes.poses[0]!.z)).toBeGreaterThan(1);
    expect(maxTilt).toBeLessThan(1 * Math.PI / 180);
  });

  test('ridden bike shoves a parked bike without crashing', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 4, Math.PI / 2)]);
    bikes.updatePhysics(0, 0);
    const me = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 }, 15 * KMH);
    let crashes = 0;
    steps(pw, 120, () => {
      if (me.applyInput({ pedal: me.state().speed / KMH < 15 ? 1 : 0, steer: 0, sprint: false, hop: false }).crashed) crashes++;
    });
    bikes.sync();
    expect(crashes).toBe(0);
    expect(bikes.poses[0]!.z).toBeGreaterThan(4.5);
  });

  test('mount keeps pose on a slope', async () => {
    const t = grid(-50, -50, 101, 101, (_x, z) => 0.08 * z);
    const pw = await createPhysicsWorld({ vertices: new Float32Array(0), indices: new Uint32Array(0), boundary: new Float32Array(0) }, t);
    const bikes = new ParkedBikes(pw, [bike(0, 10, 0, 3)], t);
    bikes.updatePhysics(0, 10);
    steps(pw, 30, () => bikes.sync());
    bikes.sync();
    const ridden = bikes.mount(0);
    expect(bikes.ridden).toBe(0);
    const ground = heightAt(t, 0, 10);
    expect(Math.abs(ridden.state().y - ground)).toBeLessThan(0.05);
    steps(pw, 10, () => ridden.applyInput({ pedal: 0, steer: 0, sprint: false, hop: false }));
    expect(ridden.state().y).toBeGreaterThan(ground - 0.05);
  });

  test('dismount rolls out', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 0, 0, 0)]);
    const ridden = bikes.mount(0);
    ridden.restore({ ...ridden.state(), speed: 20 * KMH });
    bikes.dismount(0, ridden);
    expect(bikes.ridden).toBeNull();
    steps(pw, 600, () => bikes.sync());
    bikes.sync();
    expect(bikes.poses[0]!.z).toBeGreaterThan(2);
    expect(bikes.body(0)!.linvel().z).toBeLessThan(0.05);
  });

  test('physics only near the player', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 0), bike(70, 0), bike(200, 0)]);
    bikes.updatePhysics(0, 0);
    expect(bikes.activeIds()).toEqual([0]);
    bikes.updatePhysics(200, 0);
    expect(bikes.activeIds()).toEqual([2]);
    expect(bikes.poses[0]!.x).toBeCloseTo(0, 2);
  });

  test('rack neighbours 0.5 m apart stay put when their bodies appear', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 0, 0, 0), bike(0.5, 0, 0, 1), bike(1, 0, 0, 2)]);
    bikes.updatePhysics(0, 0);
    steps(pw, 60, () => bikes.sync());
    bikes.sync();
    expect(bikes.poses.map((p) => Math.round(p.x * 100) / 100)).toEqual([0, 0.5, 1]);
  });

  test('nearest mountable is within reach and not ridden', async () => {
    const pw = await createPhysicsWorld(flat());
    const bikes = new ParkedBikes(pw, [bike(0, 0), bike(3, 0)]);
    expect(bikes.nearestMountable({ x: 0.6, z: 0.4 })).toBe(0);
    expect(bikes.nearestMountable({ x: 10, z: 0 })).toBeNull();
    bikes.mount(0);
    expect(bikes.nearestMountable({ x: 1.2, z: 0 })).toBe(1);
  });
});

describe('dismount spot', () => {
  const pose = { x: 0, y: 0, z: 0, heading: 0 };
  test('prefers left, then right, then behind', () => {
    // heading 0: left of the rider is +x, right is −x, behind is −z
    expect(dismountSpot(pose, () => true)).toEqual({ x: 1, z: 0 });
    expect(dismountSpot(pose, (x) => x < 0.5)).toEqual({ x: -1, z: 0 });
    expect(dismountSpot(pose, (_x, z) => z < -1)).toEqual({ x: 0, z: -1.6 });
    expect(dismountSpot(pose, () => false)).toBeNull();
  });

  test('dismount spot avoids walls', async () => {
    const pw = await createPhysicsWorld(flat());
    new BikeRacks(pw, [{ x: 1, z: 0, heading: 0, kind: 1 }]); // a bollard on the left
    pw.step(); // scene queries see colliders after a step
    const bikes = new ParkedBikes(pw, [bike(0, 0)]);
    const spot = dismountSpot(pose, (x, z) => bikes.standFree(x, z, 0));
    expect(spot).toEqual({ x: -1, z: 0 });
  });
});

describe('bike racks', () => {
  test('racks block a ridden bike', async () => {
    const pw = await createPhysicsWorld(flat());
    new BikeRacks(pw, [{ x: 0, z: 4, heading: Math.PI / 2, kind: 0 }]);
    const me = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 }, 10 * KMH);
    steps(pw, 120, () => me.applyInput({ pedal: 1, steer: 0, sprint: false, hop: false }));
    expect(me.state().z).toBeLessThan(4);
  });
});
