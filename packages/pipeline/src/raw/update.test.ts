import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DGM_TILES, LOD2_TILES, TRANSIT_ROUTES_QUERY } from '../fetch';
import { GTFS_URL } from '../gtfs';
import { CACHE_CONTROL } from '../publish/publish';
import { memoryStore } from '../publish/store';
import { contentHash } from '../worldindex';
import { parseRawLock, pipelineRawPaths, rawKey, type RawLock } from './lock';
import { updateRaw } from './update';
import { GTFS_FIXTURE, makeZip } from './zipfixture';

const MIRROR = 'https://raw.example.org/';
const NOW = new Date(2026, 10, 25); // Wednesday
const DAYS = [20261201, 20261128, 20261129];
const ZIP = makeZip({ ...GTFS_FIXTURE, 'Lizenz.txt': 'VRS-Lizenztext aus dem Feed' });

/** Deterministic bytes that do not compress (a SHA-256 chain). */
function noise(seed: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let h = createHash('sha256').update(seed).digest();
  for (let i = 0; i < n; i += 32, h = createHash('sha256').update(h).digest()) out.set(h.subarray(0, Math.min(32, n - i)), i);
  return out;
}

/** The origins' content of each raw file; `version` changes osm.json. LoD2 tiles compress well, DGM1 tiles not at all. */
function body(path: string, version = 1): Uint8Array {
  if (path === 'osm.json') return new TextEncoder().encode(JSON.stringify({ version, elements: Array.from({ length: 200 }, () => ({ type: 'node', id: 1 })) }));
  if (path === 'transit-routes.json') return new TextEncoder().encode('{"elements":[{"type":"relation"}]}');
  if (path === 'gtfs.zip') return ZIP;
  if (path.startsWith('lod2/')) return new TextEncoder().encode(`<gml name="${path}"/>\n`.repeat(50));
  return noise(path, 512);
}

