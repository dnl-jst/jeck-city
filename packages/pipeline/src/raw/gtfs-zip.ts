import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openPromise, type Entry } from 'yauzl';
import { GTFS_TABLES } from '../gtfs.js';

/** Where the build unpacks the pinned feed, one folder per feed hash. */
export const GTFS_CACHE_DIR = 'data/cache/gtfs';

/** Calls `fn` for each file entry of the zip in order; `open` streams the entry's uncompressed bytes (never all at once). */
async function eachEntry(zip: string, fn: (entry: Entry, open: () => Promise<Readable>) => Promise<void>): Promise<void> {
  const file = await openPromise(zip, { lazyEntries: true, strictFileNames: true });
  try {
    for await (const entry of file.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue;
      await fn(entry, () => file.openReadStreamPromise(entry));
    }
  } finally {
    file.close();
  }
}

/** The names of all file entries of the zip. */
export async function zipEntryNames(zip: string): Promise<string[]> {
  const names: string[] = [];
  await eachEntry(zip, async (entry) => { names.push(entry.fileName); });
  return names;
}

/** The text (UTF-8) of the entry `name`, null if the zip has none; for small entries only. */
export async function readZipText(zip: string, name: string): Promise<string | null> {
  let text: string | null = null;
  await eachEntry(zip, async (entry, open) => {
    if (entry.fileName !== name) return;
    const parts: Buffer[] = [];
    for await (const chunk of await open()) parts.push(chunk as Buffer);
    text = Buffer.concat(parts).toString('utf8');
  });
  return text;
}

/**
 * Unpacks the tables of GTFS_TABLES from the feed `zip` (content hash `hash`) into `<root>/<hash>/` and returns that
 * folder. Done once: an existing folder is complete (it is renamed into place last) and returned as is. Folders of
 * other feeds under `root` are removed (stop_times.txt alone has 400 MB).
 */
export async function unpackGtfs(zip: string, hash: string, root: string = GTFS_CACHE_DIR): Promise<string> {
  const out = join(root, hash);
  if (existsSync(out)) return out;
  const tmp = `${out}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const found = new Set<string>();
    await eachEntry(zip, async (entry, open) => {
      if (!GTFS_TABLES.includes(entry.fileName) || found.has(entry.fileName)) return;
      await pipeline(await open(), createWriteStream(join(tmp, entry.fileName)));
      found.add(entry.fileName);
    });
    const missing = GTFS_TABLES.filter((t) => !found.has(t));
    if (missing.length) throw new Error(`gtfs: ${zip} lacks ${missing.join(', ')}`);
    for (const other of await readdir(root)) if (other !== `${hash}.part`) await rm(join(root, other), { recursive: true, force: true });
    await rename(tmp, out);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return out;
}
