import { brotliDecompressSync } from 'node:zlib';
import { objectKey, parseWorldIndex, worldObjectKey } from '@nn/shared';
import type { ObjectStore } from './store.js';

const WORLD_KEY_RE = /^worlds\/([0-9a-f]+)\.json$/;

/** The object keys a published world names, read from its worlds/<hash>.json. */
async function worldObjects(store: ObjectStore, hash: string): Promise<string[]> {
  const { body, contentEncoding } = await store.get(worldObjectKey(hash));
  const raw = contentEncoding === 'br' ? brotliDecompressSync(body) : body;
  const index = parseWorldIndex(JSON.parse(Buffer.from(raw).toString('utf8')));
  return Object.entries(index.files).map(([name, entry]) => objectKey(name, entry.hash));
}

/**
 * Keeps the live world and the newest `keep` worlds (by the upload time of worlds/<hash>.json), removes every other
 * world and the objects only removed worlds name. Objects no world names (left by an interrupted publish) stay.
 * With `delete: false` it only reports. Must not run while a publish is in progress: a world being published may
 * already count on an object that only a removed world names.
 */
export async function pruneWorlds(
  store: ObjectStore,
  o: { liveHash: string; keep: number; delete: boolean },
): Promise<{ keptWorlds: string[]; removedWorlds: string[]; removedObjects: string[] }> {
  if (!Number.isInteger(o.keep) || o.keep < 0) throw new Error(`keep must be a whole number ≥ 0, got ${o.keep}`);
  const worlds = (await store.list('worlds/'))
    .flatMap(({ key, lastModified }) => {
      const m = WORLD_KEY_RE.exec(key);
      return m ? [{ hash: m[1]!, lastModified }] : [];
    })
    // newest first; ties broken by hash so the result does not depend on listing order
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime() || (a.hash < b.hash ? -1 : 1));
  if (!worlds.some((w) => w.hash === o.liveHash)) {
    throw new Error(`live world ${o.liveHash} has no ${worldObjectKey(o.liveHash)} in the bucket`);
  }
  const newest = new Set(worlds.slice(0, o.keep).map((w) => w.hash));
  const keptWorlds = worlds.filter((w) => w.hash === o.liveHash || newest.has(w.hash)).map((w) => w.hash);
  const removedWorlds = worlds.filter((w) => !keptWorlds.includes(w.hash)).map((w) => w.hash);

  const kept = new Set<string>();
  for (const hash of keptWorlds) for (const key of await worldObjects(store, hash)) kept.add(key);
  const candidates = new Set<string>();
  for (const hash of removedWorlds) {
    for (const key of await worldObjects(store, hash)) if (!kept.has(key)) candidates.add(key);
  }
  // Only what is actually there (an earlier, interrupted prune may have removed some already).
  const removedObjects = (await store.list('objects/')).map((x) => x.key).filter((key) => candidates.has(key)).sort();

  if (o.delete) {
    // Objects first: should this stop halfway, the world files are still there and the next run removes the rest.
    if (removedObjects.length > 0) await store.delete(removedObjects);
    if (removedWorlds.length > 0) await store.delete(removedWorlds.map(worldObjectKey));
  }
  return { keptWorlds, removedWorlds, removedObjects };
}
