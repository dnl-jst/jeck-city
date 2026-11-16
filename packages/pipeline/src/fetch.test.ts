import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { fetchOsm, LOD2_TILES, OVERPASS_URLS, tileNamesForBounds } from './fetch';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nn-osm-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('fetchOsm moves on to the next Overpass instance on network errors, overload and broken JSON', async () => {
  const calls: string[] = [];
  const answers: (() => Response)[] = [
    () => { throw new TypeError('fetch failed', { cause: new Error('ETIMEDOUT') }); },
    () => new Response('busy', { status: 504 }),
    () => new Response('{"elements": [', { status: 200 }), // truncated
    () => new Response('{"elements": []}', { status: 200 }),
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return answers[calls.length - 1]!(); }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await withDir(async (dir) => {
    const path = await fetchOsm(dir, { retryMs: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ elements: [] });
  });
  expect(calls).toEqual([OVERPASS_URLS[0], OVERPASS_URLS[1], OVERPASS_URLS[2], OVERPASS_URLS[0]]);
  expect(OVERPASS_URLS.some((u) => /\.ru\//.test(u))).toBe(false);
});

test('fetchOsm fails at once on a client error and after all attempts otherwise', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const bad = vi.fn(async () => new Response('bad query', { status: 400 }));
  vi.stubGlobal('fetch', bad);
  await withDir(async (dir) => {
    await expect(fetchOsm(dir, { retryMs: 0 })).rejects.toThrow('HTTP 400');
    expect(bad).toHaveBeenCalledTimes(1);
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 502 })));
  await withDir(async (dir) => {
    await expect(fetchOsm(dir, { retryMs: 0, attempts: 4 })).rejects.toThrow('all 4 attempts failed');
  });
});

test('tiles cover Nippes plus 150 m backdrop', () => {
  const t = tileNamesForBounds(355389 - 150, 5646699 - 150, 357399 + 150, 5648852 + 150);
  expect(t).toHaveLength(12);
  expect(t).toContain('LoD2_32_355_5646_1_NW.gml');
  expect(t).toContain('LoD2_32_357_5649_1_NW.gml');
});

test('LOD2_TILES covers Nippes and Neustadt-Nord (36 tiles)', () => {
  expect(LOD2_TILES).toHaveLength(36);
  expect(new Set(LOD2_TILES).size).toBe(36);
  expect(LOD2_TILES).toContain('LoD2_32_353_5644_1_NW.gml');
  expect(LOD2_TILES).toContain('LoD2_32_358_5649_1_NW.gml');
});
