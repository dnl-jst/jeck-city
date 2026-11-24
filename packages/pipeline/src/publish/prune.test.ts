import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { objectKey, worldObjectKey } from '@nn/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, writeWorldIndex } from '../worldindex.js';
import { publishWorld } from './publish.js';
import { pruneWorlds } from './prune.js';
import { memoryStore } from './store.js';

const dirs: string[] = [];
let store: ReturnType<typeof memoryStore>;

/** Publishes a world made of `files` (name → content) and returns its hash. */
async function world(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prune-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  await writeWorldIndex(dir);
  return (await publishWorld(dir, store)).worldHash;
}
const key = (name: string, content: string) => objectKey(name, contentHash(Buffer.from(content)));
const keys = async (prefix: string) => (await store.list(prefix)).map((o) => o.key).sort();

// Oldest to newest. w1 and w2 share shared.glb; w2's two.glb and w3's x.glb have the same content (one object).
let w1: string, w2: string, w3: string, w4: string;
beforeEach(async () => {
  store = memoryStore();
  w1 = await world({ 'shared.glb': 'S', 'one.glb': 'w1' });
  w2 = await world({ 'shared.glb': 'S', 'two.glb': 'w2' });
  w3 = await world({ 'three.glb': 'w3', 'x.glb': 'w2' });
  w4 = await world({ 'four.glb': 'w4' });
});
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('pruneWorlds', () => {
  it('fixture: some index copies are stored as br, so pruning exercises decompression', async () => {
    const copies = await Promise.all([w1, w2, w3, w4].map((w) => store.get(worldObjectKey(w))));
    expect(copies.some((c) => c.contentEncoding === 'br')).toBe(true);
  });

  it('keeps the live world and the newest `keep` worlds with all their objects', async () => {
    const r = await pruneWorlds(store, { liveHash: w1, keep: 1, delete: true });
    expect(r.keptWorlds).toEqual([w4, w1]);
    expect(r.removedWorlds).toEqual([w3, w2]);
    expect(await keys('worlds/')).toEqual([worldObjectKey(w1), worldObjectKey(w4)].sort());
    expect(await keys('objects/')).toEqual([key('shared.glb', 'S'), key('one.glb', 'w1'), key('four.glb', 'w4')].sort());
  });

  it('removes worlds/…json and objects no kept world names', async () => {
    const r = await pruneWorlds(store, { liveHash: w4, keep: 2, delete: true });
    expect(r.keptWorlds).toEqual([w4, w3]);
    expect(r.removedWorlds).toEqual([w2, w1]);
    expect(r.removedObjects.sort()).toEqual([key('shared.glb', 'S'), key('one.glb', 'w1')].sort());
    expect(await keys('worlds/')).toEqual([worldObjectKey(w3), worldObjectKey(w4)].sort());
    expect(await keys('objects/')).toEqual([key('three.glb', 'w3'), key('x.glb', 'w2'), key('four.glb', 'w4')].sort());
  });

  it('never removes an object a kept world shares with a removed one', async () => {
    const r = await pruneWorlds(store, { liveHash: w2, keep: 0, delete: true });
    expect(r.keptWorlds).toEqual([w2]);
    expect(r.removedObjects.sort()).toEqual([key('one.glb', 'w1'), key('three.glb', 'w3'), key('four.glb', 'w4')].sort());
    expect(await keys('objects/')).toEqual([key('shared.glb', 'S'), key('two.glb', 'w2')].sort());
  });

  it('deletes nothing unless delete is true, but reports the same lists', async () => {
    const before = { worlds: await keys('worlds/'), objects: await keys('objects/') };
    const dry = await pruneWorlds(store, { liveHash: w1, keep: 1, delete: false });
    expect({ worlds: await keys('worlds/'), objects: await keys('objects/') }).toEqual(before);
    const real = await pruneWorlds(store, { liveHash: w1, keep: 1, delete: true });
    expect(real).toEqual(dry);
    expect(dry.removedObjects.sort()).toEqual([key('two.glb', 'w2'), key('three.glb', 'w3')].sort());
  });

  it('removes an orphan object no world names, only with delete: true', async () => {
    const orphan = key('lost.glb', 'left by an interrupted publish');
    await store.put(orphan, Buffer.from('left by an interrupted publish'), {
      contentType: 'model/gltf-binary',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const dry = await pruneWorlds(store, { liveHash: w4, keep: 5, delete: false });
    expect(dry.removedWorlds).toEqual([]);
    expect(dry.removedObjects).toEqual([orphan]);
    expect(await keys('objects/')).toContain(orphan);
    const real = await pruneWorlds(store, { liveHash: w4, keep: 5, delete: true });
    expect(real.removedObjects).toEqual([orphan]);
    expect(await keys('objects/')).not.toContain(orphan);
    expect(await keys('worlds/')).toHaveLength(4);
  });

  it('throws when the live world has no worlds/<hash>.json in the store', async () => {
    await expect(pruneWorlds(store, { liveHash: 'ffffffffffff', keep: 5, delete: true })).rejects.toThrow(/live/);
    expect(await keys('worlds/')).toHaveLength(4);
  });
});
