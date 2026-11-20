import RAPIER from '@dimforge/rapier3d-compat';
import type { CollisionAsset } from '../assets/collision';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { openingTest } from '../transit';
import { TUNING } from './tuning';

export type Rapier = typeof RAPIER;

/**
 * One Rapier world with the static city in it. step() advances exactly one fixed step (TUNING.world.dt).
 * city: set when the city's colliders are streamed (see createPhysicsWorld's `stream`); then only the tiles around the
 * points passed to city.update() exist.
 */
export type PhysicsWorld = {
  rapier: Rapier; world: RAPIER.World; step(): void; city?: CityTiles;
  /**
   * The terrain heightfield, and where the ground is open (stairwells down to the underground, see Transit.openings):
   * there, people and the camera ignore the heightfield (it cannot have holes).
   */
  terrain?: { handle: number; open(x: number, z: number): boolean };
  /** Collider handles of the trains' floors (see Trains): walking people leave them out of the character controller. */
  trainFloors?: Set<number>;
};

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
/** Train sections (kinematic): walls, roof and doors are bit 5, the floor bit 6 (people over it are carried along); both collide with everything. */
export const TRAIN_GROUPS = 0x0020_ffff;
export const TRAIN_FLOOR_GROUPS = 0x0040_ffff;
/**
 * The terrain heightfield: bits 0 and 7 only (the city's trimeshes keep Rapier's default, all bits). So a filter
 * without those two bits (OFF_TERRAIN) sees the city but not the terrain: what a car in a stairwell down to the
 * underground collides with (see PhysicsWorld.terrain; wheel rays take no predicate, only groups).
 */
export const TERRAIN_GROUPS = 0x0081_ffff;
export const OFF_TERRAIN = 0xff7e;

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

/** Callbacks run right after every world.step() (a person carried along by the car they stand on). */
const afterStep = new WeakMap<PhysicsWorld, Set<() => void>>();

/** Registers fn to run after each step of pw; returns an unsubscribe function. */
export function onAfterStep(pw: PhysicsWorld, fn: () => void): () => void {
  const set = afterStep.get(pw)!;
  set.add(fn);
  return () => set.delete(fn);
}

/** Side (m) of the square tiles the city's collision mesh is split into: one trimesh collider per tile. */
export const COLLISION_TILE = 100;

/**
 * Builds the world: the city as fixed trimeshes (one per COLLISION_TILE tile), plus an invisible wall
 * segment (thin cuboid) along every edge of the play-area boundary ring.
 * With `terrain`, the ground is additionally a fixed heightfield that coincides exactly with heightAt(terrain, …),
 * and the boundary walls follow the terrain.
 * sliceMs: give the event loop a turn whenever building has run this long (the browser: input and rendering stay
 * responsive while ~4M triangles become colliders, which otherwise blocks the page for seconds). Same world either way.
 * stream: only build the city tiles near these points now (the client: the whole city takes seconds and over a GB on
 * a phone, but it only ever simulates its own player); pw.city then adds and drops tiles as the points move. Without
 * it (the server) the whole city is built.
 */
export async function createPhysicsWorld(
  c: CollisionAsset, terrain?: TerrainGrid, opts: { sliceMs?: number; stream?: readonly XZ[]; openings?: readonly (readonly number[])[] } = {},
): Promise<PhysicsWorld> {
  await initRapier();
  const slice = timeSlicer(opts.sliceMs);
  const world = new RAPIER.World({ x: 0, y: TUNING.world.gravity, z: 0 });
  world.timestep = TUNING.world.dt;
  skipSoftBodyRemap(world);

  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  // 1 cm quantisation leaves ~900 zero-area triangles (coincident or collinear corners); they make contact normals
  // undefined, so they go. Large triangles are split before tiling, so every piece lands in the tile it lies in.
  const fine = subdivideLargeTriangles(c.vertices, dropZeroAreaTriangles(c.vertices, c.indices), TUNING.world.maxTriangleEdge);
  await slice();
  const steps = tileSteps(fine.vertices, fine.indices, COLLISION_TILE);
  let r = steps.next();
  for (; !r.done; r = steps.next()) await slice();
  const city = new CityTiles(world, ground, fine.vertices, splitDenseTiles(fine.vertices, r.value, COLLISION_TILE, MAX_PIECE_TRIANGLES));
  await slice();
  if (opts.stream) {
    await city.update(opts.stream, Infinity, slice);
  } else {
    for (let i = 0; i < city.count; i++) {
      city.build(i);
      await slice();
    }
  }
  const terrainHandle = terrain ? world.createCollider(terrainCollider(terrain), ground).handle : null;
  await slice();
  addBoundaryWalls(world, ground, c.boundary, terrain);
  await slice();
  // One empty step builds the broad phase, so ray casts and character queries work right away
  // (World.updateSceneQueries is declared in the typings but missing at runtime in 0.21.0).
  world.step();

  const hooks = new Set<() => void>(), after = new Set<() => void>();
  const pw: PhysicsWorld = {
    rapier: RAPIER,
    world,
    step() {
      for (const fn of hooks) fn();
      world.step();
      for (const fn of after) fn();
    },
  };
  if (opts.stream) pw.city = city;
  if (terrainHandle !== null && opts.openings?.length) pw.terrain = { handle: terrainHandle, open: openingTest(opts.openings) };
  beforeStep.set(pw, hooks);
  afterStep.set(pw, after);
  return pw;
}

