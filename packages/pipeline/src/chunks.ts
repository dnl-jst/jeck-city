import { Document, NodeIO, type TypedArray } from '@gltf-transform/core';
import { concatMeshes } from './bridges.js';
import { drapeChunk, type FlatSource } from './chunkdrape.js';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { CHUNK_SIZE, chunkKey, type CollisionAsset, type TerrainGrid } from '@nn/shared';
import { MeshoptEncoder } from 'meshoptimizer';
import type { BuildingMesh } from './buildings.js';
import { chunkWindow, groundMesh, groundSpan, type GroundMesh } from './ground.js';
import type { Pt } from './osm.js';
import type { Mesh } from './streets.js';
import { TerrainFile } from './terrain/file.js';
import { type Heights, TerrainSampler } from './terrain/height.js';

export const STREET_MESHES = ['road', 'sidewalk', 'curb', 'trackbed', 'tram', 'green', 'squares', 'markings', 'parking', 'water', 'bridge', 'steel'] as const;
export type StreetName = (typeof STREET_MESHES)[number];
export type StreetMeshes = Record<StreetName, Mesh>;
/**
 * data/building-overrides.json: building id → replacement GLB path (see data/models/README.md). Listed
 * buildings are left out of the chunks and collision; the pipeline ships the GLB as a model_*.glb instead.
 */
export type Overrides = Record<string, string>;

export const FLAG_BACKDROP = 2;

/** All buildings of one chunk, indexed; every attribute is per vertex and float. */
export type BuildingBatch = {
  positions: Float32Array;
  normals: Float32Array;
  facadeUv: Float32Array;
  kind: Float32Array;
  seed: Float32Array; // buildingSeed / 2^32
  flags: Float32Array;
  indices: Uint32Array;
  ranges: { id: string; firstVertex: number; vertexCount: number }[];
};
export type ChunkGeometry = { key: string; ix: number; iz: number; buildings?: BuildingBatch; streets: Partial<Record<StreetName, Mesh>>; ground?: GroundMesh };

/** Where the chunks get their buildings (a BuildingStore): light records for the keys, full meshes per chunk. */
export type BuildingSource = {
  readonly records: readonly { id: string; centroid: Pt }[];
  /** Indices of the records whose centroid lies in chunk `key`, in record order. */
  inChunk(key: string): readonly number[];
  mesh(i: number): Promise<BuildingMesh>;
};

/** A BuildingSource over meshes already in memory. */
export function meshSource(meshes: BuildingMesh[]): BuildingSource {
  const byChunk = new Map<string, number[]>();
  meshes.forEach((m, i) => {
    const key = chunkKey(m.centroid.x, m.centroid.z);
    const list = byChunk.get(key);
    if (list) list.push(i);
    else byChunk.set(key, [i]);
  });
  return { records: meshes, inChunk: (key) => byChunk.get(key) ?? [], mesh: async (i) => meshes[i]! };
}

class BatchBuilder {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; kind: number[] = []; seed: number[] = []; flags: number[] = [];
  idx: number[] = [];
  ranges: BuildingBatch['ranges'] = [];

  /** Appends one building, merging vertices that are identical in all attributes (within the building only). */
  add(b: BuildingMesh): void {
    const first = this.pos.length / 3;
    const seen = new Map<string, number>();
    const seed = b.buildingSeed / 2 ** 32;
    for (let v = 0; v < b.kind.length; v++) {
      const p = b.positions, n = b.normals, u = b.facadeUv;
      const key = `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]},${n[v * 3]},${n[v * 3 + 1]},${n[v * 3 + 2]},${u[v * 2]},${u[v * 2 + 1]},${b.kind[v]}`;
      let i = seen.get(key);
      if (i === undefined) {
        i = this.pos.length / 3;
        seen.set(key, i);
        this.pos.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
        this.nor.push(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!);
        this.uv.push(u[v * 2]!, u[v * 2 + 1]!);
        this.kind.push(b.kind[v]!);
        this.seed.push(seed);
        this.flags.push(b.flags);
      }
      this.idx.push(i);
    }
    this.ranges.push({ id: b.id, firstVertex: first, vertexCount: this.pos.length / 3 - first });
  }

  build(): BuildingBatch {
    const f = (a: number[]) => Float32Array.from(a);
    return {
      positions: f(this.pos), normals: f(this.nor), facadeUv: f(this.uv), kind: f(this.kind), seed: f(this.seed), flags: f(this.flags),
      indices: Uint32Array.from(this.idx), ranges: this.ranges,
    };
  }
}

