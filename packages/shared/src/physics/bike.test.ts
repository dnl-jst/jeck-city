import { describe, expect, test } from 'vitest';
import type { CollisionAsset } from '../assets/collision';
import { RiddenBike, type BikeInput } from './bike';
import { createPhysicsWorld, type PhysicsWorld } from './world';

const DEG = Math.PI / 180;
const KMH = 1 / 3.6;

/** Flat ground ±300 m at y = 0, boundary square ±250. */
function flat(): CollisionAsset {
  return {
    vertices: new Float32Array([-300, 0, -300, -300, 0, 300, 300, 0, 300, 300, 0, -300]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}

/** Fixed box from z0 to z1 across x ±50, `h` high (a kerb/sidewalk block or a wall). */
function block(pw: PhysicsWorld, z0: number, z1: number, h: number): void {
  const R = pw.rapier;
  const b = pw.world.createRigidBody(R.RigidBodyDesc.fixed());
  pw.world.createCollider(R.ColliderDesc.cuboid(50, h / 2, (z1 - z0) / 2).setTranslation(0, h / 2, (z0 + z1) / 2), b);
}

const go = (o: Partial<BikeInput> = {}): BikeInput => ({ pedal: 1, steer: 0, sprint: false, hop: false, ...o });

function ride(pw: PhysicsWorld, bike: RiddenBike, input: BikeInput | ((i: number) => BikeInput), seconds: number, each?: (crashed: boolean) => void): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const r = bike.applyInput(typeof input === 'function' ? input(i) : input);
    pw.step();
    each?.(r.crashed);
  }
}

/** Rides at about `kmh` (pedal while slower). */
const hold = (bike: RiddenBike, kmh: number, o: Partial<BikeInput> = {}) => () => go({ pedal: bike.state().speed / KMH < kmh ? 1 : 0, ...o });