type XZ = { x: number; z: number };

/** Streamed city pieces: always built within CITY_NEED of a focus point, … */
export const CITY_NEED = 160;
/** …built within CITY_WANT as time allows, … */
export const CITY_WANT = 260;
/** …and dropped beyond CITY_DROP of every focus point. */
export const CITY_DROP = 400;
/** The pieces' distances are recomputed after a focus point moved this far (m). */
const RESCAN_MOVE = 8;

/**
 * Most triangles one collider of the city gets: a denser tile is split into quadrants (recursively). Building a trimesh
 * costs ~2 µs per triangle on a desktop (several times that on a phone) and cannot be split across frames, so this
 * bounds the hitch of streaming one piece in.
 */
export const MAX_PIECE_TRIANGLES = 1500;
/** Smallest piece side (m): a denser square stays one piece. */
const MIN_PIECE = COLLISION_TILE / 64;

/** A square of the city (x0, z0, side `size`) and the indices of the triangles whose centroid lies in it. */
export type Piece = { x0: number; z0: number; size: number; idx: Uint32Array };

/** Tiles (side `size`) as pieces, those with more than maxTris triangles split into quadrants until they fit. */
export function splitDenseTiles(v: Float32Array, tiles: readonly Tile[], size: number, maxTris: number): Piece[] {
  const out: Piece[] = [];
  const split = (p: Piece): void => {
    if (p.idx.length / 3 <= maxTris || p.size / 2 < MIN_PIECE) {
      out.push(p);
      return;
    }
    const h = p.size / 2;
    const quads: number[][] = [[], [], [], []];
    for (let t = 0; t < p.idx.length; t += 3) {
      const a = 3 * p.idx[t]!, b = 3 * p.idx[t + 1]!, c = 3 * p.idx[t + 2]!;
      const qx = (v[a]! + v[b]! + v[c]!) / 3 >= p.x0 + h ? 1 : 0;
      const qz = (v[a + 2]! + v[b + 2]! + v[c + 2]!) / 3 >= p.z0 + h ? 1 : 0;
      quads[2 * qz + qx]!.push(p.idx[t]!, p.idx[t + 1]!, p.idx[t + 2]!);
    }
    quads.forEach((q, k) => {
      if (q.length) split({ x0: p.x0 + (k % 2) * h, z0: p.z0 + Math.floor(k / 2) * h, size: h, idx: new Uint32Array(q) });
    });
  };
  for (const t of tiles) split({ x0: t.tx * size, z0: t.tz * size, size, idx: t.idx });
  return out;
}

type PieceMesh = { vertices: Float32Array; indices: Uint32Array };

/**
 * The city's collision mesh as pieces (COLLISION_TILE tiles, dense ones split), each one trimesh collider that can be
 * built and removed on its own. Building a piece always makes the same collider (geometry and flags), so a streamed
 * world has exactly the server's colliders wherever it has pieces. Streaming prepares a piece's mesh (JS) and builds
 * its collider (Rapier) as separate units of work, so a frame's budget can end between them.
 */
