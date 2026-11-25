import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeTerrain, ORIGIN_UTM } from '@nn/shared';
import type { Rect } from '../chunks.js';
import { gaussBlur, mosaic, terrainFromMosaic, type Mosaic } from '../dgm.js';
import { buildT0, planT0 } from './dgmstream.js';
import type { TerrainFile } from './file.js';
import { rng } from './testgrid.js';

let dir: string;
const open: TerrainFile[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nn-dgmstream-'));
});
afterEach(() => {
  for (const f of open.splice(0)) f.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = 40;

/** A synthetic DGM: nx × ny tiles of T × T pixels; the mosaic's north-west corner at local (-ox, -oz). */
type Layout = { nx: number; ny: number; ox: number; oz: number; seed: number };

function makeTiles(l: Layout): Map<string, Mosaic> {
  const rand = rng(l.seed);
  const e0 = ORIGIN_UTM.e - l.ox, n0 = ORIGIN_UTM.n + l.oz;
  const tiles = new Map<string, Mosaic>();
  for (let ty = 0; ty < l.ny; ty++)
    for (let tx = 0; tx < l.nx; tx++) {
      const data = new Float32Array(T * T);
      for (let j = 0; j < T; j++)
        for (let i = 0; i < T; i++) {
          const x = tx * T + i, y = ty * T + j;
          data[j * T + i] = 80 + 30 * Math.sin(x / 13) * Math.cos(y / 9) + 0.25 * x - 0.1 * y + 4 * rand();
        }
      tiles.set(`t_${tx}_${ty}`, { e0: e0 + tx * T, n0: n0 - ty * T, width: T, height: T, data });
    }
  return tiles;
}

/** read() hands out a fresh copy of the tile (like decoding it again) and counts the calls. */
function reader(tiles: Map<string, Mosaic>) {
  const calls: string[] = [];
  const read = async (name: string): Promise<Mosaic> => {
    calls.push(name);
    const t = tiles.get(name);
    if (!t) throw new Error(`no tile ${name}`);
    return { ...t, data: t.data.slice() };
  };
  return { read, calls };
}

function reference(tiles: Mosaic[], area: Rect, sigma: number): Uint8Array {
  return new Uint8Array(encodeTerrain(terrainFromMosaic(gaussBlur(mosaic(tiles), sigma), area)));
}

async function build(tiles: Map<string, Mosaic>, area: Rect, sigma: number, o?: { names?: string[]; maxTiles?: number }) {
  const { read, calls } = reader(tiles);
  const path = join(dir, 't0.bin');
  const f = await buildT0({ tiles: o?.names ?? [...tiles.keys()], read, area, sigma, path, maxTiles: o?.maxTiles });
  open.push(f);
  return { f, bytes: new Uint8Array(readFileSync(path)), calls };
}

/** Nothing but the output may be left in the folder (no spool, no temporary file). */
const leftovers = () => readdirSync(dir).filter((n) => n !== 't0.bin');

describe('buildT0', () => {
  it('equals the reference chain byte for byte for a 3 × 3 mosaic and an area well inside it', async () => {
    const tiles = makeTiles({ nx: 3, ny: 3, ox: 55, oz: 47, seed: 1 });
    const area = { minX: -30.4, maxX: 41.2, minZ: -25.7, maxZ: 50.1 };
    const { f, bytes } = await build(tiles, area, 1);
    expect(bytes).toEqual(reference([...tiles.values()], area, 1));
    expect([f.x0, f.z0]).toEqual([-31, -26]);
    expect(leftovers()).toEqual([]);
  });

  it('equals the reference when the area touches the mosaic edge (clamped blur)', async () => {
    const tiles = makeTiles({ nx: 3, ny: 2, ox: 50, oz: 30, seed: 2 });
    // the mosaic spans x -50..70, z -30..50: the area takes all of it
    for (const sigma of [0.5, 1, 2]) {
      const area = { minX: -50, maxX: 70, minZ: -30, maxZ: 50 };
      const { bytes } = await build(tiles, area, sigma);
      expect(bytes).toEqual(reference([...tiles.values()], area, sigma));
    }
  });

  it('the tile order does not matter', async () => {
    const tiles = makeTiles({ nx: 3, ny: 3, ox: 61, oz: 59, seed: 3 });
    const area = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
    const names = [...tiles.keys()];
    const a = await build(tiles, area, 1, { names });
    const shuffled = [names[4]!, names[8]!, names[0]!, names[2]!, names[7]!, names[1]!, names[6]!, names[3]!, names[5]!];
    const b = await build(tiles, area, 1, { names: shuffled });
    expect(b.bytes).toEqual(a.bytes);
    expect(a.bytes).toEqual(reference([...tiles.values()], area, 1));
  });

  it('never holds more than maxTiles decoded tiles (maxTiles = one tile row + the two neighbouring rows)', async () => {
    const tiles = makeTiles({ nx: 4, ny: 5, ox: 70, oz: 90, seed: 4 });
    const area = { minX: -69, maxX: 89, minZ: -89, maxZ: 109 };
    const { bytes, calls } = await build(tiles, area, 2, { maxTiles: 3 * 4 });
    expect(bytes).toEqual(reference([...tiles.values()], area, 2));
    // every tile is decoded a bounded number of times: once to check it, once for the datum band at most, once for
    // the main pass
    for (const name of tiles.keys()) expect(calls.filter((c) => c === name).length).toBeLessThanOrEqual(3);
    // the stream in fact needs only the tiles that cross one pixel row; a bound below that is refused, not exceeded
    await expect(build(tiles, area, 2, { maxTiles: 4 })).resolves.toBeDefined();
    open.pop()!.close();
    rmSync(join(dir, 't0.bin'));
    await expect(build(tiles, area, 2, { maxTiles: 3 })).rejects.toThrow(/maxTiles/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a missing tile rejects with "mosaic has gaps" before any file is written', async () => {
    const tiles = makeTiles({ nx: 3, ny: 3, ox: 55, oz: 47, seed: 5 });
    tiles.delete('t_1_2');
    const area = { minX: -30, maxX: 40, minZ: -25, maxZ: 30 };
    expect(() => reference([...tiles.values()], area, 1)).toThrow('dgm: mosaic has gaps');
    await expect(build(tiles, area, 1)).rejects.toThrow('dgm: mosaic has gaps');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a tile with NoData rejects before any file is written', async () => {
    for (const bad of [-9999, NaN, Infinity]) {
      const tiles = makeTiles({ nx: 3, ny: 3, ox: 55, oz: 47, seed: 6 });
      // a tile far from the area: today the whole read fails, whatever the area
      tiles.get('t_2_2')!.data[17] = bad;
      await expect(build(tiles, { minX: -30, maxX: -20, minZ: -25, maxZ: -20 }, 1)).rejects.toThrow('dgm: tile contains NoData');
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('an area outside the mosaic rejects with the same message as terrainFromMosaic', async () => {
    const tiles = makeTiles({ nx: 2, ny: 2, ox: 40, oz: 40, seed: 7 });
    for (const area of [
      { minX: -41, maxX: 10, minZ: -10, maxZ: 10 },
      { minX: -10, maxX: 40.5, minZ: -10, maxZ: 10 },
      { minX: -10, maxX: 10, minZ: -40.5, maxZ: 10 },
      { minX: -10, maxX: 10, minZ: -10, maxZ: 41 },
    ]) {
      let message = '';
      try {
        reference([...tiles.values()], area, 1);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/outside the DGM mosaic/);
      await expect(build(tiles, area, 1)).rejects.toThrow(message);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('property test: 30 random mosaics (1–4 tiles per side), random sigma in {0.5, 1, 2}, random area', async () => {
    const rand = rng(20261125);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let k = 0; k < 30; k++) {
      const nx = int(1, 4), ny = int(1, 4), W = nx * T, H = ny * T;
      // the origin (and with it the datum's sample) mostly inside the mosaic, sometimes outside of it
      const ox = int(-10, W + 10), oz = int(-10, H + 10);
      const tiles = makeTiles({ nx, ny, ox, oz, seed: 1000 + k });
      const sigma = [0.5, 1, 2][int(0, 2)]!;
      // local x of the mosaic runs from -ox to W - ox; the area's integer cells must stay inside
      const a = -ox + rand() * W, b = -ox + rand() * W, c = -oz + rand() * H, d = -oz + rand() * H;
      const area = { minX: Math.min(a, b), maxX: Math.max(a, b), minZ: Math.min(c, d), maxZ: Math.max(c, d) };
      area.minX = Math.max(area.minX, -ox), area.minZ = Math.max(area.minZ, -oz);
      area.maxX = Math.min(area.maxX, W - ox), area.maxZ = Math.min(area.maxZ, H - oz);
      const names = [...tiles.keys()].sort(() => rand() - 0.5);
      const { bytes } = await build(tiles, area, sigma, { names });
      const what = `case ${k}: ${nx}×${ny} tiles, σ ${sigma}, origin ${ox}/${oz}, area ${JSON.stringify(area)}`;
      expect(bytes, what).toEqual(reference([...tiles.values()], area, sigma));
      // before quantising too, bit for bit (the centimetres hide most float differences)
      const ref = terrainFromMosaic(gaussBlur(mosaic([...tiles.values()]), sigma), area);
      const plan = await planT0({ tiles: names, read: reader(tiles).read, area, sigma });
      expect(plan.header, what).toEqual({ x0: ref.x0, z0: ref.z0, cols: ref.cols, rows: ref.rows, datum: ref.datum });
      const got = new Float32Array(ref.cols * ref.rows);
      let next = 0;
      await plan.rows((r, h) => (expect(r).toBe(next++), got.set(h, r * ref.cols)));
      expect(next).toBe(ref.rows);
      expect(new Uint8Array(got.buffer), what).toEqual(new Uint8Array(ref.heights.buffer));
      open.pop()!.close();
      rmSync(join(dir, 't0.bin'));
    }
  });
});
