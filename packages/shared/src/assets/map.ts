/**
 * Map data (apps/client/public/world/map.json), written by the pipeline and loaded separately from the manifest.
 * Local coordinates in metres: x east, z south. All point lists are flat [x0, z0, x1, z1, …].
 */
export type MapRoad = { kind: string; name?: string; width: number; pts: number[] };
export type MapData = {
  version: 1;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  boundary: number[];
  roads: MapRoad[];
  /** Per building a flat triangle list [x0,z0,x1,z1,x2,z2, …] (roof triangles in xz). */
  buildings: number[][];
  greens: number[][];
  /** name '' = unnamed. */
  squares: { name: string; pts: number[] }[];
  tram: number[][];
  tramStops: { name: string; x: number; z: number }[];
};

type Obj = Record<string, unknown>;

function fail(path: string, what: string): never {
  throw new Error(`map: ${path} ${what}`);
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
/** Flat number list whose length is a multiple of `step` (2 = x/z pairs, 6 = triangles). */
function flat(v: unknown, path: string, step = 2): number[] {
  const a = arr(v, path, num);
  if (a.length % step !== 0) fail(path, `length must be a multiple of ${step}`);
  return a;
}
function nums<K extends string>(v: unknown, p: string, keys: K[]): Record<K, number> {
  const o = obj(v, p);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(o[k], `${p}.${k}`);
  return out;
}

/** Validates parsed JSON against the map schema; throws on any mismatch. */
export function parseMapData(json: unknown): MapData {
  const o = obj(json, 'map');
  if (o.version !== 1) fail('version', 'must be 1');
  return {
    version: 1,
    bounds: nums(o.bounds, 'bounds', ['minX', 'minZ', 'maxX', 'maxZ']),
    boundary: flat(o.boundary, 'boundary'),
    roads: arr(o.roads, 'roads', (v, p) => {
      const r = obj(v, p);
      const road: MapRoad = { kind: str(r.kind, `${p}.kind`), width: num(r.width, `${p}.width`), pts: flat(r.pts, `${p}.pts`) };
      if (r.name !== undefined) road.name = str(r.name, `${p}.name`);
      return road;
    }),
    buildings: arr(o.buildings, 'buildings', (v, p) => flat(v, p, 6)),
    greens: arr(o.greens, 'greens', (v, p) => flat(v, p)),
    squares: arr(o.squares, 'squares', (v, p) => {
      const s = obj(v, p);
      return { name: str(s.name, `${p}.name`), pts: flat(s.pts, `${p}.pts`) };
    }),
    tram: arr(o.tram, 'tram', (v, p) => flat(v, p)),
    tramStops: arr(o.tramStops, 'tramStops', (v, p) => ({ name: str(obj(v, p).name, `${p}.name`), ...nums(v, p, ['x', 'z']) })),
  };
}