describe('ridden bike', () => {
  test('reaches cruise and sprint speed', async () => {
    const pw = await createPhysicsWorld(flat());
    const a = new RiddenBike(pw, 'road', { x: 0, y: 0, z: -200, heading: 0 });
    ride(pw, a, go(), 6);
    expect(a.state().speed / KMH).toBeGreaterThan(29);
    expect(a.state().speed / KMH).toBeLessThan(31);
    const b = new RiddenBike(pw, 'road', { x: 10, y: 0, z: -200, heading: 0 });
    ride(pw, b, go({ sprint: true }), 8);
    expect(b.state().speed / KMH).toBeGreaterThan(43);
    expect(b.state().speed / KMH).toBeLessThan(46);
  });

  test('trike accelerates hard but caps low', async () => {
    const pw = await createPhysicsWorld(flat());
    const trike = new RiddenBike(pw, 'trike', { x: 0, y: 0, z: -200, heading: 0 });
    const dutch = new RiddenBike(pw, 'dutch', { x: 10, y: 0, z: -200, heading: 0 });
    for (let i = 0; i < 60; i++) {
      trike.applyInput(go());
      dutch.applyInput(go());
      pw.step();
    }
    expect(trike.state().speed).toBeGreaterThan(dutch.state().speed);
    ride(pw, trike, go({ sprint: true }), 8);
    expect(trike.state().speed / KMH).toBeLessThanOrEqual(25.5);
  });

  test('turns tighter when slow', async () => {
    const pw = await createPhysicsWorld(flat());
    const turnPerMetre = async (kmh: number) => {
      const b = new RiddenBike(pw, 'mtb', { x: kmh * 3, y: 0, z: -150, heading: 0 }, kmh * KMH);
      ride(pw, b, hold(b, kmh), 0.5);
      const s0 = b.state();
      ride(pw, b, hold(b, kmh, { steer: 1 }), 1);
      const s1 = b.state();
      return Math.abs(s1.heading - s0.heading) / (Math.abs(s0.speed + s1.speed) / 2);
    };
    expect(await turnPerMetre(10)).toBeGreaterThan(await turnPerMetre(30));
  });

  test('steering builds up gently and the turn rate is capped', async () => {
    const pw = await createPhysicsWorld(flat());
    const b = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: -150, heading: 0 }, 20 * KMH);
    const h0 = b.state().heading;
    ride(pw, b, hold(b, 20, { steer: 1 }), 0.1);
    expect(Math.abs(b.state().heading - h0)).toBeLessThan(0.05);
    ride(pw, b, hold(b, 20, { steer: 1 }), 1);
    const h1 = b.state().heading;
    ride(pw, b, hold(b, 20, { steer: 1 }), 0.5);
    const yawRate = Math.abs(b.state().heading - h1) / 0.5;
    expect(yawRate).toBeLessThanOrEqual(b.spec.maxYaw * 1.05);
    expect(yawRate).toBeGreaterThan(b.spec.maxYaw * 0.7);
  });

  test('steer right turns right', async () => {
    const pw = await createPhysicsWorld(flat());
    const b = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 }, 15 * KMH);
    ride(pw, b, go({ steer: 1 }), 1);
    // heading 0 faces +z; right of it is −x
    expect(b.state().x).toBeLessThan(-0.3);
  });

  test('climbs a kerb straight', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 3, 60, 0.12);
    const b = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 }, 15 * KMH);
    ride(pw, b, hold(b, 15), 2);
    expect(b.state().y).toBeGreaterThan(0.11);
    expect(b.state().z).toBeGreaterThan(5);
  });

  test('climbs a kerb at 30° without jumps', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 3, 60, 0.12);
    const b = new RiddenBike(pw, 'road', { x: 0, y: 0, z: 0, heading: 30 * DEG }, 15 * KMH);
    let prevY = b.state().y, maxJump = 0;
    ride(pw, b, hold(b, 15), 2, () => {
      const y = b.state().y;
      maxJump = Math.max(maxJump, Math.abs(y - prevY));
      prevY = y;
    });
    expect(b.state().y).toBeGreaterThan(0.11);
    expect(b.state().z).toBeGreaterThan(5);
    expect(maxJump).toBeLessThanOrEqual(0.13);
  });

  test('stops at a 0.4 m step', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 3, 60, 0.4);
    const b = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 }, 12 * KMH);
    ride(pw, b, hold(b, 12), 2);
    expect(b.state().y).toBeLessThan(0.05);
    expect(b.state().z).toBeLessThan(3);
  });

  test('hop clears 0.3 m', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 3, 60, 0.3);
    const b = new RiddenBike(pw, 'mtb', { x: 0, y: 0, z: 0, heading: 0 }, 15 * KMH);
    // hop with the front wheel ~0.5 m before the edge (front of the frame is ~0.9 m ahead of the centre)
    ride(pw, b, (i) => go({ hop: i === 22 }), 2);
    expect(b.state().y).toBeGreaterThan(0.29);
    expect(b.state().z).toBeGreaterThan(4);
  });

  test('crash into a wall at speed, no crash when slow', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 8, 9, 3);
    const fast = new RiddenBike(pw, 'road', { x: 0, y: 0, z: 0, heading: 0 }, 30 * KMH);
    let crashes = 0;
    ride(pw, fast, hold(fast, 30), 1.5, (c) => { if (c) crashes++; });
    expect(crashes).toBe(1);
    expect(fast.state().speed).toBeLessThan(0.1); // still pedalling into the wall

    const pw2 = await createPhysicsWorld(flat());
    block(pw2, 8, 9, 3);
    const slow = new RiddenBike(pw2, 'road', { x: 0, y: 0, z: 0, heading: 0 }, 15 * KMH);
    crashes = 0;
    ride(pw2, slow, hold(slow, 15), 2, (c) => { if (c) crashes++; });
    expect(crashes).toBe(0);
    expect(slow.state().z).toBeLessThan(8);
    expect(slow.state().speed).toBeLessThan(0.5);
  });

  test('glances off a wall', async () => {
    const pw = await createPhysicsWorld(flat());
    block(pw, 8, 9, 3);
    const b = new RiddenBike(pw, 'road', { x: 0, y: 0, z: 0, heading: 70 * DEG }, 30 * KMH); // 20° to the wall
    let crashes = 0;
    ride(pw, b, (i) => go({ pedal: 1, steer: i < 20 ? -1 : 0 }), 2, (c) => { if (c) crashes++; });
    expect(crashes).toBe(0);
    expect(b.state().speed / KMH).toBeGreaterThan(15);
  });

  test('restore round trip', async () => {
    const pw = await createPhysicsWorld(flat());
    const b = new RiddenBike(pw, 'dutch', { x: 0, y: 0, z: 0, heading: 0 });
    const inp = (i: number) => go({ steer: Math.sin(i / 10), sprint: i % 40 < 20 });
    ride(pw, b, inp, 1);
    const s = b.state();
    ride(pw, b, inp, 0.5);
    const end1 = b.state();
    b.restore(s);
    ride(pw, b, inp, 0.5);
    const end2 = b.state();
    for (const k of Object.keys(end1) as (keyof typeof end1)[]) {
      if (typeof end1[k] === 'number') expect(end2[k] as number).toBeCloseTo(end1[k] as number, 5);
    }
  });

  test('lean: road bike leans into a fast turn, trike never', async () => {
    const pw = await createPhysicsWorld(flat());
    const b = new RiddenBike(pw, 'road', { x: 0, y: 0, z: -100, heading: 0 }, 30 * KMH);
    ride(pw, b, hold(b, 30, { steer: 1 }), 0.5);
    expect(b.lean()).toBeGreaterThan(15 * DEG);
    expect(b.lean()).toBeLessThanOrEqual(35 * DEG + 1e-9);
    const t = new RiddenBike(pw, 'trike', { x: 20, y: 0, z: -100, heading: 0 }, 18 * KMH);
    ride(pw, t, hold(t, 18, { steer: 1 }), 0.5);
    expect(t.lean()).toBe(0);
  });
});
