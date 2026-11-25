import { chunkKey, type TerrainGrid } from '@nn/shared';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { endianness } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';
import { footprintOf, type Footprint } from './footprint.js';
import type { Pt } from './osm.js';
import { classifyBuildings, wallsOf, type Wall } from './placements.js';
import { contentHash } from './worldindex.js';

/** What every step except chunk batches and collision needs of a building. */
export type BuildingRecord = Pick<BuildingMesh, 'id' | 'centroid' | 'base' | 'buildingSeed' | 'flags'> & {
  footprint: Footprint; // roof triangles in xz + bbox, as footprintOf(mesh) gives
  /** The vertical wall planes shopSign chooses from (a few per building, see wallsOf). */
  walls: Wall[];
  tile: number; // index into the tiles the store was built from (LOD2_TILES)
};

/** The light record of a full mesh (from tile `tile`). */
export function recordOf(m: BuildingMesh, tile: number): BuildingRecord {
  return { id: m.id, centroid: m.centroid, base: m.base, buildingSeed: m.buildingSeed, flags: m.flags, footprint: footprintOf(m), walls: wallsOf(m), tile };
}

/** Bump when the cache file layout changes. */
const FORMAT = 2;
const MAGIC = 0x4342_4e4e; // 'NNBC' little-endian
/**
 * The code the meshes are built by: every non-test .ts file of the pipeline and of @nn/shared (a hand-kept list
 * misses helpers such as polyline.ts). Any edit there rebuilds the cache once: the safe direction.
 */
const CODE_ROOTS = [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../shared/src/', import.meta.url))];
const PACKAGE_LOCK = new URL('../../../package-lock.json', import.meta.url);

const sha = (...parts: (string | Uint8Array)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p).update('\0');
  return h.digest('hex').slice(0, 32);
};
const f64bytes = (v: number[]) => new Uint8Array(Float64Array.from(v).buffer);

/** Hash over the non-test .ts files under `roots` (not *.test.ts, *.test-util.ts): root index, relative path and content, sorted by path. */
export async function codeHash(roots: string[]): Promise<string> {
  const parts: (string | Uint8Array)[] = [];
  for (const [i, root] of roots.entries()) {
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !/\.test(-util)?\.ts$/.test(e.name))
      .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
      .filter((path) => !path.split('/').includes('node_modules'))
      .sort();
    for (const path of files) parts.push(`${i}:${path}`, await readFile(join(root, path)));
  }
  return sha(...parts);
}

/** The key of everything a tile's meshes depend on besides the tile itself (and the tiles before it). */
async function baseKey(terrain: TerrainGrid, datum: number, boundary: Pt[]): Promise<string> {
  const t = terrain.heights;
  return sha(`format ${FORMAT} ${endianness()} node ${process.version}`, await codeHash(CODE_ROOTS), await readFile(PACKAGE_LOCK),
    f64bytes([terrain.x0, terrain.z0, terrain.cols, terrain.rows, terrain.datum, datum]), new Uint8Array(t.buffer, t.byteOffset, t.byteLength),
    f64bytes(boundary.flatMap((p) => [p.x, p.z])));
}

type TileFile = {
  key: string;
  /** Buildings parsed in this tile with a mesh (before classifyBuildings), for the log. */
  parsed: number;
  /** Ids first seen in this tile (kept or not): later tiles skip them. */
  seen: string[];
  /** The kept meshes, in document order. */
  meshes: BuildingMesh[];
};

const pad = (n: number, to: number) => Math.ceil(n / to) * to;

/**
 * One tile's cache file: a JSON header (key, counts, ids, the hash of the body), padded to 8 bytes, then the body:
 * centroids and bases (f64), seeds and flags (u32), then per mesh its typed arrays bit for bit (8-byte aligned).
 */
export function encodeTileFile(f: TileFile): Uint8Array {
  const n = f.meshes.length;
  let size = n * 3 * 8 + pad(n * 2 * 4, 8);
  for (const m of f.meshes) size += pad(m.kind.length * 8 * 4 + m.kind.length, 8);
  const body = new Uint8Array(size);
  const f64 = new Float64Array(body.buffer, 0, n * 3), u32 = new Uint32Array(body.buffer, n * 24, n * 2);
  f.meshes.forEach((m, i) => {
    f64.set([m.centroid.x, m.centroid.z, m.base], i * 3);
    u32.set([m.buildingSeed, m.flags], i * 2);
  });
  let at = n * 24 + pad(n * 8, 8);
  for (const m of f.meshes) {
    for (const a of [m.positions, m.normals, m.facadeUv, m.kind]) {
      body.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
      at += a.byteLength;
    }
    at = pad(at, 8);
  }
  const header = Buffer.from(JSON.stringify({ key: f.key, body: sha(body), parsed: f.parsed, seen: f.seen, ids: f.meshes.map((m) => m.id), vertices: f.meshes.map((m) => m.kind.length) }), 'utf8');
  const start = pad(12 + header.byteLength, 8);
  const out = new Uint8Array(start + body.byteLength), view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, header.byteLength, true);
  out.set(header, 12);
  out.set(body, start);
  return out;
}