export class CityTiles {
  private readonly colliders: (RAPIER.Collider | null)[];
  /** The points of the last full scan, and the pieces it found missing (nearest first) that are not built yet. */
  private scanned: XZ[] | null = null;
  private pending: { i: number; d: number }[] = [];
  /** Meshes prepared but not built yet (the budget ran out in between). */
  private readonly prepared = new Map<number, PieceMesh>();
  private readonly scratch: Int32Array<ArrayBuffer>;

  constructor(
    private readonly world: RAPIER.World, private readonly body: RAPIER.RigidBody, private readonly vertices: Float32Array,
    private readonly pieces: readonly Piece[],
  ) {
    this.colliders = pieces.map(() => null);
    this.scratch = new Int32Array(vertices.length / 3).fill(-1);
  }

  get count(): number {
    return this.pieces.length;
  }

  /** Pieces that currently have a collider. */
  get built(): number {
    return this.colliders.reduce((n, c) => n + (c ? 1 : 0), 0);
  }

  /** Piece i's mesh in its own vertex numbering (kept until built). */
  private prepare(i: number): PieceMesh {
    let m = this.prepared.get(i);
    if (!m) this.prepared.set(i, (m = compactMesh(this.vertices, this.pieces[i]!.idx, this.scratch)));
    return m;
  }

  /** Makes piece i's collider (no-op if it exists). */
  build(i: number): void {
    if (this.colliders[i]) return;
    const mesh = this.prepare(i);
    this.prepared.delete(i);
    // Rapier's flag (coincident corners only) is a cheap safety net behind dropZeroAreaTriangles
    this.colliders[i] = this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(mesh.vertices, mesh.indices, RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES), this.body,
    );
  }

  /** Distance (m, x/z) from piece i's square to the nearest of `points`. */
  private distance(i: number, points: readonly XZ[]): number {
    const { x0, z0, size } = this.pieces[i]!;
    let d = Infinity;
    for (const p of points) {
      const dx = Math.max(x0 - p.x, 0, p.x - (x0 + size));
      const dz = Math.max(z0 - p.z, 0, p.z - (z0 + size));
      d = Math.min(d, Math.hypot(dx, dz));
    }
    return d;
  }

  /**
   * Drops pieces beyond CITY_DROP of all points, builds every missing one within CITY_NEED and, nearest first, those
   * within CITY_WANT until budgetMs have passed. Returns how many pieces were built. New colliders take part in the next
   * step's contacts but are seen by scene queries (rays, character controller) only after it.
   */
  update(points: readonly XZ[], budgetMs: number): number;
  update(points: readonly XZ[], budgetMs: number, slice: () => Promise<void>): Promise<number>;
  update(points: readonly XZ[], budgetMs: number, slice?: () => Promise<void>): number | Promise<number> {
    // the full scan (every piece) only after a point moved RESCAN_MOVE; in between the pending list is worked off, its
    // distances up to RESCAN_MOVE stale (so CITY_NEED is checked with that much slack)
    const moved = !this.scanned || this.scanned.length !== points.length
      || points.some((p, k) => Math.hypot(p.x - this.scanned![k]!.x, p.z - this.scanned![k]!.z) > RESCAN_MOVE);
    if (moved) {
      this.scanned = points.map((p) => ({ x: p.x, z: p.z }));
      this.pending = [];
      for (let i = 0; i < this.pieces.length; i++) {
        const d = this.distance(i, points);
        const c = this.colliders[i];
        if (d > CITY_DROP) {
          if (c) this.world.removeCollider(c, false);
          this.colliders[i] = null;
          this.prepared.delete(i);
        } else if (!c && d <= CITY_WANT) {
          this.pending.push({ i, d });
        }
      }
      this.pending.sort((a, b) => a.d - b.d);
    }
    if (this.pending.length === 0) return slice ? Promise.resolve(0) : 0;
    const slack = moved ? 0 : RESCAN_MOVE;
    const todo = this.pending;
    const t0 = performance.now();
    const over = (d: number): boolean => d - slack > CITY_NEED && performance.now() - t0 >= budgetMs;
    const run = function* (this: CityTiles): Generator<void, number> {
      let n = 0, k = 0;
      for (; k < todo.length; k++) {
        const { i, d } = todo[k]!;
        if (this.colliders[i]) continue;
        if (over(d)) break;
        this.prepare(i);
        if (over(d)) break;
        this.build(i);
        n++;
        yield;
      }
      this.pending = todo.slice(k);
      return n;
    }.bind(this);
    const g = run();
    if (!slice) {
      for (;;) {
        const r = g.next();
        if (r.done) return r.value;
      }
    }
    return (async () => {
      for (;;) {
        const r = g.next();
        if (r.done) return r.value;
        await slice();
      }
    })();
  }
}

