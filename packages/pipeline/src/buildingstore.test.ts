import { decodeTerrain, encodeTerrain, type TerrainGrid } from '@nn/shared';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BuildingStore, decodeTileFile } from './buildingstore.js';
import { codeHash } from './codehash.js';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { parseCityGml } from './citygml.js';
import { footprintOf } from './footprint.js';
import { type TerrainFile, writeTerrainFile } from './terrain/file.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.gml`, import.meta.url), 'utf8');
/** The <core:cityObjectMember> blocks of a fixture (one building each). */
const members = (gml: string) => gml.match(/<core:cityObjectMember>[\s\S]*?<\/core:cityObjectMember>/g)!;
const HEAD = fixture('gable-house').slice(0, fixture('gable-house').indexOf('<core:cityObjectMember>'));
const tileOf = (...blocks: string[]) => `${HEAD}${blocks.join('\n')}\n</core:CityModel>\n`;
const gable = members(fixture('gable-house'))[0]!, uHouse = members(fixture('u-house'))[0]!, broken = members(fixture('broken'))[0]!;
/** Tile A: the gable house; B: a broken building far outside the boundary, the U house, the gable house again; C: the U house again, a second gable house. */
const TILES = ['a.gml', 'b.gml', 'c.gml'];
const TEXT = [tileOf(gable), tileOf(broken, uHouse, gable), tileOf(uHouse, gable.replaceAll('FIXTURE_GABLE', 'FIXTURE_GABLE2'))];
/** Around the two fixture houses (local x ≈ −190, z ≈ 710). */
const boundary = [{ x: -250, z: 650 }, { x: -130, z: 650 }, { x: -130, z: 770 }, { x: -250, z: 770 }];
/** A gentle slope (y 4.6 … 5.8 at datum 35; the houses' base is 5), so the meshes get plinths; quantised as terrain.bin. */
const terrain = (): TerrainGrid => {
  const cols = 141, rows = 141;
  return decodeTerrain(encodeTerrain({ x0: -260, z0: 640, cols, rows, datum: 35, heights: Float32Array.from({ length: cols * rows }, (_, i) => 4.6 + 0.006 * (i % cols) + 0.003 * Math.floor(i / cols)) }));
};