/**
 * Reads a tile's cache file, checking format, length and the body hash (throws if any is off); the meshes'
 * arrays are views into `data` (copied first if it is not 8-byte aligned).
 */
export function decodeTileFile(data: Uint8Array): TileFile {
  if (data.byteOffset % 8) data = data.slice();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 12 || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) throw new Error('not a building cache file of this format');
  const len = view.getUint32(8, true);
  const h = JSON.parse(Buffer.from(data.buffer, data.byteOffset + 12, len).toString('utf8')) as { key: string; body: string; parsed: number; seen: string[]; ids: string[]; vertices: number[] };
  const n = h.ids.length, start = pad(12 + len, 8), base = data.byteOffset + start;
  let at = n * 24 + pad(n * 8, 8);
  for (const v of h.vertices) at = pad(at + v * 33, 8);
  if (start + at !== data.byteLength) throw new Error('building cache file has the wrong length');
  if (sha(data.subarray(start)) !== h.body) throw new Error('building cache file body does not match its hash');
  const f64 = new Float64Array(data.buffer, base, n * 3), u32 = new Uint32Array(data.buffer, base + n * 24, n * 2);
  at = n * 24 + pad(n * 8, 8);
  const meshes = h.ids.map((id, i): BuildingMesh => {
    const v = h.vertices[i]!;
    const positions = new Float32Array(data.buffer, base + at, v * 3);
    const normals = new Float32Array(data.buffer, base + at + v * 12, v * 3);
    const facadeUv = new Float32Array(data.buffer, base + at + v * 24, v * 2);
    const kind = new Uint8Array(data.buffer, base + at + v * 32, v);
    at = pad(at + v * 33, 8);
    return { id, centroid: { x: f64[i * 3]!, z: f64[i * 3 + 1]! }, positions, normals, facadeUv, kind, base: f64[i * 3 + 2]!, buildingSeed: u32[i * 2]!, flags: u32[i * 2 + 1]! };
  });
  return { key: h.key, parsed: h.parsed, seen: h.seen, meshes };
}

/** The tiles' meshes in memory: at most `maxTiles` tiles, least recently used dropped first. Shared by a store and its views. */
class TileCache {
  private held = new Map<number, Promise<BuildingMesh[]>>();
  /** Tiles read into the held ones so far. */
  loads = 0;
  constructor(private files: string[], private keys: string[], private maxTiles: number) {}

  get size(): number {
    return this.held.size;
  }

  /** The tile's meshes from its cache file, checked against the key the store was built with. */
  async read(tile: number): Promise<BuildingMesh[]> {
    const changed = `building cache ${this.files[tile]} changed since the store was built (another run?)`;
    let f: TileFile;
    try {
      f = decodeTileFile(await readFile(this.files[tile]!));
    } catch (cause) {
      throw new Error(changed, { cause });
    }
    if (f.key !== this.keys[tile]) throw new Error(changed, { cause: new Error(`key ${f.key}, expected ${this.keys[tile]}`) });
    return f.meshes;
  }

  get(tile: number): Promise<BuildingMesh[]> {
    let p = this.held.get(tile);
    if (p) this.held.delete(tile); // (re-inserted: most recently used)
    else {
      this.loads++;
      p = this.read(tile);
      p.catch(() => this.held.get(tile) === p && this.held.delete(tile));
    }
    this.held.set(tile, p);
    for (const t of this.held.keys()) if (this.held.size > this.maxTiles) this.held.delete(t);
    return p;
  }

  peek(tile: number): Promise<BuildingMesh[]> | undefined {
    return this.held.get(tile);
  }

  clear(): void {
    this.held.clear();
  }
}

/**
 * The buildings of the LoD2 tiles as light records; the full meshes live in one cache file per tile
 * (`cacheDir`/<tile>.bin) and are loaded when a chunk or the collision step needs them.
 */
export class BuildingStore {
  private byChunk?: Map<string, number[]>;

  private constructor(readonly records: readonly BuildingRecord[], private slots: readonly number[], private cache: TileCache) {}

