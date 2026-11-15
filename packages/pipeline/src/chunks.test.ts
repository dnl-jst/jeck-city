import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { chunkKey, utmToLocal, type TerrainGrid } from '@nn/shared';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { buildChunks, buildCollision, encodeChunkGlb, worldRect, type StreetMeshes } from './chunks.js';
import { boxBuilding } from './fixture.js';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';
import { wallEaves } from '../../../apps/client/src/materials/facade';
import type { Mesh } from './streets.js';

const empty = (): Mesh => ({ positions: new Float32Array(), indices: new Uint32Array(), uv: new Float32Array() });
/** Two flat triangles: one with centroid in chunk 0_0, one in chunk 1_0. */
const twoTris = (y: number): Mesh => ({
  positions: new Float32Array([10, y, 10, 20, y, 10, 10, y, 20, 210, y, 10, 220, y, 10, 210, y, 20]),
  indices: new Uint32Array([0, 2, 1, 3, 5, 4]),
  uv: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
});
const streets = (): StreetMeshes => ({ road: twoTris(0.01), sidewalk: empty(), curb: twoTris(0.12), trackbed: empty(), tram: empty(), green: empty(), squares: empty() });
const buildings = () => [boxBuilding('A', 10, 10, 30, 30, 10, 1), boxBuilding('B', 50, 50, 60, 70, 12), boxBuilding('C', -30, 10, -10, 30, 8, 2)];
const boundary = [{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }];

test('chunk key for point', () => expect(chunkKey(-1, 399)).toBe('-1_1'));

test('buildings go to the chunk of their centroid with contiguous, welded vertex ranges', () => {
  const chunks = buildChunks(buildings(), streets());
  expect(chunks.map((c) => c.key).sort()).toEqual(['-1_0', '0_0', '1_0']);
  const c = chunks.find((k) => k.key === '0_0')!;
  const b = c.buildings!;
  expect(b.ranges).toEqual([{ id: 'A', firstVertex: 0, vertexCount: 20 }, { id: 'B', firstVertex: 20, vertexCount: 20 }]);
  expect(b.indices.length).toBe(2 * 30); // 10 triangles per box
  expect(b.positions.length).toBe(40 * 3);
  // triangles of B only reference B's range
  for (let i = 30; i < 60; i++) expect(b.indices[i]).toBeGreaterThanOrEqual(20);
  // per-vertex building attributes
  expect(b.seed[0]).toBeCloseTo(boxBuilding('A', 0, 0, 1, 1, 1).buildingSeed / 2 ** 32, 9);
  expect(b.flags[0]).toBe(1);
  expect(b.flags[20]).toBe(0);
  expect(chunks.find((k) => k.key === '-1_0')!.buildings!.flags[0]).toBe(2);
});

test('street triangles are split by triangle centroid, positions stay in world space', () => {
  const chunks = buildChunks([], streets());
  expect(chunks.map((c) => c.key).sort()).toEqual(['0_0', '1_0']);
  const far = chunks.find((c) => c.key === '1_0')!;
  expect(far.buildings).toBeUndefined();
  expect(Object.keys(far.streets).sort()).toEqual(['curb', 'road']);
  expect(Array.from(far.streets.road!.positions)).toEqual([210, 0.01, 10, 210, 0.01, 20, 220, 0.01, 10].map(Math.fround)); // first-use order
  expect(Array.from(far.streets.road!.indices)).toEqual([0, 1, 2]);
});

test('street triangles outside the world area are dropped', () => {
  const chunks = buildChunks([], streets(), {}, { minX: 0, minZ: 0, maxX: 100, maxZ: 100 });
  expect(chunks.map((c) => c.key)).toEqual(['0_0']);
  expect(worldRect(boundary)).toEqual({ minX: -200, minZ: -200, maxX: 500, maxZ: 500 });
});

test('override entry removes the building from chunk geometry and collision', () => {
  const overrides = { B: 'models/b.glb' };
  const c = buildChunks(buildings(), streets(), overrides).find((k) => k.key === '0_0')!;
  expect(c.buildings!.ranges.map((r) => r.id)).toEqual(['A']);
  expect(c.buildings!.positions.length).toBe(20 * 3);
  const col = buildCollision({ buildings: buildings(), curb: empty(), sidewalk: empty(), boundary, overrides });
  const xs = Array.from({ length: col.vertices.length / 3 }, (_, i) => [col.vertices[i * 3]!, col.vertices[i * 3 + 2]!]);
  expect(xs.some(([x, z]) => x === 50 && z === 50)).toBe(false); // B's corner
  expect(xs.some(([x, z]) => x === 10 && z === 10)).toBe(true); // A's corner
});

