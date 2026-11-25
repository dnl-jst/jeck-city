import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** A run folder untouched for this long belongs to a run that died (killed, power cut) and is removed. */
export const STALE_RUN_MS = 24 * 3600 * 1000;
/** The name of a run folder: `<pid>-<8 hex>`. */
const RUN_DIR = /^\d+-[0-9a-f]{8}$/;
/** What the flat layout before run folders left in the root: the versions and their temporary and spool files. */
const FLAT_FILE = /^(t[0-3]\.bin|\..*\.(tmp|spool))$/;

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * Runs fn in a work folder of its own, `<root>/<pid>-<random>/` (two runs at once, e.g. `--out a` and `--out b`,
 * never share one), removed when fn ends, also when it throws. First removes what earlier runs left behind under
 * `root`, by name only: run folders untouched for STALE_RUN_MS (younger ones may belong to a run still going) and the
 * files of the flat layout before run folders (t0–t3.bin and their .tmp/.spool files). Anything else stays. A root
 * that is a symbolic link (or empty) is refused before anything is deleted.
 */
export async function withRunDir<T>(root: string, fn: (dir: string) => Promise<T>): Promise<T> {
  if (!root) throw new Error('terrain work folder: the root is empty');
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error(`terrain work folder: ${root} is a symbolic link; refusing to clean up or write there`);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await mkdir(root, { recursive: true });
  const now = Date.now();
  for (const name of await readdir(root)) {
    const p = join(root, name);
    try {
      const s = await lstat(p);
      const stale = s.isDirectory() ? RUN_DIR.test(name) && now - s.mtimeMs > STALE_RUN_MS : s.isFile() && FLAT_FILE.test(name);
      if (stale) await rm(p, { recursive: true, force: true });
    } catch (err) {
      if (!isEnoent(err)) throw err; // (ENOENT: removed meanwhile by another run's cleanup)
    }
  }
  const dir = join(root, `${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir);
  try {
    return await fn(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      // (never in place of fn's own result or error: the next run's cleanup takes the folder after a day)
      console.error(`terrain work folder: could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
