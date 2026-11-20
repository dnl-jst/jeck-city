import type { BuildingMesh } from './buildings.js';
import { footprintContains, footprintOf } from './footprint.js';
import type { Pt } from './osm.js';

/**
 * What the transit builder asks about the city above the tunnels (where a stair may come up): the full pipeline
 * answers from its buildings and street meshes and stores the answers as a raster along the tracks, so that
 * `--transit-only` can rebuild the Stadtbahn in seconds without parsing the city again.
 */
export type CityEnv = {
  /** Whether (x, z) lies inside a building. */
  built(p: Pt): boolean;
  /** Whether (x, z) is pavement (sidewalk or square). */
  pavement(p: Pt): boolean;
  /** Whether (x, z) lies on a carriageway. */
  roadway(p: Pt): boolean;
};

/** Raster cell (m), cells per tile side, and how far beside a track the raster reaches (m). */
const CELL = 0.5, TILE = 64, REACH = 48;
const MAGIC = 'NNE1';
const BUILT = 1, PAVEMENT = 2, ROADWAY = 4;

/** "Inside a building" with a grid over the footprints' boxes (the plain test walks every building). */
export function footprintTest(buildings: BuildingMesh[], cell = 16): (p: Pt) => boolean {
  const grid = new Map<string, BuildingMesh[]>();
  for (const b of buildings) {
    const fp = footprintOf(b);
    if (!Number.isFinite(fp.minX)) continue;
    for (let gx = Math.floor(fp.minX / cell); gx <= Math.floor(fp.maxX / cell); gx++) {
      for (let gz = Math.floor(fp.minZ / cell); gz <= Math.floor(fp.maxZ / cell); gz++) {
        const key = `${gx}_${gz}`;
        let l = grid.get(key);
        if (!l) grid.set(key, (l = []));
        l.push(b);
      }
    }
  }
  return (p) => (grid.get(`${Math.floor(p.x / cell)}_${Math.floor(p.z / cell)}`) ?? []).some((b) => footprintContains(b, p.x, p.z));
}

/** The raster of `env` within REACH of the tracks, encoded (see decodeEnv). */
export function encodeEnv(env: CityEnv, tracks: Pt[][]): Uint8Array {
  const size = CELL * TILE, tiles = new Set<string>();
  for (const line of tracks) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i]!, b = line[Math.min(i + 1, line.length - 1)]!, n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8));
      for (let k = 0; k <= n; k++) {
        const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
        for (let tx = Math.floor((x - REACH) / size); tx <= Math.floor((x + REACH) / size); tx++) {
          for (let tz = Math.floor((z - REACH) / size); tz <= Math.floor((z + REACH) / size); tz++) tiles.add(`${tx}_${tz}`);
        }
      }
    }
  }
  const out = new Uint8Array(16 + tiles.size * (8 + TILE * TILE)), view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
  view.setFloat32(4, CELL, true);
  view.setUint32(8, TILE, true);
  view.setUint32(12, tiles.size, true);
  let o = 16;
  for (const key of [...tiles].sort()) {
    const [tx, tz] = key.split('_').map(Number) as [number, number];
    view.setInt32(o, tx, true);
    view.setInt32(o + 4, tz, true);
    o += 8;
    for (let r = 0; r < TILE; r++) {
      for (let c = 0; c < TILE; c++) {
        const p = { x: tx * size + (c + 0.5) * CELL, z: tz * size + (r + 0.5) * CELL };
        out[o++] = (env.built(p) ? BUILT : 0) | (env.pavement(p) ? PAVEMENT : 0) | (env.roadway(p) ? ROADWAY : 0);
      }
    }
  }
  return out;
}

/** The environment read back from encodeEnv's raster; outside it nothing is known: no building, pavement or road. */
export function decodeEnv(buf: Uint8Array): CityEnv {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== MAGIC) throw new Error('transit env: bad magic');
  const cell = view.getFloat32(4, true), tile = view.getUint32(8, true), count = view.getUint32(12, true), size = cell * tile;
  const tiles = new Map<string, number>();
  for (let i = 0, o = 16; i < count; i++, o += 8 + tile * tile) tiles.set(`${view.getInt32(o, true)}_${view.getInt32(o + 4, true)}`, o + 8);
  const at = (p: Pt): number => {
    const tx = Math.floor(p.x / size), tz = Math.floor(p.z / size), o = tiles.get(`${tx}_${tz}`);
    if (o === undefined) return 0;
    return buf[o + Math.min(tile - 1, Math.floor((p.z - tz * size) / cell)) * tile + Math.min(tile - 1, Math.floor((p.x - tx * size) / cell))]!;
  };
  return { built: (p) => (at(p) & BUILT) !== 0, pavement: (p) => (at(p) & PAVEMENT) !== 0, roadway: (p) => (at(p) & ROADWAY) !== 0 };
}
