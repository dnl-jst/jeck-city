import { randomBytes } from 'node:crypto';
import { rmSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A run folder untouched for this long is removed even if a process with its pid is alive (the pid may have been
 * reused by another process after the run died).
 */
export const STALE_RUN_MS = 24 * 3600 * 1000;
/** The name of a run folder: `<pid>-<8 hex>`. */
const RUN_DIR = /^(\d+)-[0-9a-f]{8}$/;

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * Whether a process with this pid may be alive: false only if `process.kill(pid, 0)` says ESRCH (no such process).
 * EPERM (alive, owned by another user) and any other answer count as alive. The current process is alive; pids ≤ 1
 * (and anything not a plain pid) are never signalled and count as alive too.
 */
export function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

/** The part of `process` withRunDir uses for its signal handlers (injectable for tests). */
export type SignalProcess = {
  readonly pid: number;
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
};

/** The signals on which a run removes its folder before it ends. */
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Runs fn in a work folder of its own, `<root>/<pid>-<random>/` (two runs at once, e.g. `--out a` and `--out b`,
 * never share one), removed when fn ends, also when it throws, and on SIGINT/SIGTERM while fn runs (the folder is
 * removed synchronously, then the signal is raised again with the handlers gone, so the process ends as it would
 * have). First removes what earlier runs left behind under `root`, by name only: folders named `<pid>-<8 hex>` whose
 * pid is no longer alive (`isAlive`), and those untouched for STALE_RUN_MS whatever their pid. Anything else stays.
 * A root that is a symbolic link (or empty) is refused before anything is deleted.
 */
export async function withRunDir<T>(root: string, fn: (dir: string) => Promise<T>,
  o: { isAlive?: (pid: number) => boolean; proc?: SignalProcess } = {}): Promise<T> {
  const isAlive = o.isAlive ?? pidAlive;
  const proc: SignalProcess = o.proc ?? process;
  if (!root) throw new Error('terrain work folder: the root is empty');
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error(`terrain work folder: ${root} is a symbolic link; refusing to clean up or write there`);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  await mkdir(root, { recursive: true });
  const now = Date.now();
  for (const name of await readdir(root)) {
    const run = RUN_DIR.exec(name);
    if (!run) continue;
    const p = join(root, name);
    try {
      const s = await lstat(p); // (a symbolic link is no directory: never followed, never removed)
      if (s.isDirectory() && (!isAlive(Number(run[1])) || now - s.mtimeMs > STALE_RUN_MS)) await rm(p, { recursive: true, force: true });
    } catch (err) {
      if (!isEnoent(err)) throw err; // (ENOENT: removed meanwhile by another run's cleanup)
    }
  }
  const dir = join(root, `${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir);
  const onSignal = (signal: NodeJS.Signals) => {
    detach();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`terrain work folder: could not remove ${dir} on ${signal}: ${err instanceof Error ? err.message : String(err)}`);
    }
    proc.kill(proc.pid, signal); // (no handler of ours left: the process ends the way the signal ends it)
  };
  const detach = () => {
    for (const s of SIGNALS) proc.off(s, onSignal);
  };
  for (const s of SIGNALS) proc.on(s, onSignal);
  try {
    return await fn(dir);
  } finally {
    detach();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      // (never in place of fn's own result or error: the next run's cleanup takes the folder once its pid is gone)
      console.error(`terrain work folder: could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Removes a file a run wrote into its own work folder (`dir`, as withRunDir handed it out). Refuses any path that is
 * not directly inside `dir`, and any `dir` that is not named like a run folder.
 */
export function unlinkRunFile(dir: string, path: string): void {
  if (!RUN_DIR.test(basename(dir))) throw new Error(`terrain work folder: ${dir} is not a run folder`);
  if (dirname(resolve(path)) !== resolve(dir)) throw new Error(`terrain work folder: ${path} is not a file of ${dir}`);
  unlinkSync(path);
}
