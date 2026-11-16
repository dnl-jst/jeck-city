import RAPIER from '@dimforge/rapier3d-compat';
import type { CollisionAsset } from '../assets/collision';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { TUNING } from './tuning';

export type Rapier = typeof RAPIER;

/** One Rapier world with the static city in it. step() advances exactly one fixed step (TUNING.world.dt). */
export type PhysicsWorld = { rapier: Rapier; world: RAPIER.World; step(): void };

/** The Rapier version this code is written for; must equal the dependency pinned in packages/shared/package.json. */
export const EXPECTED_RAPIER = '0.21.0';

let ready: Promise<void> | null = null;

/**
 * Loads the Rapier WASM once per process (memoised; safe to call from many places) and rejects if another
 * Rapier version got bundled: query-flag semantics differ between versions (in 0.12 EXCLUDE_KINEMATIC also
 * dropped fixed bodies, so wheel rays missed the ground), which would otherwise fail silently.
 */
export function initRapier(): Promise<void> {
  ready ??= RAPIER.init().then(() => {
    const v = RAPIER.version();
    if (v !== EXPECTED_RAPIER) throw new Error(`Rapier ${v} geladen, erwartet ${EXPECTED_RAPIER} – bitte node_modules neu installieren (npm ci)`);
  });
  return ready;
}

/**
 * Interaction groups (membership << 16 | filter). Bit layout:
 *   bit 0       the static city (keeps Rapier's default: member of all bits, collides with all)
 *   bit 1  0x02 street furniture (trees, lamps, bike rack hoops; see StreetProps, BikeRacks)
 *   bit 2  0x04 car chassis
 *   bit 3  0x08 people (walking capsules and their kinematic stand-ins)
 *   bit 4  0x10 bikes (ridden and parked)
 * Cars ignore people in the solver (carHitsPeople handles that contact); everything else collides. A knocked-down
 * lamp only collides with the city and furniture (filter bits 0–1): no car body bulldozes it along, and no bike or
 * person is stopped by it; the wheel rays still roll over it.
 */
export const PROP_GROUPS = 0x0002_ffff;
export const LYING_PROP_GROUPS = 0x0002_0003;
/**
 * Car chassis: bit 2, ignores bit 3 (people), so a car never gets stopped by a person in the solver; the character
 * controller query still sees cars (it passes no groups), so a person cannot walk through one.
 */
export const CAR_GROUPS = 0x0004_fff7;
/** People (capsules and their kinematic stand-ins): bit 3, ignore cars (bit 2). */
export const CHARACTER_GROUPS = 0x0008_fffb;
/** Bikes (ridden and parked): bit 4, collide with everything. */
export const BIKE_GROUPS = 0x0010_ffff;

/**
 * Scene-query predicate for the static city: solid colliders on fixed bodies, plus dynamic bodies (other cars,
 * fallen lamps) if `withDynamic`, plus street furniture (trees, lamp posts) if `withProps`; never sensors, kinematic
 * bodies (characters) or `skip`. A predicate instead of QueryFilterFlags, whose meaning changed between Rapier versions.
 */
