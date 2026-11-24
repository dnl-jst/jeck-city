import { expect, it } from 'vitest';
import { reloadWhenRestarted, restartPending, type ReloadDeps } from './restart-reload';

/** A fake clock driven by `sleep`; `answers` are the /healthz replies in order (the last one repeats). */
function fake(answers: unknown[], random = 0) {
  let t = 0;
  const log: { at: number; what: string }[] = [];
  let reloads = 0;
  let i = 0;
  const deps: ReloadDeps = {
    lastServerTick: 50_000,
    fetchHealth: async () => {
      const a = answers[Math.min(i++, answers.length - 1)];
      log.push({ at: t, what: 'poll' });
      return a as { ticks: number } | null;
    },
    reload: () => {
      reloads++;
      log.push({ at: t, what: 'reload' });
    },
    sleep: async (ms) => { t += ms; },
    random: () => random,
    now: () => t,
  };
  return { deps, log, reloads: () => reloads };
}

it('polls every 2 s and reloads once /healthz reports fewer ticks than the old server had', async () => {
  const f = fake([null, null, { ticks: 50_400 }, { ticks: 120 }]);
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(true);
  expect(f.reloads()).toBe(1);
  expect(f.log.filter((e) => e.what === 'poll').map((e) => e.at)).toEqual([0, 2000, 4000, 6000]);
});

it('waits a random 0–5 s before reloading', async () => {
  const f = fake([{ ticks: 120 }], 0.5);
  await reloadWhenRestarted(f.deps);
  const poll = f.log.find((e) => e.what === 'poll')!, reload = f.log.find((e) => e.what === 'reload')!;
  expect(reload.at - poll.at).toBe(2500);
});

it('gives up after 180 s without reloading and resolves false', async () => {
  const f = fake([null]);
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(false);
  expect(f.reloads()).toBe(0);
  const polls = f.log.filter((e) => e.what === 'poll');
  expect(polls.length).toBe(90);
  expect(polls[polls.length - 1]!.at).toBeLessThan(180_000);
});

it('a health answer without a numeric ticks field counts as no answer', async () => {
  const f = fake([{ players: 0 }, { ticks: '12' }, { ticks: Number.NaN }]);
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(false);
  expect(f.reloads()).toBe(0);
});

it('an answer just below the last known tick is still the old server (estimate runs ahead): no reload', async () => {
  const f = fake([{ ticks: 49_999 }, { ticks: 49_701 }]);
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(false);
  expect(f.reloads()).toBe(0);
});

it('an answer more than 5 s of ticks below the last known tick is a new server', async () => {
  const f = fake([{ ticks: 49_699 }]);
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(true);
});

it('a failing health request counts as no answer', async () => {
  const f = fake([{ ticks: 120 }]);
  let first = true;
  const inner = f.deps.fetchHealth;
  f.deps.fetchHealth = () => (first ? ((first = false), Promise.reject(new Error('down'))) : inner());
  await expect(reloadWhenRestarted(f.deps)).resolves.toBe(true);
  expect(f.log.find((e) => e.what === 'reload')!.at).toBe(2000);
});

it('restartPending: an announced restart tick with a synced clock counts, also when the tick is already past', () => {
  expect(restartPending(undefined, true)).toBe(false);
  expect(restartPending(0, true)).toBe(false);
  expect(restartPending(54_000, true)).toBe(true); // whether the tick lies ahead or behind does not matter
  expect(restartPending(54_000, false)).toBe(false);
});
