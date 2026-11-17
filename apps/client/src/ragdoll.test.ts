import { describe, expect, test } from 'vitest';
import { Euler, Quaternion, Scene, Vector3 } from 'three';
import { CAR_GROUPS, createPhysicsWorld, type CollisionAsset, type TerrainGrid } from '@nn/shared';
import { PlayerFigure, RISE_S } from './player';
import { RagdollWorld } from './ragdoll';

/** Ground at y = 0 (±200 m), a wall at x = 6..6.5 (3 m high). */
function city(): CollisionAsset {
  const v: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const o = v.length / 3;
    v.push(...a, ...b, ...c, ...d);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  quad([-200, 0, -200], [-200, 0, 200], [200, 0, 200], [200, 0, -200]);
  quad([6, 0, -50], [6, 3, -50], [6, 3, 50], [6, 0, 50]);
  quad([6.5, 0, -50], [6.5, 0, 50], [6.5, 3, 50], [6.5, 3, -50]);
  return { vertices: new Float32Array(v), indices: new Uint32Array(idx), boundary: new Float32Array([-190, -190, 190, -190, 190, 190, -190, 190]) };
}

const seat = new Vector3(0, 0.98, -0.25);
const grips: [Vector3, Vector3] = [new Vector3(0.28, 1.1, 0.35), new Vector3(-0.28, 1.1, 0.35)];
const pedals: [Vector3, Vector3] = [new Vector3(0.1, 0.12, 0.1), new Vector3(-0.1, 0.46, 0.1)];

/** Runs the figure for `seconds` at 60 fps with the sim's position fixed at `at`; returns the lowest/highest part heights seen. */
function run(f: PlayerFigure, w: RagdollWorld, at: Vector3, seconds: number) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    w.step(1 / 60);
    f.update(at.x, at.y, at.z, { x: 0, y: 0, z: 0 }, 1 / 60);
    f.group.updateMatrixWorld(true);
    // joints (and the meshes on them): not the group and the pelvis node, whose origins lie at the feet's rest height
    f.group.children[0]!.traverse((o) => {
      if (o === f.group.children[0]) return;
      const y = o.getWorldPosition(new Vector3()).y;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    });
  }
  return { lo, hi };
}