/**
 * rapier.js 0.21 ends every World.step with mapNewSoftBodies(): it walks every rigid-body and collider handle through
 * wasm→JS callbacks and filters both wrapper maps, to wrap the pieces soft-body tearing creates inside a step. With the
 * city's ~14k street props that bookkeeping cost ~4 ms per step, while the physics itself took ~0.03 ms. This world
 * has no soft bodies, so a step never creates or removes a body or collider; createRigidBody/createCollider and the
 * remove calls keep the wrapper maps up to date themselves. The remap therefore only runs while soft bodies exist.
 */
function skipSoftBodyRemap(world: RAPIER.World): void {
  const remap = world.mapNewSoftBodies.bind(world);
  world.mapNewSoftBodies = () => {
    if (world.softBodies.len() > 0) remap();
  };
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
    .setCollisionGroups(TERRAIN_GROUPS)
    .setTranslation(t.x0 + (cols - 1) / 2, 0, t.z0 + (rows - 1) / 2);
}

/**
 * One thin cuboid per boundary edge. With terrain, each segment reaches from 1 m below the lowest terrain point along
 * it (sampled every 1 m) to boundarySkyHeight above the highest (the visible curtain is only boundaryWallHeight high), so it neither floats nor gets buried.
 */
function addBoundaryWalls(world: RAPIER.World, body: RAPIER.RigidBody, b: Float32Array, terrain?: TerrainGrid): void {
  const { boundarySkyHeight: h, boundaryWallThickness: t } = TUNING.world;
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

/** Returns a function that yields to the event loop once `ms` have passed since the last yield (never without ms). */
export function timeSlicer(ms?: number): () => Promise<void> {
  if (ms === undefined) return async () => {};
  let last = performance.now();
  return async () => {
    if (performance.now() - last < ms) return;
    await new Promise((r) => setTimeout(r, 0));
    last = performance.now();
  };
}

/**
 * Groups the triangles by the tile (side `size`, x/z) their centroid lies in; per tile its triangles' indices
 * (into `v`), tiles in row order so every build makes the same colliders in the same order. Empty tiles are left out.
 */
export function tileTriangles(v: Float32Array, idx: Uint32Array, size: number): Uint32Array[] {
  const steps = tileSteps(v, idx, size);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value.map((t) => t.idx);
  }
}

/** One tile of the city mesh: its grid cell (tx, tz: x/z divided by the tile size, floored) and its triangles' indices. */
export type Tile = { tx: number; tz: number; idx: Uint32Array };

/** Triangles per pause point of tileSteps. */
const TILE_BATCH = 65_536;

/** tileTriangles as a generator that pauses (yields) every TILE_BATCH triangles, for time-sliced building. */
export function* tileSteps(v: Float32Array, idx: Uint32Array, size: number): Generator<void, Tile[]> {
  const tris = idx.length / 3;
  if (tris === 0) return [];
  const cx = new Int32Array(tris), cz = new Int32Array(tris);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let t = 0; t < tris; t++) {
    if (t % TILE_BATCH === TILE_BATCH - 1) yield;
    const a = 3 * idx[3 * t]!, b = 3 * idx[3 * t + 1]!, c = 3 * idx[3 * t + 2]!;
    const tx = (cx[t] = Math.floor((v[a]! + v[b]! + v[c]!) / (3 * size)));
    const tz = (cz[t] = Math.floor((v[a + 2]! + v[b + 2]! + v[c + 2]!) / (3 * size)));
    if (tx < x0) x0 = tx;
    if (tx > x1) x1 = tx;
    if (tz < z0) z0 = tz;
    if (tz > z1) z1 = tz;
  }
  const w = x1 - x0 + 1;
  const cell = new Int32Array(tris);
  const counts = new Int32Array(w * (z1 - z0 + 1));
  for (let t = 0; t < tris; t++) {
    if (t % TILE_BATCH === TILE_BATCH - 1) yield;
    counts[(cell[t] = (cz[t]! - z0) * w + (cx[t]! - x0))]!++;
  }
  const out: (Uint32Array | null)[] = Array.from(counts, (n) => (n > 0 ? new Uint32Array(3 * n) : null));
  const fill = new Int32Array(counts.length);
  for (let t = 0; t < tris; t++) {
    if (t % TILE_BATCH === TILE_BATCH - 1) yield;
    const k = cell[t]!;
    out[k]!.set(idx.subarray(3 * t, 3 * t + 3), fill[k]!);
    fill[k]! += 3;
  }
  const tiles: Tile[] = [];
  out.forEach((t, k) => {
    if (t) tiles.push({ tx: x0 + (k % w), tz: z0 + Math.floor(k / w), idx: t });
  });
  return tiles;
}

