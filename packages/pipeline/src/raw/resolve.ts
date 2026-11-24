import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { contentHash } from '../worldindex.js';
import { RAW_UPDATE_HINT, rawKey, type RawLock } from './lock.js';

/** Whether `path` is a file with exactly the pinned content (size first: a wrong size needs no hashing). */
async function matches(path: string, want: { hash: string; bytes: number }): Promise<boolean> {
  try {
    if ((await stat(path)).size !== want.bytes) return false;
  } catch {
    return false;
  }
  return contentHash(await readFile(path)) === want.hash;
}

/** Makes every file of the lock present under `dir` with the right content; never asks an origin server. */
export async function ensureRawFiles(lock: RawLock, dir: string, o: { fetchFn?: typeof fetch; log?: (line: string) => void } = {}): Promise<void> {
  const { fetchFn = fetch, log = console.log } = o;
  const paths = Object.keys(lock.files).sort();
  let fetched = 0;
  for (const path of paths) {
    const want = lock.files[path]!;
    const file = join(dir, path);
    if (await matches(file, want)) continue;
    const fail = (why: string) => new Error(`raw data: ${path} ${why}. Run \`${RAW_UPDATE_HINT}\` to refresh data/raw and the lock.`);
    if (!lock.mirror) throw fail('is missing or does not match the lock, and the lock names no mirror');
    const url = lock.mirror + rawKey(path, want.hash);
    log(`raw: ${path} ← ${url}`);
    let data: Uint8Array;
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw fail(`is missing or does not match the lock, and the mirror answers HTTP ${res.status} for ${url}`);
      data = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('raw data: ')) throw err;
      throw fail(`could not be fetched from ${url} (${err instanceof Error ? err.message : String(err)})`);
    }
    const got = contentHash(data);
    if (got !== want.hash) throw fail(`from the mirror has hash ${got}, the lock pins ${want.hash}`);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.part`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    fetched++;
  }
  log(`raw: ${paths.length} files match the lock (${fetched} fetched from the mirror)`);
}