export type Rect = { minX: number; minZ: number; maxX: number; maxZ: number };
export const GROUND_MARGIN = 200;

/** The world area: boundary bbox + 200 m (collision ground; street triangles outside are dropped). */
export function worldRect(boundary: Pt[]): Rect {
  const xs = boundary.map((p) => p.x), zs = boundary.map((p) => p.z);
  return {
    minX: Math.min(...xs) - GROUND_MARGIN, maxX: Math.max(...xs) + GROUND_MARGIN,
    minZ: Math.min(...zs) - GROUND_MARGIN, maxZ: Math.max(...zs) + GROUND_MARGIN,
  };
}
const inRect = (r: Rect | undefined, x: number, z: number) => !r || (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);

/** Copies the triangles of `m` whose centroid lies in each chunk (and in `area`) into per-chunk meshes (vertices remapped). */
export function splitMesh(m: Mesh, area?: Rect): Map<string, Mesh> {
  const parts = new Map<string, { remap: Map<number, number>; pos: number[]; uv: number[]; mark: number[]; idx: number[] }>();
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const cx = (p[a * 3]! + p[b * 3]! + p[c * 3]!) / 3, cz = (p[a * 3 + 2]! + p[b * 3 + 2]! + p[c * 3 + 2]!) / 3;
    if (!inRect(area, cx, cz)) continue;
    const key = chunkKey(cx, cz);
    let part = parts.get(key);
    if (!part) parts.set(key, (part = { remap: new Map(), pos: [], uv: [], mark: [], idx: [] }));
    for (const v of [a, b, c]) {
      let i = part.remap.get(v);
      if (i === undefined) {
        i = part.pos.length / 3;
        part.remap.set(v, i);
        part.pos.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
        part.uv.push(m.uv[v * 2]!, m.uv[v * 2 + 1]!);
        if (m.mark) part.mark.push(m.mark[v]!);
      }
      part.idx.push(i);
    }
  }
  const out = new Map<string, Mesh>();
  for (const [k, q] of parts) {
    const mesh: Mesh = { positions: Float32Array.from(q.pos), indices: Uint32Array.from(q.idx), uv: Float32Array.from(q.uv) };
    if (m.mark) mesh.mark = Float32Array.from(q.mark);
    out.set(k, mesh);
  }
  return out;
}

/**
 * Buildings by centroid, street triangles by triangle centroid; positions stay in world space.
 * Street triangles outside `area` are dropped (OSM ways reach far beyond the play area).
 * With `terrain`, every chunk square that intersects `area` (the whole grid without `area`) and overlaps the
 * grid gets its `ground` mesh, also when it holds no buildings or streets.
 * Yields the chunks one at a time, sorted by (iz, ix): the set of keys is fixed up front, a chunk's building batch
 * (its full meshes loaded from `buildings` just then) and ground mesh are built when it is yielded, and nothing of a
 * yielded chunk is kept.
 * `terrain` may be the TerrainFile: each chunk then reads only its window (chunkWindow) for its ground, and drapes
 * through a sampler of the file with that window as its fast path.
 * `draped`: flat street meshes draped onto `terrain` chunk by chunk (drapeChunk; needs `terrain` and `area`) in place
 * of the same name in `streets`; the draped triangles per name are added up in `drapedTriangles`. A chunk that only
 * such a mesh might reach (its triangles' bounding boxes) is left out when no draped triangle falls into it.
 */
