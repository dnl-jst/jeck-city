import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { objectKey, worldHash, worldObjectKey, type WorldIndex } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWorldIndex } from '../worldindex.js';
import { publishWorld } from './publish.js';
import { memoryStore, type ObjectStore } from './store.js';

let dir: string;
let index: WorldIndex;
let store: ReturnType<typeof memoryStore>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'publish-'));
  await writeFile(join(dir, 'a.bin'), 'a'.repeat(10_000));
  await writeFile(join(dir, 'b.glb'), 'glTF'.repeat(50));
  await writeFile(join(dir, 'c.json'), JSON.stringify({ hello: 'world'.repeat(20) }));
  index = await writeWorldIndex(dir);
  store = memoryStore();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const key = (name: string) => objectKey(name, index.files[name]!.hash);

describe('publishWorld', () => {
  it('uploads every file under its object key and writes worlds/<hash>.json last', async () => {
    const r = await publishWorld(dir, store);
    const indexBytes = await readFile(join(dir, 'index.json'));
    expect(r.worldHash).toBe(await worldHash(new Uint8Array(indexBytes).buffer));
    expect(store.puts.at(-1)).toBe(worldObjectKey(r.worldHash));
    expect(store.puts).toContain(key('a.bin'));
    expect(store.puts).toContain(key('b.glb'));
    expect(store.puts).toContain(key('c.json'));
    expect(r).toMatchObject({ uploaded: 3, present: 0 }); // the index copy does not count
    expect(r.uploadedBytes).toBeGreaterThan(0);
    const copy = await store.get(worldObjectKey(r.worldHash));
    const body = copy.contentEncoding === 'br' ? brotliDecompressSync(copy.body) : copy.body;
    expect(Buffer.from(body).equals(indexBytes)).toBe(true);
  });

  it('a second run uploads no object and rewrites only worlds/<hash>.json', async () => {
    await publishWorld(dir, store);
    const before = store.puts.length;
    const r = await publishWorld(dir, store);
    expect(store.puts.slice(before)).toEqual([worldObjectKey(r.worldHash)]);
    expect(r).toMatchObject({ uploaded: 0, uploadedBytes: 0, present: 3 });
  });

  it('uploads a content shared by two files once', async () => {
    await writeFile(join(dir, 'd.bin'), 'a'.repeat(10_000));
    index = await writeWorldIndex(dir);
    const r = await publishWorld(dir, store);
    expect(key('d.bin')).toBe(key('a.bin'));
    expect(r).toMatchObject({ uploaded: 3, present: 0 });
    expect(store.puts.filter((k) => k === key('a.bin'))).toHaveLength(1);
  });

  it('stores compressible files as br and incompressible ones raw', async () => {
    const random = randomBytes(64);
    await writeFile(join(dir, 'r.bin'), random);
    index = await writeWorldIndex(dir);
    await publishWorld(dir, store);
    expect(store.meta.get(key('a.bin'))!.contentEncoding).toBe('br');
    const a = await store.get(key('a.bin'));
    expect(a.contentEncoding).toBe('br');
    expect(a.body.byteLength).toBeLessThan(10_000);
    expect(Buffer.from(brotliDecompressSync(a.body)).toString()).toBe('a'.repeat(10_000));
    expect(store.meta.get(key('r.bin'))!.contentEncoding).toBeUndefined();
    const r = await store.get(key('r.bin'));
    expect(r.contentEncoding).toBeUndefined();
    expect(Buffer.from(r.body).equals(random)).toBe(true);
  });

  it('sets content type by extension and the immutable cache header on every object', async () => {
    const r = await publishWorld(dir, store);
    expect(store.meta.get(key('b.glb'))!.contentType).toBe('model/gltf-binary');
    expect(store.meta.get(key('a.bin'))!.contentType).toBe('application/octet-stream');
    expect(store.meta.get(key('c.json'))!.contentType).toBe('application/json');
    expect(store.meta.get(worldObjectKey(r.worldHash))!.contentType).toBe('application/json');
    expect(store.meta.size).toBe(4);
    for (const m of store.meta.values()) expect(m.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('aborts before any upload when a file does not match index.json', async () => {
    await writeFile(join(dir, 'b.glb'), 'changed');
    await expect(publishWorld(dir, store)).rejects.toThrow(/world:index/);
    expect(store.puts).toEqual([]);
  });

  it('aborts before any upload when a file is missing from index.json', async () => {
    await writeFile(join(dir, 'new.glb'), 'new');
    await expect(publishWorld(dir, store)).rejects.toThrow(/world:index/);
    expect(store.puts).toEqual([]);
  });

  it('rejects a file that changes between the check and its upload and writes no worlds/<hash>.json', async () => {
    const changing: ObjectStore = {
      ...store,
      // listing runs after the check and before the first upload
      list: async (prefix) => {
        await writeFile(join(dir, 'b.glb'), 'glTF'.repeat(49) + 'XXXX');
        return store.list(prefix);
      },
    };
    await expect(publishWorld(dir, changing)).rejects.toThrow(/b\.glb.*world:index/);
    expect(await store.list('worlds/')).toEqual([]);
    expect(await store.list('objects/')).not.toContainEqual(expect.objectContaining({ key: key('b.glb') }));
  });

  it('fails before worlds/<hash>.json when an uploaded object is gone from the store', async () => {
    const losing: ObjectStore = {
      ...store,
      put: async (k, body, meta) => {
        await store.put(k, body, meta);
        if (k === key('a.bin')) await store.delete([k]);
      },
    };
    await expect(publishWorld(dir, losing)).rejects.toThrow(new RegExp(key('a.bin').replace(/[./]/g, '\\$&')));
    expect(await store.list('worlds/')).toEqual([]);
  });

  it('an interrupted run leaves no worlds/<hash>.json and the next run uploads only the rest', async () => {
    let calls = 0;
    const failing: ObjectStore = {
      ...store,
      put: async (k, body, meta) => {
        if (++calls === 2) throw new Error('network down');
        await store.put(k, body, meta);
      },
    };
    await expect(publishWorld(dir, failing)).rejects.toThrow(/network down/);
    expect(await store.list('worlds/')).toEqual([]);
    const stored = (await store.list('objects/')).length;
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(3);
    const r = await publishWorld(dir, store);
    expect(r).toMatchObject({ uploaded: 3 - stored, present: stored });
    expect(store.puts.at(-1)).toBe(worldObjectKey(r.worldHash));
  });
});
