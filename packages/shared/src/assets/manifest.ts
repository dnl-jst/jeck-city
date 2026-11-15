import { BIKE_TYPES } from '../physics/biketypes';

/**
 * World manifest (apps/client/public/world/manifest.json), written by the pipeline.
 *
 * Chunks: the world is split into CHUNK_SIZE × CHUNK_SIZE m squares, chunk (ix, iz) covering
 * x ∈ [ix·200, ix·200+200), z ∈ [iz·200, iz·200+200). Buildings go to the chunk of their centroid,
 * street triangles to the chunk of the triangle centroid, so geometry may stick out of its square.
 * Chunk `x`/`z` are that square's world-space min corner. Vertex positions inside chunk_*.glb are in
 * WORLD space (no per-chunk offset, node transform is identity): coordinates stay below ~3 km, where
 * float32 is still sub-millimetre, and client and collision share one frame without bookkeeping.
 *
 * chunk_{ix}_{iz}.glb layout: up to 11 meshes named ground, buildings, road, sidewalk, curb, trackbed,
 * tram, green, squares, markings, parking (empty ones omitted), EXT_meshopt_compression. `buildings` carries
 * POSITION, NORMAL, _FACADEUV (vec2), _KIND (0 wall / 1 roof), _SEED (buildingSeed / 2^32), _FLAGS (bit 0
 * Neusser Str., bit 1 backdrop), all float; the scene's extras.buildings lists { id, firstVertex, vertexCount }
 * per building (contiguous vertex ranges of the buildings mesh). Street meshes (trackbed = track bed
 * built from the tram rails) carry POSITION and TEXCOORD_0 (metres); `markings` also _MARK (float, 0 white /
 * 1 red cycle crossing), `parking` has uv.y = metres from the kerb. `ground` is the terrain surface of
 * the chunk square (grid points on [x, x+200] × [z, z+200], edges shared with the neighbours, cells split
 * along TERRAIN_DIAGONAL) with POSITION, NORMAL and TEXCOORD_0 (world x/z in metres); every chunk square of
 * the world area has a chunk once terrain is present, also without buildings or streets.
 */
export const CHUNK_SIZE = 200;
const BIKE_TYPE_COUNT = BIKE_TYPES.length;

/**
 * Height of a shop sign's board centre above its building's LoD2 base (m): the middle of the shopfront sign band of
 * the facade shader (client materials/storeys.ts SHOP: 3.6–4.35 m). Manifest sign.y = base + SIGN_Y.
 */
export const SIGN_Y = 3.975;

export type WorldManifest = {
  version: 2;
  origin: { e: number; n: number };
  chunkSize: 200;
  chunks: { key: string; x: number; z: number; file: string; bytes: number }[];
  /** Spawn point; y = terrain height at the spawn + sidewalk height. */
  spawn: { x: number; y: number; z: number; heading: number };
  boundary: [number, number][];
  lamps: [number, number][];
  trees: [number, number][];
  /**
   * Tram stop shelters: x/z = shelter centre (3.5 m beside the track); heading = track direction at the stop
   * (forward = (sin h, cos h)), oriented so the track lies to the left of it.
   */
  tramStops: { name: string; x: number; z: number; heading: number }[];
  /**
   * Shops: label = invented name shown on the sign; sign = board centre in front of the street-facing wall of
   * the building, y = board centre height (LoD2 base of the building + SIGN_Y), heading = outward wall normal
   * (the side it is read from), width in m.
   */
  shops: { x: number; z: number; label: string; type: string; buildingId?: string; sign?: { x: number; y: number; z: number; heading: number; width: number } }[];
  parked: { x: number; z: number; heading: number; color: number }[];
  /**
   * Hand-made replacement models (data/building-overrides.json): `file` is a glTF binary in world space,
   * loaded and unloaded together with chunk `chunk` (the chunk of the replaced building's centroid).
   * Several buildings may share one model; `id` is the first of them.
   */
  models: { id: string; chunk: string; file: string; bytes: number }[];
  /**
   * Bike rack hoops (one entry per hoop): kind 0 = stand (inverted U), 1 = wall loop / bollard; heading = the
   * direction bikes stand in at the hoop (forward = (sin h, cos h)). Missing in older manifests → [].
   */
  bikeRacks: { x: number; z: number; heading: number; kind: 0 | 1 }[];
  /**
   * Rideable bikes: type = index in BIKE_TYPES (0 dutch, 1 road, 2 mtb, 3 longjohn, 4 trike), color = frame colour;
   * bikes[0] is the cargo bike at the spawn. Missing in older manifests → [].
   */
  bikes: { x: number; z: number; heading: number; type: number; color: number }[];
  /** Terrain height grid (see assets/terrain.ts encodeTerrain). */
  terrain: { file: 'terrain.bin'; bytes: number };
  /** NHN height (m) of local y = 0: world y = NHN − datum. */
  datum: number;
  /** Height for the flat ground beyond the terrain grid: lowest grid-border height − 0.5 m. */
  farGroundY: number;
  attribution: string;
};

