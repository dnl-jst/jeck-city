import { describe, expect, test } from 'vitest';
import { Euler, Quaternion, Scene, Vector3 } from 'three';
import { createPhysicsWorld, type CollisionAsset, type TerrainGrid } from '@nn/shared';
import { PlayerFigure } from './player';
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
  test('a rider thrown off at 25 km/h tumbles, comes to rest on the ground and gets up where the sim is', async () => {
    const pw = await createPhysicsWorld(city());
    const w = new RagdollWorld(pw);
    const scene = new Scene();
    const f = new PlayerFigure(scene);
    f.ride(seat, grips, pedals, 'upright');
    const v = 25 / 3.6;
    f.ragdoll(w, { x: 0, y: 1.2, z: v * 0.75 }, 4, 3);
    expect(f.busy).toBe(true);
    const target = new Vector3(0, 0, 4);
    const fly = run(f, w, target, 1.5);
    expect(fly.lo).toBeGreaterThan(-0.15); // never through the ground
    expect(Number.isFinite(fly.hi)).toBe(true);
    // lying by now: the pelvis low, near the sim's spot
    const body = f.group.children[0]!;
    const hips = body.localToWorld(new Vector3(0, 0.92, 0));
    expect(hips.y).toBeLessThan(0.45);
    expect(Math.hypot(hips.x - target.x, hips.z - target.z)).toBeLessThan(2.5);
    run(f, w, target, 1.6);
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
});
