import { TICK_HZ } from '@nn/shared';

/** Shown while the client waits for the restarted server (after an announced restart). */
export const RESTART_TEXT = 'Die Stadt wird aktualisiert …';

/** /healthz is polled this often. */
const POLL_MS = 2000;
/** Without a restarted server for this long the wait is given up. */
const GIVE_UP_MS = 180_000;
/** The reload waits a random 0..this long, so not every client hits the new server at the same moment. */
const JITTER_MS = 5000;
/**
 * A new server must report at least this many ticks (5 s) fewer than the client last estimated: the estimate is
 * fractional and extrapolated, so it can run a little ahead of the old server's integer tick, and the dying old
 * server may still answer the first poll. Any new server starts near 0. Not told apart: a server restarted less than
 * 5 s after a client joined a server that was itself under 5 s old (acceptable).
 */
const NEW_SERVER_MARGIN_TICKS = 5 * TICK_HZ;

/**
 * Whether the server had announced a restart, judged when the connection drops from the live state (a hidden tab
 * renders no frames, so nothing the render loop saw is current). The announced tick may already be past by then.
 */
export function restartPending(restartTick: number | undefined, clockReady: boolean): boolean {
  return clockReady && !!restartTick && restartTick > 0;
}

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
 * After an announced restart: polls /healthz until a server answers with clearly fewer ticks than the old one had (a
 * new server; the old one, still counting, never does), then reloads the page after a random delay.
 * true: reloaded; false: given up after 3 minutes.
 */
export async function reloadWhenRestarted(deps: ReloadDeps): Promise<boolean> {
  const now = deps.now ?? (() => performance.now());
  const random = deps.random ?? Math.random;
  const start = now();
  while (now() - start < GIVE_UP_MS) {
    const health: unknown = await deps.fetchHealth().catch(() => null);
    const ticks = (health as { ticks?: unknown } | null)?.ticks;
    if (typeof ticks === 'number' && Number.isFinite(ticks) && ticks < deps.lastServerTick - NEW_SERVER_MARGIN_TICKS) {
      await deps.sleep(random() * JITTER_MS);
      deps.reload();
      return true;
    }
    await deps.sleep(POLL_MS);
  }
  return false;
}
