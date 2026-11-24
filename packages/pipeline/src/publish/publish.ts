import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import { objectKey, parseWorldIndex, WORLD_INDEX_FILE, worldHash, worldObjectKey } from '@nn/shared';
import { buildWorldIndex, contentHash } from '../worldindex.js';
import type { ObjectStore, PutMeta } from './store.js';

const compress = promisify(brotliCompress);

export const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const UPLOADS_IN_FLIGHT = 8;

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  // raw data in the mirror (raw/update.ts)
  '.gml': 'application/gml+xml',
  '.tif': 'image/tiff',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};

function contentType(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && CONTENT_TYPES[name.slice(dot)]) || 'application/octet-stream';
}

/** Brotli (quality 5) when that is smaller, the raw bytes otherwise; immutable caching, content type from `name`. */
export async function encode(raw: Uint8Array, name: string): Promise<{ body: Uint8Array; meta: PutMeta }> {
  const br = await compress(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength },
  });
  const meta: PutMeta = { contentType: contentType(name), cacheControl: CACHE_CONTROL };
  return br.byteLength < raw.byteLength ? { body: br, meta: { ...meta, contentEncoding: 'br' } } : { body: raw, meta };
}

/** Runs `fn` over `items` with at most `n` at a time; after the first failure no new item starts, then it rethrows. */
export async function inPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Uploads the world in `dir` (with an up-to-date index.json) to `store`: every file under its content-hash key
 * (objects already in the store are skipped, never overwritten), then worlds/<worldHash>.json, a copy of index.json,
 * last — a world is only listed once all its objects are there. Aborts before any upload when a file does not match
 * index.json.
 */
export async function publishWorld(
  dir: string,
  store: ObjectStore,
  log: (line: string) => void = () => {},
): Promise<{ worldHash: string; uploaded: number; uploadedBytes: number; present: number }> {
  let indexBytes: Buffer;
  try {
    indexBytes = await readFile(join(dir, WORLD_INDEX_FILE));
  } catch {
    throw new Error(`${join(dir, WORLD_INDEX_FILE)} missing; run npm run world:index`);
  }
  const index = parseWorldIndex(JSON.parse(indexBytes.toString('utf8')));
  const hash = await worldHash(new Uint8Array(indexBytes).buffer);

  // Check every file before the first upload: a stale index would publish a world that does not match its files.
  const actual = await buildWorldIndex(dir);
  const names = new Set([...Object.keys(index.files), ...Object.keys(actual.files)]);
  const stale = [...names].filter((name) => {
    const want = index.files[name];
    const got = actual.files[name];
    return !want || !got || want.hash !== got.hash || want.bytes !== got.bytes;
  });
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).join(', ') + (stale.length > 5 ? `, … (${stale.length} in all)` : '');
    throw new Error(`world folder does not match index.json (${shown}); run npm run world:index`);
  }

  // One file per object key: files with the same content (and extension) share one object.
  const byKey = new Map<string, string>();
  for (const [name, entry] of Object.entries(index.files)) {
    const key = objectKey(name, entry.hash);
    if (!byKey.has(key)) byKey.set(key, name);
  }
  const existing = new Set((await store.list('objects/')).map((o) => o.key));
  const missing = [...byKey].filter(([key]) => !existing.has(key));
  const present = byKey.size - missing.length;
  const rawMb = (entries: [string, string][]) =>
    `${(entries.reduce((sum, [, name]) => sum + index.files[name]!.bytes, 0) / 1e6).toFixed(1)} MB`;
  const presentEntries = [...byKey].filter(([key]) => existing.has(key));
  log(
    `world ${hash}: ${byKey.size} objects; ${present} already present (${rawMb(presentEntries)} uncompressed), ` +
      `${missing.length} to upload (${rawMb(missing)} uncompressed)`,
  );

  let uploaded = 0;
  let uploadedBytes = 0;
  await inPool(missing, UPLOADS_IN_FLIGHT, async ([key, name]) => {
    const raw = await readFile(join(dir, name));
    // The key is never overwritten: bytes that changed since the check would stay wrong for good.
    if (contentHash(raw) !== index.files[name]!.hash) {
      throw new Error(`${name} changed while publishing; run npm run world:index and publish again`);
    }
    const { body, meta } = await encode(raw, name);
    await store.put(key, body, meta);
    uploaded++;
    uploadedBytes += body.byteLength;
    if (uploaded % 100 === 0) log(`  ${uploaded}/${missing.length} uploaded`);
  });

  // List once more: the world file must never name an object that is not there.
  const stored = new Set((await store.list('objects/')).map((o) => o.key));
  const lost = [...byKey.keys()].filter((key) => !stored.has(key));
  if (lost.length > 0) {
    const shown = lost.slice(0, 5).join(', ') + (lost.length > 5 ? `, … (${lost.length} in all)` : '');
    throw new Error(`objects missing from the bucket after the upload (${shown}); not listing world ${hash}, publish again`);
  }

  const copy = await encode(indexBytes, WORLD_INDEX_FILE);
  await store.put(worldObjectKey(hash), copy.body, copy.meta);
  return { worldHash: hash, uploaded, uploadedBytes, present };
}
