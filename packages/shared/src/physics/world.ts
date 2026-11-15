import RAPIER from '@dimforge/rapier3d-compat';
import type { CollisionAsset } from '../assets/collision';
import { TUNING } from './tuning';

export type Rapier = typeof RAPIER;

/** One Rapier world with the static city in it. step() advances exactly one fixed step (TUNING.world.dt). */
export type PhysicsWorld = { rapier: Rapier; world: RAPIER.World; step(): void };

let ready: Promise<void> | null = null;

/** Loads the Rapier WASM once per process (memoised; safe to call from many places). */
export function initRapier(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

/** Callbacks run right before every world.step() (vehicle controllers live here). */
const beforeStep = new WeakMap<PhysicsWorld, Set<() => void>>();

/** Registers fn to run before each step of pw; returns an unsubscribe function. */
export function onBeforeStep(pw: PhysicsWorld, fn: () => void): () => void {
  const set = beforeStep.get(pw)!;
  set.add(fn);
  return () => set.delete(fn);
}

/**
 * Builds the world: the city as one fixed trimesh, plus an invisible wall
 * segment (thin cuboid) along every edge of the play-area boundary ring.
 */
export async function createPhysicsWorld(c: CollisionAsset): Promise<PhysicsWorld> {
  await initRapier();
  const world = new RAPIER.World({ x: 0, y: TUNING.world.gravity, z: 0 });
  world.timestep = TUNING.world.dt;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const mesh = subdivideLargeTriangles(c.vertices, c.indices, TUNING.world.maxTriangleEdge);
  world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices), ground);
  addBoundaryWalls(world, ground, c.boundary);
  // One empty step builds the broad phase, so ray casts and character queries work right away
  // (World.updateSceneQueries is declared in the typings but missing at runtime in 0.21.0).
  world.step();

  const hooks = new Set<() => void>();
  const pw: PhysicsWorld = {
    rapier: RAPIER,
    world,
    step() {
      for (const fn of hooks) fn();
      world.step();
    },
  };
  beforeStep.set(pw, hooks);
  return pw;
}

function addBoundaryWalls(world: RAPIER.World, body: RAPIER.RigidBody, b: Float32Array): void {
  const { boundaryWallHeight: h, boundaryWallThickness: t } = TUNING.world;
  const n = b.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // ring is closed: the last point connects back to the first
    const x0 = b[2 * i]!, z0 = b[2 * i + 1]!, x1 = b[2 * j]!, z1 = b[2 * j + 1]!;
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue; // repeated closing point
    const a = Math.atan2(dx, dz); // rotation about +y that maps local +z onto the edge
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t / 2, h / 2, len / 2 + t / 2) // + t/2 closes the gaps at corners
        .setTranslation((x0 + x1) / 2, h / 2, (z0 + z1) / 2)
        .setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }),
      body,
    );
  }
}

/**
 * Splits every triangle with an edge longer than maxEdge into an n×n grid of smaller ones
 * (n = ceil(longest edge / maxEdge)). Rapier's capsule-vs-triangle contacts lose precision on
 * huge triangles (the ~2.5 km ground rectangle let the character sink 0.15–0.3 m into it).
 */
export function subdivideLargeTriangles(v: Float32Array, idx: Uint32Array, maxEdge: number): { vertices: Float32Array; indices: Uint32Array } {
  const outV: number[] = [];
  const outI: number[] = [];
  let next = v.length / 3;
  const keep: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t]!, ib = idx[t + 1]!, ic = idx[t + 2]!;
    const a = [v[3 * ia]!, v[3 * ia + 1]!, v[3 * ia + 2]!];
    const b = [v[3 * ib]!, v[3 * ib + 1]!, v[3 * ib + 2]!];
    const c = [v[3 * ic]!, v[3 * ic + 1]!, v[3 * ic + 2]!];
    const d = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const n = Math.ceil(Math.max(d(a, b), d(b, c), d(c, a)) / maxEdge);
    if (n <= 1) { keep.push(ia, ib, ic); continue; }
    // Grid point (i, j) = a + (b − a)·i/n + (c − a)·j/n, for i + j ≤ n.
    const row: number[][] = [];
    for (let i = 0; i <= n; i++) {
      row.push([]);
      for (let j = 0; j <= n - i; j++) {
        for (let k = 0; k < 3; k++) outV.push(a[k]! + ((b[k]! - a[k]!) * i) / n + ((c[k]! - a[k]!) * j) / n);
        row[i]!.push(next++);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        outI.push(row[i]![j]!, row[i + 1]![j]!, row[i]![j + 1]!); // same winding as (a, b, c)
        if (j < n - i - 1) outI.push(row[i + 1]![j]!, row[i + 1]![j + 1]!, row[i]![j + 1]!);
      }
    }
  }
  if (outI.length === 0) return { vertices: v, indices: idx };
  const vertices = new Float32Array(v.length + outV.length);
  vertices.set(v);
  vertices.set(outV, v.length);
  return { vertices, indices: Uint32Array.from([...keep, ...outI]) };
}
