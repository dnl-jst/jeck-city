/** Shown while the client waits for the restarted server (after an announced restart). */
export const RESTART_TEXT = 'Die Stadt wird aktualisiert …';

/** /healthz is polled this often. */
const POLL_MS = 2000;
/** Without a restarted server for this long the wait is given up. */
const GIVE_UP_MS = 180_000;
/** The reload waits a random 0..this long, so not every client hits the new server at the same moment. */
const JITTER_MS = 5000;

export type ReloadDeps = {
  /** The last server tick the client knew of the old server. */
  lastServerTick: number;
  fetchHealth: () => Promise<{ ticks: number } | null>;
  reload: () => void;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

/**
 * After an announced restart: polls /healthz until a server answers with fewer ticks than the old one had (a new
 * server; the old one, still counting, never does), then reloads the page after a random delay.
 * true: reloaded; false: given up after 3 minutes.
 */
export async function reloadWhenRestarted(deps: ReloadDeps): Promise<boolean> {
  const now = deps.now ?? (() => performance.now());
  const random = deps.random ?? Math.random;
  const start = now();
  while (now() - start < GIVE_UP_MS) {
    const health: unknown = await deps.fetchHealth().catch(() => null);
    const ticks = (health as { ticks?: unknown } | null)?.ticks;
    if (typeof ticks === 'number' && Number.isFinite(ticks) && ticks < deps.lastServerTick) {
      await deps.sleep(random() * JITTER_MS);
      deps.reload();
      return true;
    }
    await deps.sleep(POLL_MS);
  }
  return false;
}
