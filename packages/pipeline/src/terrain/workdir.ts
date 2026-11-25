import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** A run folder untouched for this long belongs to a run that died (killed, power cut) and is removed. */
export const STALE_RUN_MS = 24 * 3600 * 1000;

/**
 * Runs fn in a work folder of its own, `<root>/<pid>-<random>/` (two runs at once, e.g. `--out a` and `--out b`,
 * never share one), removed when fn ends, also when it throws. First removes what earlier runs left behind under
 * `root`: run folders untouched for STALE_RUN_MS (younger ones may belong to a run still going) and plain files (the
 * flat layout before run folders, emptied at every start).
 */
export async function withRunDir<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const now = Date.now();
  for (const name of await readdir(root)) {
    const p = join(root, name);
    try {
      const s = await lstat(p);
      if (!s.isDirectory() || now - s.mtimeMs > STALE_RUN_MS) await rm(p, { recursive: true, force: true });
    } catch { /* removed meanwhile by another run's cleanup */ }
  }
  const dir = join(root, `${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