/** Chunk key 'ix_iz' of the chunk containing world point (x, z). */
export const chunkKey = (x: number, z: number): string => `${Math.floor(x / CHUNK_SIZE)}_${Math.floor(z / CHUNK_SIZE)}`;

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
  throw new Error(`manifest: ${path} ${what}`);
}
function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Obj;
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be a string');
  return v;
}
function arr<T>(v: unknown, path: string, item: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v)) fail(path, 'must be an array');
  return v.map((x, i) => item(x, `${path}[${i}]`));
}
const pair = (v: unknown, p: string): [number, number] => {
  const a = arr(v, p, num);
  if (a.length !== 2) fail(p, 'must be [x, z]');
  return [a[0]!, a[1]!];
};
/** Reads the listed numeric fields of an object. */
function nums<K extends string>(v: unknown, p: string, keys: K[]): Record<K, number> {
  const o = obj(v, p);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(o[k], `${p}.${k}`);
  return out;
}

/** Validates parsed JSON against the manifest schema; throws on any mismatch. */
export function parseManifest(json: unknown): WorldManifest {
  const o = obj(json, 'manifest');
  if (o.version !== 2) fail('version', 'must be 2');
  if (o.chunkSize !== CHUNK_SIZE) fail('chunkSize', `must be ${CHUNK_SIZE}`);
  const t = obj(o.terrain, 'terrain');
  if (t.file !== 'terrain.bin') fail('terrain.file', "must be 'terrain.bin'");
  return {
    version: 2,
    origin: nums(o.origin, 'origin', ['e', 'n']),
    chunkSize: CHUNK_SIZE,
    chunks: arr(o.chunks, 'chunks', (v, p) => {
      const c = obj(v, p);
      return { key: str(c.key, `${p}.key`), ...nums(c, p, ['x', 'z']), file: str(c.file, `${p}.file`), bytes: num(c.bytes, `${p}.bytes`) };
    }),
    spawn: nums(o.spawn, 'spawn', ['x', 'y', 'z', 'heading']),
    boundary: arr(o.boundary, 'boundary', pair),
    lamps: arr(o.lamps, 'lamps', pair),
    trees: arr(o.trees, 'trees', pair),
    tramStops: arr(o.tramStops, 'tramStops', (v, p) => ({ name: str(obj(v, p).name, `${p}.name`), ...nums(v, p, ['x', 'z', 'heading']) })),
    shops: arr(o.shops, 'shops', (v, p) => {
      const s = obj(v, p);
      const shop: WorldManifest['shops'][number] = { ...nums(s, p, ['x', 'z']), label: str(s.label, `${p}.label`), type: str(s.type, `${p}.type`) };
      if (s.buildingId !== undefined) shop.buildingId = str(s.buildingId, `${p}.buildingId`);
      if (s.sign !== undefined) shop.sign = nums(s.sign, `${p}.sign`, ['x', 'y', 'z', 'heading', 'width']);
      return shop;
    }),
    parked: arr(o.parked, 'parked', (v, p) => nums(v, p, ['x', 'z', 'heading', 'color'])),
    models: o.models === undefined ? [] : arr(o.models, 'models', (v, p) => {
      const x = obj(v, p);
      return { id: str(x.id, `${p}.id`), chunk: str(x.chunk, `${p}.chunk`), file: str(x.file, `${p}.file`), bytes: num(x.bytes, `${p}.bytes`) };
    }),
    bikeRacks: o.bikeRacks === undefined ? [] : arr(o.bikeRacks, 'bikeRacks', (v, p) => {
      const r = nums(v, p, ['x', 'z', 'heading', 'kind']);
      if (r.kind !== 0 && r.kind !== 1) fail(`${p}.kind`, 'must be 0 or 1');
      return { ...r, kind: r.kind };
    }),
    bikes: o.bikes === undefined ? [] : arr(o.bikes, 'bikes', (v, p) => {
      const b = nums(v, p, ['x', 'z', 'heading', 'type', 'color']);
      if (!Number.isInteger(b.type) || b.type < 0 || b.type >= BIKE_TYPE_COUNT) fail(`${p}.type`, `must be an integer 0..${BIKE_TYPE_COUNT - 1}`);
      return b;
    }),
    terrain: { file: 'terrain.bin', bytes: num(t.bytes, 'terrain.bytes') },
    datum: num(o.datum, 'datum'),
    farGroundY: num(o.farGroundY, 'farGroundY'),
    attribution: str(o.attribution, 'attribution'),
  };
}
