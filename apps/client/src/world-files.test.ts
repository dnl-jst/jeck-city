import { describe, expect, it } from 'vitest';
import type { WorldIndex } from '@nn/shared';
import { FetchError } from './errors';
import { loadWorldFiles, WorldFiles } from './world-files';

const HASH_A = 'ab'.padEnd(32, '0');
const HASH_B = 'cd'.padEnd(32, '1');
const index: WorldIndex = { version: 1, files: { 'chunk_0_1.glb': { hash: HASH_A, bytes: 10 }, 'collision.bin': { hash: HASH_B, bytes: 20 } } };
const BUCKET = 'https://b.example/';

/** A fetch stub that records its calls and answers from `routes` (url → status, body); unknown urls get 404. */
function stubFetch(routes: Record<string, { status: number; body?: string }> = {}): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes[url] ?? { status: 404 };
    return new Response(r.body ?? '', { status: r.status });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

describe('WorldFiles', () => {
  it('fetch(name) asks the bucket URL without cache option when worldUrl is set', async () => {
    const { fetch, calls } = stubFetch({ [`https://b.example/objects/ab/${HASH_A}.glb`]: { status: 200 } });
    const files = new WorldFiles(index, BUCKET, fetch);
    expect((await files.fetch('chunk_0_1.glb')).status).toBe(200);
    expect(calls).toEqual([{ url: `https://b.example/objects/ab/${HASH_A}.glb`, init: undefined }]);
  });

  it('fetch(name) asks /world/<name> with cache: no-cache when worldUrl is null', async () => {
    const { fetch, calls } = stubFetch({ '/world/collision.bin': { status: 200 } });
    await new WorldFiles(index, null, fetch).fetch('collision.bin');
    expect(calls).toEqual([{ url: '/world/collision.bin', init: { cache: 'no-cache' } }]);
  });

  it('fetch(name) rejects with FetchError on a non-ok status and on a network failure', async () => {
    await expect(new WorldFiles(index, null, stubFetch().fetch).fetch('collision.bin')).rejects.toMatchObject({ name: 'FetchError', status: 404 });
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    await expect(new WorldFiles(index, BUCKET, failing).fetch('collision.bin')).rejects.toBeInstanceOf(FetchError);
  });

  it('url() throws a message naming the file when the index does not have it', () => {
    const files = new WorldFiles(index, null);
    expect(() => files.url('x.glb')).toThrow(/x\.glb/);
  });

  it('fetch(name) of a file the index does not have rejects', async () => {
    await expect(new WorldFiles(index, BUCKET, stubFetch().fetch).fetch('x.glb')).rejects.toThrow(/x\.glb/);
  });

  it('nameOf maps a bucket URL back to its logical name and returns null for other URLs', () => {
    const files = new WorldFiles(index, BUCKET);
    expect(files.nameOf(files.url('chunk_0_1.glb'))).toBe('chunk_0_1.glb');
    expect(files.nameOf(`https://b.example/objects/cd/${HASH_B}.bin`)).toBe('collision.bin');
    expect(files.nameOf('/audio/step-1.ogg')).toBeNull();
    expect(files.nameOf('https://b.example/objects/ff/ffff.glb')).toBeNull();
    const local = new WorldFiles(index, null);
    expect(local.nameOf('/world/collision.bin')).toBe('collision.bin');
  });
});

describe('loadWorldFiles', () => {
  const indexJson = JSON.stringify(index);

  it('reads the index (no-cache) and the bucket from /config.json (no-cache)', async () => {
    const { fetch, calls } = stubFetch({
      '/world/index.json': { status: 200, body: indexJson },
      '/config.json': { status: 200, body: JSON.stringify({ worldUrl: BUCKET }) },
    });
    const { files, indexBytes } = await loadWorldFiles(fetch);
    expect(new TextDecoder().decode(indexBytes)).toBe(indexJson);
    expect(files.url('collision.bin')).toBe(`https://b.example/objects/cd/${HASH_B}.bin`);
    expect(calls.map((c) => [c.url, c.init?.cache]).sort()).toEqual([['/config.json', 'no-cache'], ['/world/index.json', 'no-cache']]);
  });

  it('worldUrl null in /config.json loads from /world/', async () => {
    const { fetch } = stubFetch({
      '/world/index.json': { status: 200, body: indexJson },
      '/config.json': { status: 200, body: JSON.stringify({ worldUrl: null }) },
    });
    expect((await loadWorldFiles(fetch)).files.url('collision.bin')).toBe('/world/collision.bin');
  });

  it('a 404 for /config.json means worldUrl null; a failing index.json rejects', async () => {
    const ok = stubFetch({ '/world/index.json': { status: 200, body: indexJson } });
    expect((await loadWorldFiles(ok.fetch)).files.url('chunk_0_1.glb')).toBe('/world/chunk_0_1.glb');
    const failing = stubFetch({ '/config.json': { status: 200, body: JSON.stringify({ worldUrl: BUCKET }) } });
    await expect(loadWorldFiles(failing.fetch)).rejects.toMatchObject({ name: 'FetchError', status: 404 });
  });

  it('an unreachable /config.json (offline, no game server) means worldUrl null', async () => {
    const fetchFn = ((input: RequestInfo | URL) => String(input) === '/config.json'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(new Response(indexJson, { status: 200 }))) as typeof fetch;
    expect((await loadWorldFiles(fetchFn)).files.url('collision.bin')).toBe('/world/collision.bin');
  });
});
