import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logMod from './log';
import { WeatherService, WEATHER_EVERY_MS, WEATHER_RETRY_MS, WEATHER_TIMEOUT_MS } from './weather';

const SAMPLE = {
  current: { temperature_2m: 8, weather_code: 63, cloud_cover: 100, precipitation: 0.6, visibility: 6000, wind_speed_10m: 12, wind_direction_10m: 240 },
};

describe('WeatherService', () => {
  let warn: { mock: { calls: unknown[][] } };
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(logMod, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const make = (fetchJson: (s: AbortSignal) => Promise<unknown>) => {
    const onUpdate = vi.fn();
    const svc = new WeatherService({ onUpdate, fetchJson, now: () => 123 });
    return { svc, onUpdate };
  };
  const warns = () => warn.mock.calls.filter((c) => c[0] === 'warn').length;

  it('polls immediately and delivers a valid sample', async () => {
    const fetchJson = vi.fn().mockResolvedValue(SAMPLE);
    const { svc, onUpdate } = make(fetchJson);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rain', updatedAt: 123 }));
    svc.stop();
  });

  it('next fetch after success is at +15 min', async () => {
    const fetchJson = vi.fn().mockResolvedValue(SAMPLE);
    const { svc } = make(fetchJson);
    svc.start();
    await vi.advanceTimersByTimeAsync(WEATHER_EVERY_MS - 1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it.each([
    ['rejection', () => Promise.reject(new Error('down'))],
    ['parse failure', () => Promise.resolve('<html>')],
  ])('%s: no update, retry at +5 min', async (_n, f) => {
    const fetchJson = vi.fn(f);
    const { svc, onUpdate } = make(fetchJson);
    svc.start();
    await vi.advanceTimersByTimeAsync(WEATHER_RETRY_MS - 1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(onUpdate).not.toHaveBeenCalled();
    svc.stop();
  });

  it('warns once per three failures in a row; success resets', async () => {
    let ok = false;
    const fetchJson = vi.fn(() => (ok ? Promise.resolve(SAMPLE) : Promise.reject(new Error('x'))));
    const { svc } = make(fetchJson);
    expect(await svc.pollOnce()).toBe(false);
    expect(await svc.pollOnce()).toBe(false);
    expect(warns()).toBe(0);
    expect(await svc.pollOnce()).toBe(false);
    expect(warns()).toBe(1);
    ok = true;
    expect(await svc.pollOnce()).toBe(true);
    ok = false;
    await svc.pollOnce();
    await svc.pollOnce();
    expect(warns()).toBe(1);
    await svc.pollOnce();
    expect(warns()).toBe(2);
  });

  it('aborts a hung fetch after 10 s and counts it as failure', async () => {
    let signal!: AbortSignal;
    const fetchJson = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<unknown>((_res, rej) => s.addEventListener('abort', () => rej(new Error('aborted'))));
    });
    const { svc, onUpdate } = make(fetchJson);
    svc.start();
    await vi.advanceTimersByTimeAsync(WEATHER_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(WEATHER_RETRY_MS - 1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(onUpdate).not.toHaveBeenCalled();
    svc.stop();
  });

  it('stop() cancels the pending timer', async () => {
    const fetchJson = vi.fn().mockResolvedValue(SAMPLE);
    const { svc } = make(fetchJson);
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    svc.stop();
    await vi.advanceTimersByTimeAsync(WEATHER_EVERY_MS * 2);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});