export async function* chunkGeometries(buildings: BuildingSource, streets: Partial<StreetMeshes>, overrides: Overrides = {}, area?: Rect,
  terrain?: TerrainGrid | TerrainFile, extra: Partial<StreetMeshes> = {}, draped: Partial<Record<StreetName, FlatSource>> = {},
  drapedTriangles: Partial<Record<StreetName, number>> = {}): AsyncGenerator<ChunkGeometry> {
  const sources = STREET_MESHES.map((name) => draped[name]);
  if (sources.some(Boolean) && (!terrain || !area)) throw new Error('chunkGeometries: draping needs terrain and area');
  const keys = new Set<string>();
  for (const b of buildings.records) {
    if (b.id in overrides) continue; // TODO: insert the replacement GLB from overrides[b.id] into this chunk
    keys.add(chunkKey(b.centroid.x, b.centroid.z));
  }
  const parts = (meshes: Partial<StreetMeshes>) => STREET_MESHES.map((name) => {
    const m = meshes[name];
    const split = m ? splitMesh(m, area) : new Map<string, Mesh>();
    for (const key of split.keys()) keys.add(key);
    return split;
  });
  const own = parts(streets);
  // further triangles per mesh name (the bridge decks), appended chunk by chunk: no copy of the big draped meshes
  const more = parts(extra);
  const grounded = new Set<string>();
  if (terrain) {
    const r = area ?? { minX: terrain.x0, minZ: terrain.z0, maxX: terrain.x0 + terrain.cols - 1, maxZ: terrain.z0 + terrain.rows - 1 };
    for (let iz = Math.floor(r.minZ / CHUNK_SIZE); iz < Math.ceil(r.maxZ / CHUNK_SIZE); iz++) {
      for (let ix = Math.floor(r.minX / CHUNK_SIZE); ix < Math.ceil(r.maxX / CHUNK_SIZE); ix++) {
        if (!groundSpan(terrain, ix, iz)) continue;
        keys.add(`${ix}_${iz}`);
        grounded.add(`${ix}_${iz}`);
      }
    }
  }
  // the chunks known to exist; draped meshes only add candidates
  const certain = new Set(keys);
  for (const src of sources) if (src) for (const key of src.trianglesByChunk.keys()) keys.add(key);
  const order = [...keys].map((key) => {
    const [ix, iz] = key.split('_').map(Number) as [number, number];
    return { key, ix, iz };
  }).sort((a, b) => a.iz - b.iz || a.ix - b.ix);
  for (const { key, ix, iz } of order) {
    const c: ChunkGeometry = { key, ix, iz, streets: {} };
    const list = buildings.inChunk(key).filter((i) => !(buildings.records[i]!.id in overrides));
    if (list.length) {
      const batch = new BatchBuilder();
      for (const i of list) batch.add(await buildings.mesh(i));
      c.buildings = batch.build();
    }
    // the heights of this chunk: from a file, its window (where the chunk has ground) as the fast path of a sampler
    const win = terrain instanceof TerrainFile && grounded.has(key) ? chunkWindow(terrain, ix, iz) : undefined;
    const heights: Heights | undefined = terrain instanceof TerrainFile ? new TerrainSampler(terrain, win) : terrain;
    STREET_MESHES.forEach((name, i) => {
      const src = sources[i];
      const have = src ? drapeChunk(src, heights!, ix, iz, area!) : own[i]!.get(key), deck = more[i]!.get(key);
      if (src && have) drapedTriangles[name] = (drapedTriangles[name] ?? 0) + have.indices.length / 3;
      own[i]!.delete(key);
      more[i]!.delete(key);
      if (have || deck) c.streets[name] = have && deck ? concatMeshes([have, deck]) : (have ?? deck)!;
    });
    if (!certain.has(key) && Object.keys(c.streets).length === 0) continue;
    if (terrain && grounded.has(key)) c.ground = groundMesh(win ?? (terrain as TerrainGrid), ix, iz)!;
    yield c;
  }
}

/** All chunks at once, from meshes in memory (see chunkGeometries). */
export async function buildChunks(buildings: BuildingMesh[], streets: StreetMeshes, overrides: Overrides = {}, area?: Rect, terrain?: TerrainGrid, extra: Partial<StreetMeshes> = {}): Promise<ChunkGeometry[]> {
  const out: ChunkGeometry[] = [];
  for await (const c of chunkGeometries(meshSource(buildings), streets, overrides, area, terrain, extra)) out.push(c);
  return out;
}

let encoderReady: Promise<void> | undefined;