/**
 * The vertices `idx` uses, and `idx` renumbered into them (first use order). `scratch`: a reusable remap buffer of
 * v.length / 3 entries, all -1 (left that way again on return).
 */
export function compactMesh(v: Float32Array, idx: Uint32Array, scratch = new Int32Array(v.length / 3).fill(-1)): { vertices: Float32Array; indices: Uint32Array } {
  const indices = new Uint32Array(idx.length);
  const used: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]!;
    let j = scratch[i]!;
    if (j < 0) {
      j = scratch[i] = used.length;
      used.push(i);
    }
    indices[k] = j;
  }
  const vertices = new Float32Array(3 * used.length);
  used.forEach((i, j) => {
    vertices[3 * j] = v[3 * i]!;
    vertices[3 * j + 1] = v[3 * i + 1]!;
    vertices[3 * j + 2] = v[3 * i + 2]!;
    scratch[i] = -1;
  });
  return { vertices, indices };
}

/** Indices without the triangles of zero area (coincident or collinear corners); the same array if there are none. */
export function dropZeroAreaTriangles(v: Float32Array, idx: Uint32Array): Uint32Array {
  const out = new Uint32Array(idx.length);
  let n = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t]!, ib = idx[t + 1]!, ic = idx[t + 2]!;
    const a = 3 * ia, b = 3 * ib, c = 3 * ic;
    const ux = v[b]! - v[a]!, uy = v[b + 1]! - v[a + 1]!, uz = v[b + 2]! - v[a + 2]!;
    const wx = v[c]! - v[a]!, wy = v[c + 1]! - v[a + 1]!, wz = v[c + 2]! - v[a + 2]!;
    if (uy * wz - uz * wy !== 0 || uz * wx - ux * wz !== 0 || ux * wy - uy * wx !== 0) {
      out[n++] = ia; out[n++] = ib; out[n++] = ic;
    }
  }
  return n === idx.length ? idx : out.slice(0, n);
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
  const keep = new Uint32Array(idx.length);
  let kept = 0;
  const max2 = maxEdge * maxEdge;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t]!, ib = idx[t + 1]!, ic = idx[t + 2]!;
    // most triangles are small: compare squared edge lengths before building anything
    if (edge2(v, ia, ib) <= max2 && edge2(v, ib, ic) <= max2 && edge2(v, ic, ia) <= max2) {
      keep[kept++] = ia; keep[kept++] = ib; keep[kept++] = ic;
      continue;
    }
    const a = [v[3 * ia]!, v[3 * ia + 1]!, v[3 * ia + 2]!];
    const b = [v[3 * ib]!, v[3 * ib + 1]!, v[3 * ib + 2]!];
    const c = [v[3 * ic]!, v[3 * ic + 1]!, v[3 * ic + 2]!];
    const d = (p: number[], q: number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
    const n = Math.ceil(Math.max(d(a, b), d(b, c), d(c, a)) / maxEdge);
    if (n <= 1) {
      keep[kept++] = ia; keep[kept++] = ib; keep[kept++] = ic;
      continue;
    }
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
  const indices = new Uint32Array(kept + outI.length);
  indices.set(keep.subarray(0, kept));
  indices.set(outI, kept);
  return { vertices, indices };
}

/** Squared distance between vertices p and q of v. */
function edge2(v: Float32Array, p: number, q: number): number {
  const dx = v[3 * p]! - v[3 * q]!, dy = v[3 * p + 1]! - v[3 * q + 1]!, dz = v[3 * p + 2]! - v[3 * q + 2]!;
  return dx * dx + dy * dy + dz * dz;
}