export function staticWorldFilter(withDynamic = false, skip?: RAPIER.RigidBody, withProps = false): (c: RAPIER.Collider) => boolean {
  return (c) => {
    if (c.isSensor()) return false;
    if (!withProps && c.collisionGroups() >>> 16 === PROP_GROUPS >>> 16) return false;
    const b = c.parent();
    if (!b) return true; // a collider without a body is static
    if (skip && b.handle === skip.handle) return false;
    return b.isFixed() || (withDynamic && b.isDynamic());
  };
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
 * With `terrain`, the ground is additionally a fixed heightfield that coincides exactly with heightAt(terrain, …),
 * and the boundary walls follow the terrain.
 */
export async function createPhysicsWorld(c: CollisionAsset, terrain?: TerrainGrid): Promise<PhysicsWorld> {
  await initRapier();
  const world = new RAPIER.World({ x: 0, y: TUNING.world.gravity, z: 0 });
  world.timestep = TUNING.world.dt;

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const mesh = subdivideLargeTriangles(c.vertices, dropZeroAreaTriangles(c.vertices, c.indices), TUNING.world.maxTriangleEdge);
  // 1 cm quantisation leaves ~900 zero-area triangles (coincident or collinear corners); they make contact normals
  // undefined. dropZeroAreaTriangles removes both kinds; Rapier's flag (coincident corners only) is a cheap safety net.
  if (mesh.indices.length > 0) {
    world.createCollider(RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices, RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES), ground);
  }
  if (terrain) world.createCollider(terrainCollider(terrain), ground);
  addBoundaryWalls(world, ground, c.boundary, terrain);
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

/**
 * Rapier heightfield for the grid. Rapier wants an (nrows+1)×(ncols+1) matrix in column-major order, matrix rows along
 * local z and columns along local x, nrows/ncols being cell counts; the field spans ±scale/2 around the collider
 * translation, so it is placed at the grid centre. Verified against heightAt by the 'heightfield matches heightAt' test.
 */
function terrainCollider(t: TerrainGrid): RAPIER.ColliderDesc {
  const { cols, rows } = t;
  if (cols < 2 || rows < 2) throw new Error('terrain: grid needs at least 2×2 points');
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) h[c * rows + r] = t.heights[r * cols + c]!;
  return RAPIER.ColliderDesc.heightfield(rows - 1, cols - 1, h, { x: cols - 1, y: 1, z: rows - 1 }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setTranslation(t.x0 + (cols - 1) / 2, 0, t.z0 + (rows - 1) / 2);
}

/**
 * One thin cuboid per boundary edge. With terrain, each segment reaches from 1 m below the lowest terrain point along
 * it (sampled every 1 m) to boundaryWallHeight above the highest, so it neither floats nor gets buried.
 */
function addBoundaryWalls(world: RAPIER.World, body: RAPIER.RigidBody, b: Float32Array, terrain?: TerrainGrid): void {
  const { boundaryWallHeight: h, boundaryWallThickness: t } = TUNING.world;
  const n = b.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n; // ring is closed: the last point connects back to the first
    const x0 = b[2 * i]!, z0 = b[2 * i + 1]!, x1 = b[2 * j]!, z1 = b[2 * j + 1]!;
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue; // repeated closing point
    const a = Math.atan2(dx, dz); // rotation about +y that maps local +z onto the edge
    let bottom = 0, height = h;
    if (terrain) {
      let lo = Infinity, hi = -Infinity;
      const steps = Math.ceil(len);
      for (let k = 0; k <= steps; k++) {
        const y = heightAt(terrain, x0 + (dx * k) / steps, z0 + (dz * k) / steps);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      bottom = lo - 1;
      height = h + (hi - lo) + 1;
    }
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(t / 2, height / 2, len / 2 + t / 2) // + t/2 closes the gaps at corners
        .setTranslation((x0 + x1) / 2, bottom + height / 2, (z0 + z1) / 2)
        .setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }),
      body,
    );
  }
}

/** Indices without the triangles of zero area (coincident or collinear corners); the same array if there are none. */
export function dropZeroAreaTriangles(v: Float32Array, idx: Uint32Array): Uint32Array {
  const keep: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!, b = 3 * idx[t + 1]!, c = 3 * idx[t + 2]!;
    const ux = v[b]! - v[a]!, uy = v[b + 1]! - v[a + 1]!, uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!, wy = v[c + 1]! - v[a + 1]!, wz = v[c + 2]! - v[a + 2]!;
    if (uy * wz - uz * wy !== 0 || uz * wx - ux * wz !== 0 || ux * wy - uy * wx !== 0) keep.push(t);
  }
  if (keep.length === idx.length / 3) return idx;
  const out = new Uint32Array(keep.length * 3);
  keep.forEach((t, k) => out.set(idx.subarray(t, t + 3), 3 * k));
  return out;
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