/** chunk_*.glb bytes, layout as documented in @nn/shared manifest.ts; meshopt-compressed, not quantized (lossless). */
export async function encodeChunkGlb(c: ChunkGeometry): Promise<Uint8Array> {
  await (encoderReady ??= MeshoptEncoder.ready);
  const doc = new Document();
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const buffer = doc.createBuffer();
  const scene = doc.createScene(`chunk_${c.key}`);
  // all arrays here are ArrayBuffer-backed (never shared memory)
  const accessor = (type: 'SCALAR' | 'VEC2' | 'VEC3', array: Float32Array | Uint16Array | Uint32Array) =>
    doc.createAccessor().setType(type).setArray(array as TypedArray).setBuffer(buffer);
  const indices = (idx: Uint32Array, vertexCount: number) => accessor('SCALAR', vertexCount <= 0xffff ? Uint16Array.from(idx) : idx);
  const addMesh = (name: string, attrs: [string, 'SCALAR' | 'VEC2' | 'VEC3', Float32Array][], idx: Uint32Array) => {
    const prim = doc.createPrimitive().setIndices(indices(idx, attrs[0]![2].length / 3));
    for (const [sem, type, arr] of attrs) prim.setAttribute(sem, accessor(type, arr));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  };
  const b = c.buildings;
  if (b) {
    addMesh('buildings', [
      ['POSITION', 'VEC3', b.positions], ['NORMAL', 'VEC3', b.normals], ['_FACADEUV', 'VEC2', b.facadeUv],
      ['_KIND', 'SCALAR', b.kind], ['_SEED', 'SCALAR', b.seed], ['_FLAGS', 'SCALAR', b.flags],
    ], b.indices);
    scene.setExtras({ buildings: b.ranges });
  }
  const g = c.ground;
  if (g) addMesh('ground', [['POSITION', 'VEC3', g.positions], ['NORMAL', 'VEC3', g.normals], ['TEXCOORD_0', 'VEC2', g.uv]], g.indices);
  for (const name of STREET_MESHES) {
    const m = c.streets[name];
    if (!m || m.indices.length === 0) continue;
    const attrs: [string, 'SCALAR' | 'VEC2' | 'VEC3', Float32Array][] = [['POSITION', 'VEC3', m.positions], ['TEXCOORD_0', 'VEC2', m.uv]];
    if (m.mark) attrs.push(['_MARK', 'SCALAR', m.mark]);
    addMesh(name, attrs, m.indices);
  }
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  return io.writeBinary(doc);
}

/** One coordinate of two points that weld: `===` (-0 is 0), or both NaN. */
const same = (a: number, b: number) => a === b || (a !== a && b !== b);

/**
 * Welds exactly equal positions into one indexed triangle soup, numbered by first use. "Equal" is what the string key
 * `${x},${y},${z}` this replaces meant (millions of vertices: a Map of strings held ~0.5 GB): per coordinate `===`,
 * so -0 and 0 are one point, or both NaN. The first point of a welded set keeps its exact values (-0 stays -0).
 * Coordinates are compared as doubles (float32 output): doubles that round to the same float stay apart, as before.
 */
export class SoupBuilder {
  private xyz = new Float64Array(3 * 1024);
  private count = 0;
  /** Open addressing (linear probing), power-of-two size, at most half full: vertex index + 1, 0 = free. */
  private table = new Int32Array(2048);
  private idx = new Uint32Array(3 * 1024);
  private nIdx = 0;
  private bits = new Float64Array(3);
  private words = new Int32Array(this.bits.buffer);

