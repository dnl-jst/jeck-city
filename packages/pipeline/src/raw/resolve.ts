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

/** Attempts per file when the mirror cannot be reached (network error or HTTP 5xx), and the pause between them (ms). */
const MIRROR_ATTEMPTS = 3, MIRROR_PAUSE = 2000;

/**
 * Makes every file of the lock present under `dir` with the right content; never asks an origin server. A mirror that
 * cannot be reached is retried, then fails with "try again later": the lock is fine, raw:update would not help. A
 * missing object (404) or wrong content points to raw:update.
 */
export async function ensureRawFiles(lock: RawLock, dir: string, o: { fetchFn?: typeof fetch; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { fetchFn = fetch, log = console.log, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = o;
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
    let data: Uint8Array | null = null, trouble = '';
    for (let attempt = 1; attempt <= MIRROR_ATTEMPTS && !data; attempt++) {
      if (attempt > 1) await sleep(MIRROR_PAUSE);
      try {
        const res = await fetchFn(url);
        if (res.status >= 500) { trouble = `HTTP ${res.status}`; continue; }
        if (!res.ok) throw fail(`is missing or does not match the lock, and the mirror answers HTTP ${res.status} for ${url}`);
        data = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('raw data: ')) throw err;
        trouble = err instanceof Error ? err.message : String(err);
      }
    }
    if (!data) throw new Error(`raw data: ${path}: mirror unreachable (${trouble} for ${url}, ${MIRROR_ATTEMPTS} attempts) — try again later; do NOT run raw:update`);
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
