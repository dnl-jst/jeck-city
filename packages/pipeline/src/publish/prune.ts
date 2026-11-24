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

/** Objects uploaded more recently than this are never removed: a publish may still be running for them. */
export const RECENT_MS = 24 * 3600_000;

/**
 * Keeps the live world and the newest `keep` worlds (by the upload time of worlds/<hash>.json), removes every other
 * world and every object no kept world names (also orphans left by an interrupted publish).
 * With `delete: false` it only reports. Objects younger than 24 h (relative to `now`) are kept and listed in
 * `skippedRecent`: a publish in progress has uploaded them but no world names them yet.
 */
export async function pruneWorlds(
  store: ObjectStore,
  o: { liveHash: string; keep: number; delete: boolean; now?: Date },
): Promise<{ keptWorlds: string[]; removedWorlds: string[]; removedObjects: string[]; skippedRecent: string[] }> {
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
  // Every object no kept world names, including orphans an interrupted publish left behind.
  const unnamed = (await store.list('objects/')).filter((x) => !kept.has(x.key));
  const cutoff = (o.now ?? new Date()).getTime() - RECENT_MS;
  const removedObjects = unnamed.filter((x) => x.lastModified.getTime() <= cutoff).map((x) => x.key).sort();
  const skippedRecent = unnamed.filter((x) => x.lastModified.getTime() > cutoff).map((x) => x.key).sort();

  if (o.delete) {
    // World files first: should this stop halfway, no world file is left naming deleted objects; the objects that
    // remain are orphans the next run removes.
    if (removedWorlds.length > 0) await store.delete(removedWorlds.map(worldObjectKey));
    if (removedObjects.length > 0) await store.delete(removedObjects);
  }
  return { keptWorlds, removedWorlds, removedObjects, skippedRecent };
}
