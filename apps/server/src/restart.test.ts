import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logMod from './log';
import { restartOnSignal, type RestartDeps } from './restart';

/**
 * A fake clock: sleep(ms) advances `now` at once. `players` and `onSleep` see the clock, so a test can let players
 * leave or a second signal arrive at a given time.
 */
function harness(over: { noticeS?: number; players?: (now: number) => number; onSleep?: (now: number) => void } = {}) {
  let now = 0;
  const announced: number[] = [];
  const shutdownAt: number[] = [];
  const deps: RestartDeps = {
    noticeS: over.noticeS ?? 60,
    players: () => (over.players ? over.players(now) : 1),
    announce: (s) => { announced.push(s); },
    shutdown: async () => { shutdownAt.push(now); },
    sleep: async (ms) => {
      now += ms;
      over.onSleep?.(now);
    },
  };
  return { deps, announced, shutdownAt, now: () => now };
}

describe('restartOnSignal', () => {
  beforeEach(() => { vi.spyOn(logMod, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('announces, waits noticeS, then shuts down once', async () => {
    const h = harness();
    await restartOnSignal(h.deps)();
    expect(h.announced).toEqual([60]);
    expect(h.shutdownAt).toEqual([60_000]);
    expect(logMod.log).toHaveBeenCalledWith('info', 'restart announced', { seconds: 60, players: 1 });
    expect(logMod.log).toHaveBeenCalledWith('info', 'shutting down');
  });

  it('shuts down at once without players', async () => {
    const h = harness({ players: () => 0 });
    await restartOnSignal(h.deps)();
    expect(h.announced).toEqual([]);
    expect(h.shutdownAt).toEqual([0]);
  });

  it('shuts down as soon as the last player has left during the countdown', async () => {
    const h = harness({ players: (now) => (now < 10_000 ? 2 : 0) });
    await restartOnSignal(h.deps)();
    expect(h.announced).toEqual([60]);
    expect(h.shutdownAt).toEqual([10_000]);
  });

  it('a second signal during the countdown shuts down at once, and shutdown still runs only once', async () => {
    let second: Promise<void> | undefined;
    let handler: () => Promise<void> = async () => {};
    const h = harness({ onSleep: (now) => { if (now === 5_000) second = handler(); } });
    handler = restartOnSignal(h.deps);
    await handler();
    await second;
    expect(second).toBeDefined();
    expect(h.announced).toEqual([60]);
    expect(h.shutdownAt).toEqual([5_000]);
  });

  it('noticeS 0 shuts down at once', async () => {
    const h = harness({ noticeS: 0 });
    await restartOnSignal(h.deps)();
    expect(h.announced).toEqual([]);
    expect(h.shutdownAt).toEqual([0]);
  });
});
