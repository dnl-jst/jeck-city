import { OPEN_METEO_URL, parseOpenMeteo, type Weather } from '@nn/shared';
import { log } from './log';

export const WEATHER_EVERY_MS = 15 * 60_000;
export const WEATHER_RETRY_MS = 5 * 60_000;
export const WEATHER_TIMEOUT_MS = 10_000;
/** Consecutive failures after which one warning is logged. */
const WARN_AFTER = 3;

/** GETs the Open-Meteo "current" document for Cologne; rejects on HTTP errors or when `signal` aborts. */
export async function fetchOpenMeteo(signal: AbortSignal): Promise<unknown> {
  const res = await fetch(OPEN_METEO_URL, { signal, headers: { 'user-agent': 'nippes-nights' } });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

/** Polls the weather every 15 min (retry after 5 min on failure) and hands valid samples to `onUpdate`. */
export class WeatherService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private readonly stopper = new AbortController();
  private readonly onUpdate: (w: Weather) => void;
  private readonly fetchJson: (signal: AbortSignal) => Promise<unknown>;
  private readonly now: () => number;

  constructor(opts: { onUpdate(w: Weather): void; fetchJson?: (signal: AbortSignal) => Promise<unknown>; now?: () => number }) {
    this.onUpdate = opts.onUpdate;
    this.fetchJson = opts.fetchJson ?? fetchOpenMeteo;
    this.now = opts.now ?? Date.now;
  }

  /** First poll immediately (not awaited), then reschedules itself. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.cycle();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopper.abort();
  }

  /** One fetch; true when a valid weather was delivered. */
  async pollOnce(): Promise<boolean> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('weather fetch timed out')), WEATHER_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout.signal, this.stopper.signal]);
    try {
      const weather = parseOpenMeteo(await this.fetchJson(signal), this.now());
      if (!weather) throw new Error('unusable Open-Meteo response');
      this.failures = 0;
      log('info', 'weather', { kind: weather.kind, temperature: weather.temperature });
      this.onUpdate(weather);
      return true;
    } catch (error) {
      this.failures++;
      if (this.failures === WARN_AFTER) {
        log('warn', 'weather fetch failing', { failures: this.failures, error: error instanceof Error ? error.message : String(error) });
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async cycle(): Promise<void> {
    const ok = await this.pollOnce();
    if (!this.running) return;
    this.timer = setTimeout(() => void this.cycle(), ok ? WEATHER_EVERY_MS : WEATHER_RETRY_MS);
  }
}
