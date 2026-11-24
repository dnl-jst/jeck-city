import { log } from './log';

/** How often the countdown checks whether players are still connected. */
const POLL_MS = 250;

export type RestartDeps = {
  /** Notice period in seconds (Config.restartNoticeS); 0 shuts down at once. */
  noticeS: number;
  players: () => number;
  /** Announces the restart to the players, `seconds` from now. */
  announce: (seconds: number) => void;
  shutdown: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Returns the signal handler: the first call announces the restart (if anyone is connected and noticeS > 0), waits the
 * notice period or until the last player has left, then shuts down; a second call shuts down at once.
 * `shutdown` runs only once.
 */
export function restartOnSignal(deps: RestartDeps): () => Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let signalled = false;
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!stopping) {
      log('info', 'shutting down');
      stopping = deps.shutdown();
    }
    return stopping;
  };
  return async () => {
    if (signalled) return shutdown();
    signalled = true;
    const players = deps.players();
    if (deps.noticeS > 0 && players > 0) {
      deps.announce(deps.noticeS);
      log('info', 'restart announced', { seconds: deps.noticeS, players });
      const totalMs = deps.noticeS * 1000;
      for (let waited = 0; waited < totalMs && !stopping && deps.players() > 0;) {
        const step = Math.min(POLL_MS, totalMs - waited);
        await sleep(step);
        waited += step;
      }
    }
    return shutdown();
  };
}