let raw: string, cache: string, terrainDir: string;
const files: TerrainFile[] = [];
beforeEach(() => {
  raw = mkdtempSync(join(tmpdir(), 'nn-raw-'));
  cache = mkdtempSync(join(tmpdir(), 'nn-buildings-'));
  terrainDir = mkdtempSync(join(tmpdir(), 'nn-terrain-'));
  TILES.forEach((t, i) => writeFileSync(join(raw, t), TEXT[i]!));
});
afterEach(() => {
  for (const f of files.splice(0)) f.close();
  rmSync(raw, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
  rmSync(terrainDir, { recursive: true, force: true });
});
/** The grid as a terrain file (the store reads T0 from one). */
const fileOf = (t: TerrainGrid): TerrainFile => {
  const f = writeTerrainFile(join(terrainDir, `t${files.length}.bin`), t, (r, out) => out.set(t.heights.subarray(r * t.cols, (r + 1) * t.cols)));
  files.push(f);
  return f;
};

const build = (o: { maxTiles?: number; terrain?: TerrainGrid; log?: (s: string) => void } = {}) =>
  BuildingStore.build({ tiles: TILES, rawDir: raw, cacheDir: cache, datum: 35, terrain: fileOf(o.terrain ?? terrain()), boundary, maxTiles: o.maxTiles, log: o.log });
/** What the pipeline built before the store: buildBuildingMesh on the building as parsed from `tile`. */
const direct = (tile: number, id: string): BuildingMesh => buildBuildingMesh(parseCityGml(TEXT[tile]!).find((b) => b.id === id)!, { datum: 35, terrain: terrain() })!;
const bytes = (a: Float32Array | Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const sameMesh = (got: BuildingMesh, want: BuildingMesh) => {
  expect({ ...got, positions: 0, normals: 0, facadeUv: 0, kind: 0 }).toEqual({ ...want, positions: 0, normals: 0, facadeUv: 0, kind: 0 });
  for (const k of ['positions', 'normals', 'facadeUv', 'kind'] as const) {
    expect(got[k].constructor).toBe(want[k].constructor);
    expect(bytes(got[k]).equals(bytes(want[k]))).toBe(true);
  }
};

test('records are in (tile, document) order and a building present in two tiles appears once, in the first', async () => {
  const store = await build();
  expect(store.records.map((r) => [r.id, r.tile])).toEqual([['FIXTURE_GABLE', 0], ['FIXTURE_U', 1], ['FIXTURE_GABLE2', 2]]);
});

test('record.footprint equals footprintOf(mesh) of the mesh built directly', async () => {
  const store = await build();
  const want = [direct(0, 'FIXTURE_GABLE'), direct(1, 'FIXTURE_U'), direct(2, 'FIXTURE_GABLE2')];
  store.records.forEach((r, i) => {
    expect(r.footprint).toEqual(footprintOf(want[i]!));
    expect(r.footprint.tris.length).toBeGreaterThan(0);
    expect({ centroid: r.centroid, base: r.base, buildingSeed: r.buildingSeed, flags: r.flags }).toEqual({ centroid: want[i]!.centroid, base: want[i]!.base, buildingSeed: want[i]!.buildingSeed, flags: want[i]!.flags });
  });
});

test('mesh(i) is identical to buildBuildingMesh for that building (all typed arrays)', async () => {
  const store = await build();
  sameMesh(await store.mesh(0), direct(0, 'FIXTURE_GABLE'));
  sameMesh(await store.mesh(1), direct(1, 'FIXTURE_U'));
  sameMesh(await store.mesh(2), direct(2, 'FIXTURE_GABLE2'));
  const all: BuildingMesh[] = [];
  for await (const m of store.meshes()) all.push(m);
  expect(all.map((m) => m.id)).toEqual(['FIXTURE_GABLE', 'FIXTURE_U', 'FIXTURE_GABLE2']);
  sameMesh(all[1]!, direct(1, 'FIXTURE_U'));
});

test('never holds meshes of more than maxTiles tiles', async () => {
  const store = await build({ maxTiles: 1 });
  expect(store.heldTiles).toBe(0);
  const ids = ['FIXTURE_GABLE', 'FIXTURE_U', 'FIXTURE_GABLE2'];
  for (const i of [0, 1, 2, 0, 2, 1, 1, 0]) {
    expect((await store.mesh(i)).id).toBe(ids[i]);
    expect(store.heldTiles).toBe(1);
  }
  const wide = await build({ maxTiles: 2 });
  for (const i of [0, 1, 2, 0]) await wide.mesh(i);
  expect(wide.heldTiles).toBe(2);
});

test('a second build() over an unchanged cache dir gives the same records and meshes', async () => {
  const first = await build();
  const files = readdirSync(cache).map((f) => [f, statSync(join(cache, f)).mtimeMs]);
  expect(files).toHaveLength(3);
  const logs: string[] = [];
  const second = await build({ log: (s) => logs.push(s) });
  expect(logs.every((l) => l.includes('(cached)'))).toBe(true);
  expect(readdirSync(cache).map((f) => [f, statSync(join(cache, f)).mtimeMs])).toEqual(files);
  expect(second.records).toEqual(first.records);
  for (let i = 0; i < first.records.length; i++) sameMesh(await second.mesh(i), await first.mesh(i));
});

test('a changed raw tile or terrain rebuilds the cache instead of using it', async () => {
  await build();
  const logs: string[] = [];
  const t = terrain();
  t.heights[0] = 4.7;
  await build({ terrain: t, log: (s) => logs.push(s) });
  expect(logs.filter((l) => l.includes('(cached)'))).toEqual([]);
  // tile B changes: A stays cached; B and C (whose de-duplication depends on B) are rebuilt
  writeFileSync(join(raw, 'b.gml'), tileOf(uHouse, gable));
  logs.length = 0;
  const store = await build({ terrain: t, log: (s) => logs.push(s) });
  expect(logs.map((l) => l.includes('(cached)'))).toEqual([true, false, false]);
  expect(store.records.map((r) => r.id)).toEqual(['FIXTURE_GABLE', 'FIXTURE_U', 'FIXTURE_GABLE2']);
});

test('a cache file that no longer matches its key is refused when meshes are loaded', async () => {
  const store = await build();
  const other = await BuildingStore.build({ tiles: TILES, rawDir: raw, cacheDir: cache, datum: 35, terrain: fileOf({ ...terrain(), datum: 36 }), boundary });
  expect(other.records).toHaveLength(3);
  await expect(store.mesh(0)).rejects.toThrow(/changed/);
});

test('buildings dropped by classifyBuildings are in neither records nor cache', async () => {
  const store = await build();
  expect(parseCityGml(TEXT[1]!).map((b) => b.id)).toContain('FIXTURE_BROKEN');
  expect(store.records.map((r) => r.id)).not.toContain('FIXTURE_BROKEN');
  const cached = readdirSync(cache).flatMap((f) => decodeTileFile(readFileSync(join(cache, f))).meshes.map((m) => m.id));
  expect(cached.sort()).toEqual(['FIXTURE_GABLE', 'FIXTURE_GABLE2', 'FIXTURE_U']);
});

test('inChunk lists the records whose centroid lies in the chunk, in global order', async () => {
  const store = await build();
  expect(store.inChunk('-1_3')).toEqual([0, 1, 2]);
  expect(store.inChunk('0_0')).toEqual([]);
  const rest = store.without((r) => r.id === 'FIXTURE_U');
  expect(rest.records.map((r) => r.id)).toEqual(['FIXTURE_GABLE', 'FIXTURE_GABLE2']);
  expect(rest.inChunk('-1_3')).toEqual([0, 1]);
  expect((await rest.mesh(1)).id).toBe('FIXTURE_GABLE2');
});

test('a junk or truncated cache file is rebuilt, not used', async () => {
  await build();
  writeFileSync(join(cache, 'b.gml.bin'), 'junk');
  const c = readFileSync(join(cache, 'c.gml.bin'));
  writeFileSync(join(cache, 'c.gml.bin'), c.subarray(0, c.byteLength - 100));
  const logs: string[] = [];
  const store = await build({ log: (s) => logs.push(s) });
  expect(logs.map((l) => l.includes('(cached)'))).toEqual([true, false, false]);
  sameMesh(await store.mesh(1), direct(1, 'FIXTURE_U'));
  sameMesh(await store.mesh(2), direct(2, 'FIXTURE_GABLE2'));
});

test('a cache file whose body no longer matches its header hash is refused by mesh() and rebuilt by build()', async () => {
  const store = await build();
  const file = join(cache, 'a.gml.bin');
  const data = readFileSync(file);
  data[data.byteLength - 20]! ^= 0xff; // a byte inside the meshes, the length stays
  writeFileSync(file, data);
  await expect(store.mesh(0)).rejects.toThrow(/changed/);
  await expect(store.mesh(0)).rejects.toHaveProperty('cause');
  const logs: string[] = [];
  const again = await build({ log: (s) => logs.push(s) });
  expect(logs[0]).not.toContain('(cached)');
  sameMesh(await again.mesh(0), direct(0, 'FIXTURE_GABLE'));
});

test('codeHash covers every non-test .ts file of the roots, by path and content, in any order on disk', async () => {
  const tree = (order: string[]) => {
    const root = mkdtempSync(join(tmpdir(), 'nn-src-'));
    mkdirSync(join(root, 'sub'));
    const files: Record<string, string> = { 'a.ts': 'a', 'sub/b.ts': 'b', 'a.test.ts': 't', 'sub/c.test-util.ts': 'u', 'notes.md': 'n' };
    for (const f of order) writeFileSync(join(root, f), files[f]!);
    return root;
  };
  const names = ['a.ts', 'sub/b.ts', 'a.test.ts', 'sub/c.test-util.ts', 'notes.md'];
  const one = tree(names), two = tree([...names].reverse()), other = mkdtempSync(join(tmpdir(), 'nn-src-'));
  writeFileSync(join(other, 'x.ts'), 'x');
  try {
    const h = await codeHash([one, other]);
    expect(await codeHash([two, other])).toBe(h); // order of creation on disk does not matter
    writeFileSync(join(one, 'a.test.ts'), 'changed');
    writeFileSync(join(one, 'sub/c.test-util.ts'), 'changed');
    writeFileSync(join(one, 'notes.md'), 'changed');
    expect(await codeHash([one, other])).toBe(h); // tests, test utils and non-.ts files do not count
    writeFileSync(join(one, 'sub/b.ts'), 'b2');
    expect(await codeHash([one, other])).not.toBe(h); // content
    writeFileSync(join(one, 'sub/b.ts'), 'b');
    expect(await codeHash([one, other])).toBe(h);
    renameSync(join(one, 'sub/b.ts'), join(one, 'sub/b2.ts'));
    expect(await codeHash([one, other])).not.toBe(h); // a rename counts
    renameSync(join(one, 'sub/b2.ts'), join(one, 'sub/b.ts'));
    writeFileSync(join(other, 'x.ts'), 'y');
    expect(await codeHash([one, other])).not.toBe(h); // every root counts
  } finally {
    for (const d of [one, two, other]) rmSync(d, { recursive: true, force: true });
  }
});