test('collision has buildings, kerbs and a ground rectangle at y=0 over the boundary bbox + 200 m', () => {
  const col = buildCollision({ buildings: buildings(), curb: streets().curb, sidewalk: empty(), boundary });
  const n = col.vertices.length / 3;
  const v = (i: number) => [col.vertices[i * 3]!, col.vertices[i * 3 + 1]!, col.vertices[i * 3 + 2]!];
  const all = Array.from({ length: n }, (_, i) => v(i));
  expect(all).toContainEqual([-200, 0, -200]);
  expect(all).toContainEqual([500, 0, 500]);
  expect(all).toContainEqual([Math.fround(210), Math.fround(0.12), 10]);
  // 3 boxes × 10 triangles + 2 kerb + 2 ground
  expect(col.indices.length).toBe((30 + 2 + 2) * 3);
  expect(Math.max(...col.indices)).toBeLessThan(n);
  // welded: a box has 8 distinct corners
  expect(n).toBe(3 * 8 + 6 + 4);
  expect(Array.from(col.boundary)).toEqual([0, 0, 300, 0, 300, 300, 0, 300]);
});

test('collision includes the walkable sidewalk surface at y = 0.12, welded with the kerb, without degenerate triangles', () => {
  const kerb = twoTris(0.12);
  // sidewalk shares the kerb triangle's edge (20,10)-(10,20) and adds one degenerate (collinear) triangle
  const sidewalk: Mesh = {
    positions: new Float32Array([20, 0.12, 10, 10, 0.12, 20, 20, 0.12, 20, 30, 0.12, 30, 40, 0.12, 40, 50, 0.12, 50]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    uv: new Float32Array(12),
  };
  const kerbOnly = buildCollision({ buildings: [], curb: kerb, sidewalk: empty(), boundary });
  const col = buildCollision({ buildings: [], curb: kerb, sidewalk, boundary });
  expect(col.indices.length - kerbOnly.indices.length).toBe(3); // one sidewalk triangle; the collinear one is dropped
  const tri = Array.from(col.indices.slice(-9, -6), (i) => [col.vertices[i * 3]!, col.vertices[i * 3 + 1]!, col.vertices[i * 3 + 2]!]);
  expect(tri).toContainEqual([20, Math.fround(0.12), 20]);
  expect(tri.every((p) => p[1] === Math.fround(0.12))).toBe(true);
  expect(col.vertices.length - kerbOnly.vertices.length).toBe(3 * 1); // only (20, 0.12, 20) is new: the shared edge is welded
});

test('collision can drop backdrop roofs', () => {
  const full = buildCollision({ buildings: buildings(), curb: empty(), sidewalk: empty(), boundary });
  const lean = buildCollision({ buildings: buildings(), curb: empty(), sidewalk: empty(), boundary, dropBackdropRoofs: true });
  expect(full.indices.length - lean.indices.length).toBe(2 * 3); // C's two roof triangles
});

test('chunk GLB is meshopt-compressed and keeps custom attributes and building ranges', async () => {
  const chunk = buildChunks(buildings(), streets()).find((k) => k.key === '0_0')!;
  const glb = await encodeChunkGlb(chunk);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  expect(json.extensionsUsed).toContain('EXT_meshopt_compression');

  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(glb);
  const meshes = doc.getRoot().listMeshes();
  expect(meshes.map((m) => m.getName()).sort()).toEqual(['buildings', 'curb', 'road']);
  const prim = meshes.find((m) => m.getName() === 'buildings')!.listPrimitives()[0]!;
  expect(prim.listSemantics().sort()).toEqual(['NORMAL', 'POSITION', '_FACADEUV', '_FLAGS', '_KIND', '_SEED']);
  expect(Array.from(prim.getAttribute('_SEED')!.getArray()!)).toEqual(Array.from(chunk.buildings!.seed));
  expect(Array.from(prim.getAttribute('_FACADEUV')!.getArray()!)).toEqual(Array.from(chunk.buildings!.facadeUv));
  expect(Array.from(prim.getAttribute('POSITION')!.getArray()!)).toEqual(Array.from(chunk.buildings!.positions));
  expect(Array.from(prim.getIndices()!.getArray()!)).toEqual(Array.from(chunk.buildings!.indices));
  expect(doc.getRoot().listScenes()[0]!.getExtras()).toEqual({ buildings: chunk.buildings!.ranges });
  const road = meshes.find((m) => m.getName() === 'road')!.listPrimitives()[0]!;
  expect(road.listSemantics().sort()).toEqual(['POSITION', 'TEXCOORD_0']);
});

/** Flat-ish grid over x/z ∈ [0, 400] (2×2 chunks). */
const terrain = (): TerrainGrid => {
  const n = 401;
  const heights = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = 0.05 * c + 0.02 * r;
  return { x0: 0, z0: 0, cols: n, rows: n, datum: 40, heights };
};
const noStreets = (): StreetMeshes => ({ road: empty(), sidewalk: empty(), curb: empty(), trackbed: empty(), tram: empty(), green: empty(), squares: empty() });

test('terrain creates ground-only chunks', () => {
  const chunks = buildChunks([], noStreets(), {}, { minX: 0, minZ: 0, maxX: 400, maxZ: 400 }, terrain());
  expect(chunks.map((c) => c.key)).toEqual(['0_0', '1_0', '0_1', '1_1']);
  for (const c of chunks) {
    expect(c.ground!.positions.length / 3).toBe(201 * 201);
    expect(c.buildings).toBeUndefined();
    expect(c.streets).toEqual({});
  }
  // existing chunks get ground too; no terrain → no ground
  expect(buildChunks(buildings(), streets(), {}, { minX: 0, minZ: 0, maxX: 400, maxZ: 400 }, terrain()).find((c) => c.key === '0_0')!.ground).toBeDefined();
  expect(buildChunks(buildings(), streets()).every((c) => c.ground === undefined)).toBe(true);
});

test('glb carries ground with normals', async () => {
  const chunk = buildChunks([], noStreets(), {}, { minX: 0, minZ: 0, maxX: 200, maxZ: 200 }, terrain())[0]!;
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.readBinary(await encodeChunkGlb(chunk));
  const meshes = doc.getRoot().listMeshes();
  expect(meshes.map((m) => m.getName())).toEqual(['ground']);
  const prim = meshes[0]!.listPrimitives()[0]!;
  expect(prim.listSemantics().sort()).toEqual(['NORMAL', 'POSITION', 'TEXCOORD_0']);
  expect(Array.from(prim.getAttribute('NORMAL')!.getArray()!)).toEqual(Array.from(chunk.ground!.normals));
  expect(Array.from(prim.getAttribute('POSITION')!.getArray()!)).toEqual(Array.from(chunk.ground!.positions));
  expect(Array.from(prim.getIndices()!.getArray()!)).toEqual(Array.from(chunk.ground!.indices));
});

test('collision without ground rectangle when terrain is given', () => {
  const col = buildCollision({ buildings: buildings(), curb: streets().curb, sidewalk: empty(), boundary, terrain: terrain() });
  const all = Array.from({ length: col.vertices.length / 3 }, (_, i) => [col.vertices[i * 3]!, col.vertices[i * 3 + 1]!, col.vertices[i * 3 + 2]!]);
  expect(all).not.toContainEqual([-200, 0, -200]);
  expect(all).not.toContainEqual([500, 0, 500]);
  expect(col.indices.length).toBe((30 + 2) * 3); // 3 boxes × 10 + 2 kerb
});

test('plinths do not change the client eave heights of a merged building batch', () => {
  const gml = readFileSync(new URL('../fixtures/gable-house.gml', import.meta.url), 'utf8');
  const b = parseCityGml(gml)[0]!;
  const eaves = (m: BuildingMesh) => {
    const [chunk] = buildChunks([m], streets()).filter((c) => c.buildings);
    const batch = chunk!.buildings!;
    const e = wallEaves(batch.indices, batch.kind, batch.facadeUv, batch.positions.length / 3);
    return [...new Set([...e].filter((_, i) => batch.kind[i] === 0))].sort((p, q) => p - q);
  };
  const flat = eaves(buildBuildingMesh(b)!);
  // terrain falling 1.5 m across the house: plinths reach 1.8 m below the base
  const pts = [[356000, 5647000], [356010, 5647008]].map(([e, n]) => utmToLocal(e!, n!));
  const x0 = Math.floor(Math.min(pts[0]!.x, pts[1]!.x)) - 3, z0 = Math.floor(Math.min(pts[0]!.z, pts[1]!.z)) - 3;
  const cols = 20, rows = 20, heights = new Float32Array(cols * rows);
  const xa = Math.min(pts[0]!.x, pts[1]!.x), xb = Math.max(pts[0]!.x, pts[1]!.x);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = 5 - (1.5 * (x0 + c - xa)) / (xb - xa);
  const plinthed = buildBuildingMesh(b, { datum: 35, terrain: { x0, z0, cols, rows, datum: 35, heights } })!;
  expect(Math.min(...plinthed.facadeUv.filter((_, i) => i % 2 === 1))).toBeLessThan(-1);
  expect(eaves(plinthed)).toEqual(flat);
  expect(flat).not.toContain(0);
});