  private hash(x: number, y: number, z: number): number {
    // -0 + 0 is 0 and every NaN one NaN: points that weld hash alike
    const b = this.bits, w = this.words;
    b[0] = x !== x ? NaN : x + 0;
    b[1] = y !== y ? NaN : y + 0;
    b[2] = z !== z ? NaN : z + 0;
    let h = 0x811c9dc5;
    for (let k = 0; k < 6; k++) h = Math.imul(h ^ w[k]!, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    return (h ^ (h >>> 12)) >>> 0;
  }

  private grow(): void {
    const table = new Int32Array(this.table.length * 2), mask = table.length - 1;
    const v = this.xyz;
    for (let i = 0; i < this.count; i++) {
      let s = this.hash(v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!) & mask;
      while (table[s] !== 0) s = (s + 1) & mask;
      table[s] = i + 1;
    }
    this.table = table;
  }

  vertex(x: number, y: number, z: number): number {
    const mask = this.table.length - 1, v = this.xyz;
    let s = this.hash(x, y, z) & mask;
    for (let e = this.table[s]!; e !== 0; s = (s + 1) & mask, e = this.table[s]!) {
      const i = e - 1;
      if (same(v[i * 3]!, x) && same(v[i * 3 + 1]!, y) && same(v[i * 3 + 2]!, z)) return i;
    }
    const i = this.count++;
    if (v.length < 3 * this.count) {
      this.xyz = new Float64Array(v.length * 2);
      this.xyz.set(v);
    }
    this.xyz[i * 3] = x;
    this.xyz[i * 3 + 1] = y;
    this.xyz[i * 3 + 2] = z;
    this.table[s] = i + 1;
    if (2 * this.count > this.table.length) this.grow();
    return i;
  }

  private push(a: number, b: number, c: number): void {
    if (this.idx.length < this.nIdx + 3) {
      const idx = new Uint32Array(this.idx.length * 2);
      idx.set(this.idx);
      this.idx = idx;
    }
    this.idx[this.nIdx++] = a;
    this.idx[this.nIdx++] = b;
    this.idx[this.nIdx++] = c;
  }

  /** The welded vertices (float32) and the triangles' indices. */
  build(): { vertices: Float32Array; indices: Uint32Array } {
    return { vertices: Float32Array.from(this.xyz.subarray(0, 3 * this.count)), indices: this.idx.slice(0, this.nIdx) };
  }

  /** Adds triangle (a, b, c) of positions p; zero-area triangles (also after welding) are dropped. */
  tri(p: ArrayLike<number>, a: number, b: number, c: number): void {
    const P = (i: number, k: number) => p[i * 3 + k]!;
    const ux = P(b, 0) - P(a, 0), uy = P(b, 1) - P(a, 1), uz = P(b, 2) - P(a, 2);
    const vx = P(c, 0) - P(a, 0), vy = P(c, 1) - P(a, 1), vz = P(c, 2) - P(a, 2);
    const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area2 < 1e-6) return;
    const ia = this.vertex(P(a, 0), P(a, 1), P(a, 2));
    const ib = this.vertex(P(b, 0), P(b, 1), P(b, 2));
    const ic = this.vertex(P(c, 0), P(c, 1), P(c, 2));
    if (ia !== ib && ib !== ic && ia !== ic) this.push(ia, ib, ic);
  }
}

/**
 * collision.bin content: building walls/roofs, kerbs and sidewalks (raised street surfaces at y = 0.12,
 * inside the world area) and, without `terrain`, one ground rectangle at y = 0 covering the boundary bbox + 200 m
 * (with `terrain` the physics heightfield collider is the ground instead).
 * Vertices are welded; zero-area triangles and overridden buildings are left out. `extra`: further world-space
 * triangle soups (9 floats per triangle), e.g. the collision meshes of override models; they come first, then the
 * buildings in `buildings` order (read one at a time: a BuildingStore's meshes()).
 * Not included: road, trackbed, tram, green and squares — they lie only centimetres above the ground, which covers them.
 */
export async function buildCollision(o: { buildings: Iterable<BuildingMesh> | AsyncIterable<BuildingMesh>; curb: Mesh; sidewalk: Mesh; boundary: Pt[]; overrides?: Overrides; dropBackdropRoofs?: boolean; extra?: Float32Array[]; terrain?: TerrainGrid | TerrainFile }): Promise<CollisionAsset> {
  const s = new SoupBuilder();
  for (const t of o.extra ?? []) for (let v = 0; v < t.length / 3; v += 3) s.tri(t, v, v + 1, v + 2);
  for await (const b of o.buildings) {
    if (o.overrides && b.id in o.overrides) continue;
    const skipRoofs = o.dropBackdropRoofs === true && (b.flags & FLAG_BACKDROP) !== 0;
    for (let v = 0; v < b.kind.length; v += 3) if (!(skipRoofs && b.kind[v] === 1)) s.tri(b.positions, v, v + 1, v + 2);
  }
  const area = worldRect(o.boundary);
  for (const c of [o.curb, o.sidewalk]) {
    for (let t = 0; t < c.indices.length; t += 3) {
      const [a, b, d] = [c.indices[t]!, c.indices[t + 1]!, c.indices[t + 2]!];
      const cx = (c.positions[a * 3]! + c.positions[b * 3]! + c.positions[d * 3]!) / 3;
      const cz = (c.positions[a * 3 + 2]! + c.positions[b * 3 + 2]! + c.positions[d * 3 + 2]!) / 3;
      if (inRect(area, cx, cz)) s.tri(c.positions, a, b, d);
    }
  }
  if (!o.terrain) {
    const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = area;
    const ground = [x0, 0, z0, x0, 0, z1, x1, 0, z1, x1, 0, z0].map(Math.fround);
    s.tri(ground, 0, 1, 2); // counter-clockwise seen from above (+y normal)
    s.tri(ground, 0, 2, 3);
  }
  return {
    ...s.build(),
    boundary: Float32Array.from(o.boundary.flatMap((p) => [p.x, p.z])),
  };
}