describe('ragdoll', () => {
  test('a rider thrown off at 25 km/h flies, comes to rest on the ground and gets up where the sim is', async () => {
    const pw = await createPhysicsWorld(city());
    const w = new RagdollWorld(pw);
    const scene = new Scene();
    const f = new PlayerFigure(scene);
    f.ride(seat, grips, pedals, 'upright');
    const v = 25 / 3.6;
    f.ragdoll(w, { x: 0, y: 2.2, z: v }, 3.5, RISE_S + 1.8);
    expect(f.busy).toBe(true);
    const target = new Vector3(0, 0, 6);
    // in the air a while: the hips leave the seat height
    let top = 0;
    for (let i = 0; i < 20; i++) {
      w.step(1 / 60);
      f.update(target.x, target.y, target.z, { x: 0, y: 0, z: 0 }, 1 / 60);
      f.group.updateMatrixWorld(true);
      top = Math.max(top, f.group.children[0]!.localToWorld(new Vector3(0, 0.92, 0)).y);
    }
    expect(top).toBeGreaterThan(1.1);
    const fly = run(f, w, target, 1.45);
    expect(fly.lo).toBeGreaterThan(-0.15); // never through the ground
    expect(Number.isFinite(fly.hi)).toBe(true);
    // lying by now: the pelvis low, near the sim's spot
    const body = f.group.children[0]!;
    const hips = body.localToWorld(new Vector3(0, 0.92, 0));
    expect(hips.y).toBeLessThan(0.45);
    expect(Math.hypot(hips.x - target.x, hips.z - target.z)).toBeLessThan(2.5);
    // getting up: no joint sinks into the ground
    const up = run(f, w, target, RISE_S + 0.1);
    expect(up.lo).toBeGreaterThan(-0.1);
    expect(f.busy).toBe(false);
    expect(f.group.position.distanceTo(target)).toBeLessThan(1e-6);
    // standing again, the next walking frame poses it upright
    f.update(target.x, target.y, target.z, { x: 0, y: 0, z: 0 }, 1 / 60);
    f.group.updateMatrixWorld(true);
    expect(body.localToWorld(new Vector3(0, 0.92, 0)).y).toBeGreaterThan(0.8);
  });

  test('knees bend only forwards', async () => {
    const pw = await createPhysicsWorld(city());
    const w = new RagdollWorld(pw);
    const f = new PlayerFigure(new Scene());
    f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
    // hit from behind, legs swept away
    f.ragdoll(w, { x: 0, y: 3, z: 8 }, -3, 5);
    const legs = f.group.children[0]!.children.filter((c) => Math.abs(c.position.x) > 0.05);
    expect(legs.length).toBe(2);
    let min = Infinity;
    for (let i = 0; i < 120; i++) {
      w.step(1 / 60);
      f.update(0, 0, 8, { x: 0, y: 0, z: 0 }, 1 / 60);
      for (const leg of legs) {
        const e = new Euler().setFromQuaternion(leg.children[0]!.quaternion as Quaternion);
        min = Math.min(min, e.x);
      }
    }
    expect(min).toBeGreaterThan(-0.15);
  });

  test('stops at a wall instead of passing through it', async () => {
    const pw = await createPhysicsWorld(city());
    const w = new RagdollWorld(pw);
    const f = new PlayerFigure(new Scene());
    f.update(4, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
    f.ragdoll(w, { x: 12, y: 1, z: 0 }, 0, 5);
    run(f, w, new Vector3(5.6, 0, 0), 1.5);
    f.group.updateMatrixWorld(true);
    let maxX = -Infinity;
    f.group.children[0]!.traverse((o) => { maxX = Math.max(maxX, o.getWorldPosition(new Vector3()).x); });
    expect(maxX).toBeLessThan(6.05);
  });

  test('lies on the terrain heightfield (copied from the sim world)', async () => {
    // the city's mesh is far away; the ground here is a terrain sloping up along x
    const far: CollisionAsset = {
      vertices: new Float32Array([500, 0, 500, 500, 0, 501, 501, 0, 500]), indices: new Uint32Array([0, 1, 2]),
      boundary: new Float32Array([-190, -190, 190, -190, 190, 190, -190, 190]),
    };
    const cols = 81, rows = 81;
    const heights = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 2 + 0.1 * (c - 40);
    const terrain: TerrainGrid = { x0: -40, z0: -40, cols, rows, datum: 0, heights };
    const pw = await createPhysicsWorld(far, terrain);
    const w = new RagdollWorld(pw);
    const f = new PlayerFigure(new Scene());
    f.update(3, 2.3, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
    f.ragdoll(w, { x: 0, y: 0, z: 2 }, 1, 5);
    const { lo } = run(f, w, new Vector3(3, 2.3, 1), 2);
    // ground under x ≈ 2..4: y ≈ 2.2..2.4
    expect(lo).toBeGreaterThan(1.95);
    const hips = f.group.children[0]!.localToWorld(new Vector3(0, 0.92, 0));
    expect(hips.y).toBeLessThan(2.3 + 0.5);
  });

  for (const [name, spin] of [['face down', 4], ['face up', -4]] as const) {
    test(`gets up from lying ${name}: over the ground the whole way, standing at the sim's spot in the end`, async () => {
      const pw = await createPhysicsWorld(city());
      const w = new RagdollWorld(pw);
      const f = new PlayerFigure(new Scene());
      f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
      f.ragdoll(w, { x: 0, y: 1, z: 3 }, spin, RISE_S + 2);
      run(f, w, new Vector3(0, 0, 2), 2);
      expect(f.ragdolling).toBe(true); // getting up
      const body = f.group.children[0]!;
      let lo = Infinity, hipsLo = Infinity;
      for (let i = 0; i < Math.round(RISE_S * 60) + 2; i++) {
        f.update(0, 0, 2, { x: 0, y: 0, z: 0 }, 1 / 60);
        if (!f.ragdolling) break;
        f.group.updateMatrixWorld(true);
        body.traverse((o) => { if (o !== body) lo = Math.min(lo, o.getWorldPosition(new Vector3()).y); });
        hipsLo = Math.min(hipsLo, body.localToWorld(new Vector3(0, 0.92, 0)).y);
      }
      expect(f.busy).toBe(false);
      expect(lo).toBeGreaterThan(-0.12);
      expect(hipsLo).toBeGreaterThan(0.05);
      expect(f.group.position.distanceTo(new Vector3(0, 0, 2))).toBeLessThan(1e-6);
    });
  }

  test('a car driving into a standing ragdoll strikes it: thrown ahead of the car, not through it', async () => {
    const pw = await createPhysicsWorld(city());
    const { rapier: R, world } = pw;
    // a kinematic car box (as the client's stand-in for a streamed car) 4 m behind, driving +z at 10 m/s
    const car = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.75, -2.6));
    world.createCollider(R.ColliderDesc.cuboid(0.85, 0.5, 2.1).setCollisionGroups(CAR_GROUPS), car);
    pw.step(); // (into the broad phase, as every sim step does)
    const w = new RagdollWorld(pw);
    const f = new PlayerFigure(new Scene());
    f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
    f.ragdoll(w, { x: 0, y: 0, z: 0 }, 0, 5);
    let fastest = 0;
    for (let i = 0; i < 30; i++) {
      const t = car.translation();
      car.setNextKinematicTranslation({ x: t.x, y: t.y, z: t.z + 10 / 60 });
      pw.step();
      w.step(1 / 60);
      f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60);
      f.group.updateMatrixWorld(true);
      const hips = f.group.children[0]!.localToWorld(new Vector3(0, 0.92, 0));
      fastest = Math.max(fastest, hips.z);
    }
    const front = car.translation().z + 2.1;
    const hips = f.group.children[0]!.localToWorld(new Vector3(0, 0.92, 0));
    // the car (front at z ≈ 2.5 now) has pushed the body along: ahead of its front or on the bonnet, never behind it
    expect(hips.z).toBeGreaterThan(1.5);
    expect(hips.z).toBeGreaterThan(front - 2.1);
    expect(fastest).toBeLessThan(front + 6); // struck, not shot away
  });

  test('lying still after a tumble, the joints are within a body\'s range (not crumpled)', async () => {
    const pw = await createPhysicsWorld(city());
    const w = new RagdollWorld(pw);
    const throws = [[{ x: 0, y: 2.2, z: 7 }, 3.5], [{ x: 3, y: 3, z: -6 }, -2.5], [{ x: -8, y: 1, z: 2 }, 0], [{ x: 0, y: 4, z: 10 }, 6]] as const;
    for (const [v, spin] of throws) {
      const f = new PlayerFigure(new Scene());
      f.ride(seat, grips, pedals, 'sport');
      f.ragdoll(w, v, spin, 10);
      run(f, w, new Vector3(0, 0, 0), 2.5);
      const body = f.group.children[0]!;
      const torso = body.children.find((c) => c.position.x === 0 && c.position.y > 0.5)!;
      const legs = body.children.filter((c) => Math.abs(c.position.x) > 0.05);
      const arms = torso.children.filter((c) => Math.abs(c.position.x) > 0.1);
      const e = (o: { quaternion: Quaternion }) => new Euler().setFromQuaternion(o.quaternion, 'XYZ');
      // the spine bends forward at most ~90°, back a little, hardly twists
      expect(e(torso).x).toBeGreaterThan(-0.75);
      expect(e(torso).x).toBeLessThan(1.75);
      expect(Math.abs(e(torso).y)).toBeLessThan(0.85);
      for (const leg of legs) {
        expect(e(leg).x).toBeGreaterThan(-2.6);
        expect(e(leg).x).toBeLessThan(0.8);
      }
      for (const arm of arms) {
        const fore = arm.children.find((c) => c.position.y < -0.1)!;
        // elbows never bend backwards: the forearm (rest: straight down the upper arm) does not point behind it
        const d = new Vector3(0, -1, 0).applyQuaternion(fore.quaternion);
        expect(d.z).toBeGreaterThan(-0.3); // (the limits give a little, ~15°)
      }
    }
  }, 20_000);
});
