import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { contentHash } from '../worldindex';
import { rawKey, type RawLock } from './lock';
import { ensureRawFiles } from './resolve';

const MIRROR = 'https://cdn.example.org/';
const enc = (s: string) => new TextEncoder().encode(s);
const entry = (s: string) => ({ hash: contentHash(enc(s)), bytes: enc(s).byteLength });

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'nn-raw-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A fetch that answers from `objects` (URL → body) and records every URL asked for; anything else is a 404. */
function mirrorFetch(objects: Record<string, string>) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return u in objects ? new Response(objects[u]) : new Response('not found', { status: 404 });
  });
  return { fetchFn: fn as unknown as typeof fetch, calls };
}

/** All files under `dir`, as forward-slash paths. */
async function listFiles(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(root.length + 1).split('\\').join('/')).sort();
}

const log = () => {};

it('a present file with the right hash is left alone (no fetch)', async () => {
  await writeFile(join(dir, 'osm.json'), 'osm');
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'osm.json': entry('osm') } };
  const { fetchFn, calls } = mirrorFetch({});
  await ensureRawFiles(lock, dir, { fetchFn, log });
  expect(calls).toEqual([]);
  expect(await readFile(join(dir, 'osm.json'), 'utf8')).toBe('osm');
});

it('a missing file is fetched from <mirror><rawKey> and written atomically', async () => {
  const e = entry('<gml/>');
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'lod2/a.gml': e } };
  const { fetchFn, calls } = mirrorFetch({ [MIRROR + rawKey('lod2/a.gml', e.hash)]: '<gml/>' });
  await ensureRawFiles(lock, dir, { fetchFn, log });
  expect(calls).toEqual([`${MIRROR}raw/${e.hash.slice(0, 2)}/${e.hash}.gml`]);
  expect(await readFile(join(dir, 'lod2/a.gml'), 'utf8')).toBe('<gml/>');
  expect(await listFiles(dir)).toEqual(['lod2/a.gml']); // the .part file was renamed, nothing left behind
});

it('a present file with the wrong hash is replaced from the mirror', async () => {
  await mkdir(join(dir, 'dgm1'));
  await writeFile(join(dir, 'dgm1/t.tif'), 'truncat');
  const e = entry('truncated tile');
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'dgm1/t.tif': e } };
  const { fetchFn, calls } = mirrorFetch({ [MIRROR + rawKey('dgm1/t.tif', e.hash)]: 'truncated tile' });
  await ensureRawFiles(lock, dir, { fetchFn, log });
  expect(calls).toHaveLength(1);
  expect(await readFile(join(dir, 'dgm1/t.tif'), 'utf8')).toBe('truncated tile');
});

it('a mirror answer with the wrong content rejects, names the file and "npm run raw:update", leaves no file behind', async () => {
  const e = entry('right');
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'osm.json': e } };
  const { fetchFn } = mirrorFetch({ [MIRROR + rawKey('osm.json', e.hash)]: 'wrong' });
  const run = ensureRawFiles(lock, dir, { fetchFn, log });
  await expect(run).rejects.toThrow(/osm\.json/);
  await expect(run).rejects.toThrow(/npm run raw:update/);
  expect(await listFiles(dir)).toEqual([]);
});

it('without a mirror a missing file rejects with the same hint', async () => {
  const lock: RawLock = { version: 1, mirror: null, files: { 'transit-routes.json': entry('routes') } };
  const { fetchFn, calls } = mirrorFetch({});
  const run = ensureRawFiles(lock, dir, { fetchFn, log });
  await expect(run).rejects.toThrow(/transit-routes\.json/);
  await expect(run).rejects.toThrow(/npm run raw:update/);
  expect(calls).toEqual([]);
});

it('a 404 from the mirror rejects with the same hint', async () => {
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'lod2/b.gml': entry('b') } };
  const { fetchFn } = mirrorFetch({});
  const run = ensureRawFiles(lock, dir, { fetchFn, log });
  await expect(run).rejects.toThrow(/lod2\/b\.gml/);
  await expect(run).rejects.toThrow(/404/);
  await expect(run).rejects.toThrow(/npm run raw:update/);
  expect(await listFiles(dir)).toEqual([]);
});

/** A fetch whose first answers come from `script` (a status, or 'down' for a network error); afterwards it serves `body`. */
function flakyFetch(script: (number | 'down')[], body: string) {
  let n = 0;
  const fn = vi.fn(async () => {
    const step = script[n++];
    if (step === 'down') throw new TypeError('fetch failed');
    if (step !== undefined) return new Response('upstream trouble', { status: step });
    return new Response(body);
  });
  return { fetchFn: fn as unknown as typeof fetch, calls: () => n };
}

it('an unreachable mirror (network error or 5xx) is tried 3 times, then rejects with "try again later", never steering to raw:update', async () => {
  for (const script of [['down', 'down', 'down'], [503, 500, 502], ['down', 503, 'down']] as (number | 'down')[][]) {
    const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'osm.json': entry('osm') } };
    const { fetchFn, calls } = flakyFetch(script, 'osm');
    const pauses: number[] = [];
    const run = ensureRawFiles(lock, dir, { fetchFn, log, sleep: async (ms) => { pauses.push(ms); } });
    await expect(run).rejects.toThrow(/osm\.json/);
    await expect(run).rejects.toThrow(/mirror unreachable \(.*\) — try again later; do NOT run raw:update/);
    await expect(run).rejects.not.toThrow(/Run `npm run raw:update`/);
    expect(calls()).toBe(3);
    expect(pauses).toHaveLength(2);
    expect(await listFiles(dir)).toEqual([]);
  }
});

it('a mirror that recovers within the 3 attempts gives the file', async () => {
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'osm.json': entry('osm') } };
  const { fetchFn, calls } = flakyFetch(['down', 503], 'osm');
  await ensureRawFiles(lock, dir, { fetchFn, log, sleep: async () => {} });
  expect(calls()).toBe(3);
  expect(await readFile(join(dir, 'osm.json'), 'utf8')).toBe('osm');
});

it('a 404 is not retried and keeps the raw:update hint', async () => {
  const lock: RawLock = { version: 1, mirror: MIRROR, files: { 'osm.json': entry('osm') } };
  const { fetchFn, calls } = flakyFetch([404], 'osm');
  const run = ensureRawFiles(lock, dir, { fetchFn, log, sleep: async () => {} });
  await expect(run).rejects.toThrow(/HTTP 404.*Run `npm run raw:update`/);
  await expect(run).rejects.not.toThrow(/unreachable/);
  expect(calls()).toBe(1);
});
