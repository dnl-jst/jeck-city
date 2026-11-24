import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DGM_TILES, LOD2_TILES, TRANSIT_ROUTES_FILE } from '../fetch';
import { GTFS_ZIP, parseRawLock, rawKey, readRawLock, requireTimetable, type RawLock } from './lock';

const HASH = '0123456789abcdef0123456789abcdef';
const valid = (): RawLock => ({ version: 1, mirror: 'https://cdn.example.org/', files: { 'osm.json': { hash: HASH, bytes: 3 } } });

describe('parseRawLock', () => {
  it('accepts a valid lock, with and without a mirror and sample days', () => {
    expect(parseRawLock(valid())).toEqual(valid());
    expect(parseRawLock({ ...valid(), mirror: null }).mirror).toBeNull();
    expect(parseRawLock({ ...valid(), gtfsDays: [20261124, 20261128, 20261129] }).gtfsDays).toEqual([20261124, 20261128, 20261129]);
  });

  it('parseRawLock rejects a wrong version, a non-hex hash, a mirror without trailing slash', () => {
    expect(() => parseRawLock({ ...valid(), version: 2 })).toThrow(/version/);
    expect(() => parseRawLock({ ...valid(), files: { 'osm.json': { hash: 'XYZ', bytes: 3 } } })).toThrow(/osm\.json/);
    expect(() => parseRawLock({ ...valid(), files: { 'osm.json': { hash: HASH.toUpperCase(), bytes: 3 } } })).toThrow(/osm\.json/);
    expect(() => parseRawLock({ ...valid(), mirror: 'https://cdn.example.org' })).toThrow(/mirror/);
  });

  it('rejects paths that leave data/raw and broken sizes or sample days', () => {
    expect(() => parseRawLock({ ...valid(), files: { '../x.json': { hash: HASH, bytes: 3 } } })).toThrow(/\.\.\/x\.json/);
    expect(() => parseRawLock({ ...valid(), files: { '/x.json': { hash: HASH, bytes: 3 } } })).toThrow(/x\.json/);
    expect(() => parseRawLock({ ...valid(), files: { 'osm.json': { hash: HASH, bytes: -1 } } })).toThrow(/osm\.json/);
    expect(() => parseRawLock({ ...valid(), gtfsDays: [1, 2] })).toThrow(/gtfsDays/);
    expect(() => parseRawLock(null)).toThrow();
  });
});

it('rawKey shards by the first two hash characters and keeps the extension', () => {
  expect(rawKey('lod2/LoD2_32_353_5642_1_NW.gml', HASH)).toBe(`raw/01/${HASH}.gml`);
  expect(rawKey('dgm1/dgm1_32_353_5642_1_nw_2022.tif', HASH)).toBe(`raw/01/${HASH}.tif`);
  expect(rawKey('osm.json', HASH)).toBe(`raw/01/${HASH}.json`);
});

describe('readRawLock', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  const complete = (): RawLock['files'] => {
    const files: RawLock['files'] = { 'osm.json': { hash: HASH, bytes: 1 }, [TRANSIT_ROUTES_FILE]: { hash: HASH, bytes: 1 } };
    for (const t of LOD2_TILES) files[`lod2/${t}`] = { hash: HASH, bytes: 1 };
    for (const t of DGM_TILES) files[`dgm1/${t}`] = { hash: HASH, bytes: 1 };
    return files;
  };

  it('the pipeline needs exactly the tiles of LOD2_TILES and DGM_TILES: a lock that lacks one rejects before any work', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nn-lock-'));
    const path = join(dir, 'raw.lock.json');
    await writeFile(path, JSON.stringify({ version: 1, mirror: null, files: complete() }));
    expect(Object.keys((await readRawLock(path)).files)).toHaveLength(2 + LOD2_TILES.length + DGM_TILES.length);

    const noDgm = complete();
    delete noDgm[`dgm1/${DGM_TILES[3]}`];
    await writeFile(path, JSON.stringify({ version: 1, mirror: null, files: noDgm }));
    await expect(readRawLock(path)).rejects.toThrow(`dgm1/${DGM_TILES[3]}`);

    const noLod2 = complete();
    delete noLod2[`lod2/${LOD2_TILES[0]}`];
    await writeFile(path, JSON.stringify({ version: 1, mirror: null, files: noLod2 }));
    await expect(readRawLock(path)).rejects.toThrow(/npm run raw:update/);
  });
});

it('requireTimetable gives the pinned feed and sample days, and names `raw:update -- gtfs` when either is missing', () => {
  const days: [number, number, number] = [20261201, 20261128, 20261129];
  const withZip = { ...valid(), files: { ...valid().files, [GTFS_ZIP]: { hash: HASH, bytes: 9 } } };
  expect(requireTimetable({ ...withZip, gtfsDays: days })).toEqual({ hash: HASH, days });
  expect(() => requireTimetable(withZip)).toThrow(/gtfsDays.*npm run raw:update -- gtfs/);
  expect(() => requireTimetable({ ...valid(), gtfsDays: days })).toThrow(/gtfs\.zip.*npm run raw:update -- gtfs/);
});