/** A fetch standing in for the origin servers; records every URL. `fail`: a URL part answered with HTTP 500. */
function origins(o: { fail?: string; version?: number; zip?: Uint8Array } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (o.fail && u.includes(o.fail)) return new Response('boom', { status: 500 });
    const name = u.slice(u.lastIndexOf('/') + 1);
    let path: string;
    if (u === GTFS_URL) path = 'gtfs.zip';
    else if (u.includes('lod2_gml')) path = `lod2/${name}`;
    else if (u.includes('dgm1_tiff')) path = `dgm1/${name}`;
    else if (u.includes('/api/interpreter')) path = new URLSearchParams(String(init?.body)).get('data') === TRANSIT_ROUTES_QUERY ? 'transit-routes.json' : 'osm.json';
    else return new Response('not found', { status: 404 });
    return new Response(path === 'gtfs.zip' && o.zip ? o.zip : body(path, o.version));
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

let dir: string, raw: string, lockFile: string, lines: string[];
const log = (line: string) => { lines.push(line); };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nn-update-'));
  raw = join(dir, 'raw');
  lockFile = join(dir, 'raw.lock.json');
  lines = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ALL = ['osm', 'tiles', 'gtfs'] as const;
const unbr = (b: Uint8Array) => new Uint8Array(brotliDecompressSync(b));

it('updateRaw uploads only files the mirror lacks and writes them under rawKey with br when smaller', async () => {
  const store = memoryStore();
  const osmKey = rawKey('osm.json', contentHash(body('osm.json')));
  await store.put(osmKey, body('osm.json'), { contentType: 'application/json', cacheControl: CACHE_CONTROL });
  const { fetchFn } = origins();
  const lock = await updateRaw({ dir: raw, lockFile, what: [...ALL], store, mirror: MIRROR, fetchFn, now: NOW, log });

  const uploaded = store.puts.slice(1);
  expect(uploaded).not.toContain(osmKey);
  expect(uploaded).toHaveLength(Object.keys(lock.files).length - 1 + 1); // every file but osm.json, and the licence
  for (const [path, e] of Object.entries(lock.files)) expect(store.meta.has(rawKey(path, e.hash))).toBe(true);

  const gml = `lod2/${LOD2_TILES[0]}`, gmlKey = rawKey(gml, lock.files[gml]!.hash);
  expect(gmlKey).toMatch(/^raw\/[0-9a-f]{2}\/[0-9a-f]{32}\.gml$/);
  expect(store.meta.get(gmlKey)).toMatchObject({ contentEncoding: 'br', cacheControl: CACHE_CONTROL });
  expect(unbr((await store.get(gmlKey)).body)).toEqual(body(gml));

  const tif = `dgm1/${DGM_TILES[0]}`, tifKey = rawKey(tif, lock.files[tif]!.hash);
  expect(store.meta.get(tifKey)).toEqual({ contentType: 'image/tiff', cacheControl: CACHE_CONTROL });
  expect(new Uint8Array((await store.get(tifKey)).body)).toEqual(body(tif));

  const licence = store.meta.get('raw/LICENSE.txt')!;
  expect(licence.contentType).toMatch(/^text\/plain/);
  expect(licence.cacheControl).toBe('public, max-age=3600'); // the one key that changes: not immutable
  const got = await store.get('raw/LICENSE.txt');
  const text = new TextDecoder().decode(got.contentEncoding === 'br' ? unbr(got.body) : got.body);
  expect(text).toContain('dl-de/zero-2.0');
  expect(text).toContain('ODbL');
  expect(text).toContain('VRS-Lizenztext aus dem Feed');
});

it('updateRaw writes a lock that parseRawLock accepts, sorted by path, and a second run changes nothing', async () => {
  const store = memoryStore();
  const lock = await updateRaw({ dir: raw, lockFile, what: [...ALL], store, mirror: MIRROR, fetchFn: origins().fetchFn, now: NOW, log });
  const text = await readFile(lockFile, 'utf8');
  expect(parseRawLock(JSON.parse(text))).toEqual(lock);
  expect(lock.mirror).toBe(MIRROR);
  expect(lock.gtfsDays).toEqual(DAYS);
  const paths = Object.keys(lock.files);
  expect(paths).toEqual([...paths].sort());
  expect(paths).toEqual([...pipelineRawPaths(), 'gtfs.zip'].sort());
  for (const path of paths) {
    expect(lock.files[path]).toEqual({ hash: contentHash(body(path)), bytes: body(path).byteLength });
    expect(new Uint8Array(await readFile(join(raw, path)))).toEqual(body(path));
  }
  expect(existsSync(join(raw, '.update'))).toBe(false);

  const puts = store.puts.length;
  await updateRaw({ dir: raw, lockFile, what: [...ALL], store, mirror: MIRROR, fetchFn: origins().fetchFn, now: NOW, log });
  expect(await readFile(lockFile, 'utf8')).toBe(text);
  expect(store.puts.length).toBe(puts);
});

it('updateRaw without a store keeps the lock mirror and uploads nothing', async () => {
  const OLD = 'https://old.example.org/';
  await writeFile(lockFile, JSON.stringify({ version: 1, mirror: OLD, files: {} }));
  const { fetchFn, calls } = origins();
  const lock = await updateRaw({ dir: raw, lockFile, what: [...ALL], store: null, mirror: 'https://new.example.org/', fetchFn, now: NOW, log });
  expect(lock.mirror).toBe(OLD);
  expect(parseRawLock(JSON.parse(await readFile(lockFile, 'utf8')))).toEqual(lock);
  expect(calls.filter((u) => u.includes('example.org'))).toEqual([]);
  expect(lines.join('\n')).toMatch(/S3_/);
});

it('a failed download of one tile leaves the old lock file untouched', async () => {
  await updateRaw({ dir: raw, lockFile, what: [...ALL], store: null, mirror: null, fetchFn: origins().fetchFn, now: NOW, log });
  const before = await readFile(lockFile, 'utf8');
  const { fetchFn } = origins({ fail: DGM_TILES[7], version: 2 });
  await expect(updateRaw({ dir: raw, lockFile, what: [...ALL], store: null, mirror: null, fetchFn, now: NOW, log })).rejects.toThrow(/HTTP 500/);
  expect(await readFile(lockFile, 'utf8')).toBe(before);
  // the files the lock pins are untouched too (osm.json would have changed), and no download is left behind
  expect(new Uint8Array(await readFile(join(raw, 'osm.json')))).toEqual(body('osm.json', 1));
  expect(existsSync(join(raw, '.update'))).toBe(false);
});

/** data/raw and a lock as Task 1 left them: every file the pipeline reads, no timetable, no mirror. */
async function seedWithoutTimetable(): Promise<RawLock> {
  const lock: RawLock = { version: 1, mirror: null, files: {} };
  for (const path of pipelineRawPaths().sort()) {
    await mkdir(dirname(join(raw, path)), { recursive: true });
    await writeFile(join(raw, path), body(path));
    lock.files[path] = { hash: contentHash(body(path)), bytes: body(path).byteLength };
  }
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

it("with what ['gtfs'] only the timetable is fetched, but every local raw file the mirror lacks is uploaded", async () => {
  const old = await seedWithoutTimetable();
  const store = memoryStore();
  const { fetchFn, calls } = origins();
  const lock = await updateRaw({ dir: raw, lockFile, what: ['gtfs'], store, mirror: MIRROR, fetchFn, now: NOW, log });
  expect(calls).toEqual([GTFS_URL]);
  expect(lock.files).toEqual({ ...old.files, 'gtfs.zip': { hash: contentHash(ZIP), bytes: ZIP.byteLength } });
  expect(lock.gtfsDays).toEqual(DAYS);
  expect(lock.mirror).toBe(MIRROR);
  expect(new Set(store.puts)).toEqual(new Set([...Object.entries(lock.files).map(([p, e]) => rawKey(p, e.hash)), 'raw/LICENSE.txt']));
});

it('updateRaw refuses a run that would leave a file the pipeline needs out of the lock', async () => {
  const { fetchFn, calls } = origins();
  await expect(updateRaw({ dir: raw, lockFile, what: ['osm'], store: null, mirror: null, fetchFn, now: NOW, log })).rejects.toThrow(/raw:update -- tiles/);
  expect(calls).toEqual([]);
  expect(existsSync(lockFile)).toBe(false);
});

it('a feed that lacks one of the six tables is refused: nothing uploaded, the old lock kept', async () => {
  const store = memoryStore();
  await updateRaw({ dir: raw, lockFile, what: [...ALL], store, mirror: MIRROR, fetchFn: origins().fetchFn, now: NOW, log });
  const before = await readFile(lockFile, 'utf8'), puts = store.puts.length;
  const { 'stop_times.txt': _, ...rest } = GTFS_FIXTURE;
  const { fetchFn } = origins({ zip: makeZip(rest) });
  await expect(updateRaw({ dir: raw, lockFile, what: ['gtfs'], store, mirror: MIRROR, fetchFn, now: NOW, log })).rejects.toThrow(/stop_times\.txt/);
  expect(store.puts.length).toBe(puts);
  expect(await readFile(lockFile, 'utf8')).toBe(before);
  expect(new Uint8Array(await readFile(join(raw, 'gtfs.zip')))).toEqual(ZIP);
});

it('updateRaw rejects a mirror URL without trailing slash before any download or upload', async () => {
  const store = memoryStore();
  const { fetchFn, calls } = origins();
  await expect(updateRaw({ dir: raw, lockFile, what: [...ALL], store, mirror: 'https://raw.example.org', fetchFn, now: NOW, log })).rejects.toThrow(/mirror/);
  expect(calls).toEqual([]);
  expect(store.puts).toEqual([]);
  expect(existsSync(lockFile)).toBe(false);
});