  /**
   * Parses the tiles in order, keeps records, writes each tile's full meshes to `cacheDir`. Same order and
   * de-duplication as one loop over all tiles: a building on a tile border is in both tiles, the first one keeps it.
   * A tile whose cache file matches its key (raw tile, the tiles before it, terrain, datum, boundary, code) is read
   * from there instead of being parsed.
   */
  static async build(o: { tiles: string[]; rawDir: string; cacheDir: string; datum: number; terrain: TerrainGrid; boundary: Pt[]; maxTiles?: number; log?: (line: string) => void }): Promise<BuildingStore> {
    await mkdir(o.cacheDir, { recursive: true });
    const base = await baseKey(o.terrain, o.datum, o.boundary);
    const seen = new Set<string>();
    const records: BuildingRecord[] = [], slots: number[] = [], keys: string[] = [], files: string[] = [];
    let prev = base;
    for (const [tile, name] of o.tiles.entries()) {
      const raw = await readFile(join(o.rawDir, name));
      const key = (prev = sha(prev, name, contentHash(raw)));
      const file = join(o.cacheDir, `${name}.bin`);
      keys.push(key);
      files.push(file);
      let cached: TileFile | undefined;
      try {
        cached = decodeTileFile(await readFile(file));
      } catch { /* none yet, or unreadable: rebuilt */ }
      if (cached?.key !== key) cached = undefined; // stale: let go of it before parsing
      let f: TileFile;
      if (cached) f = cached;
      else {
        const meshes: BuildingMesh[] = [], fresh: string[] = [];
        for (const parsed of parseCityGml(raw.toString('utf8'))) {
          // the parsed id is a slice of the tile's XML text: kept in `seen` and the records, it would keep all of
          // that text alive (~2 GB over all tiles); a copy of its own does not
          const b = { ...parsed, id: Buffer.from(parsed.id, 'utf8').toString('utf8') };
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          fresh.push(b.id);
          const m = buildBuildingMesh(b, { datum: o.datum, terrain: o.terrain });
          if (m) meshes.push(m);
        }
        f = { key, parsed: meshes.length, seen: fresh, meshes: classifyBuildings(meshes, o.boundary) };
        // (a name of its own: two runs may write the same tile at once; the rename is atomic)
        const part = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
        await writeFile(part, encodeTileFile(f));
        await rename(part, file);
      }
      for (const id of f.seen) seen.add(id);
      f.meshes.forEach((m, slot) => {
        records.push(recordOf(m, tile));
        slots.push(slot);
      });
      o.log?.(`${name}: ${f.parsed} meshes, ${f.meshes.length} kept${f === cached ? ' (cached)' : ''}`);
    }
    return new BuildingStore(records, slots, new TileCache(files, keys, o.maxTiles ?? 4));
  }

  /** How many tiles' meshes are held right now. */
  get heldTiles(): number {
    return this.cache.size;
  }

  /** How many times mesh() has read a tile's meshes from the cache (a measure of how well maxTiles fits the access order). */
  get tileLoads(): number {
    return this.cache.loads;
  }

  /** Lets go of the held tiles (mesh() reads them again when asked). */
  release(): void {
    this.cache.clear();
  }

  /** Full mesh of record i; meshes of at most `maxTiles` tiles are held at once (default 4). */
  async mesh(i: number): Promise<BuildingMesh> {
    const r = this.records[i];
    if (!r) throw new Error(`BuildingStore: no record ${i}`);
    return (await this.cache.get(r.tile))[this.slots[i]!]!;
  }

  /** All full meshes in record order, one tile at a time (tiles are not added to the held ones). */
  async *meshes(): AsyncGenerator<BuildingMesh> {
    let tile = -1, meshes: BuildingMesh[] = [];
    for (const [i, r] of this.records.entries()) {
      if (r.tile !== tile) {
        tile = r.tile;
        meshes = [];
        meshes = await (this.cache.peek(tile) ?? this.cache.read(tile));
      }
      yield meshes[this.slots[i]!]!;
    }
  }

  /** Records (with index) whose centroid lies in chunk `key`, in global order. */
  inChunk(key: string): readonly number[] {
    if (!this.byChunk) {
      this.byChunk = new Map();
      this.records.forEach((r, i) => {
        const k = chunkKey(r.centroid.x, r.centroid.z);
        const list = this.byChunk!.get(k);
        if (list) list.push(i);
        else this.byChunk!.set(k, [i]);
      });
    }
    return this.byChunk.get(key) ?? [];
  }

  /** The same store without the records `drop` picks (indices renumbered; meshes and held tiles shared). */
  without(drop: (r: BuildingRecord) => boolean): BuildingStore {
    const keep = this.records.flatMap((r, i) => (drop(r) ? [] : [i]));
    return new BuildingStore(keep.map((i) => this.records[i]!), keep.map((i) => this.slots[i]!), this.cache);
  }
}
