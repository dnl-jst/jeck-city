import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JOIN_PER_IP_PER_MIN, MAX_PLAYERS, RECONNECT_S, WEATHER_PRESETS, weatherPreset, type Weather } from '@nn/shared';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Dev-only network degradation: delay ms ± jitterMs per message, stallPct % of messages held back further. */
export type FakeLag = { ms: number; jitterMs: number; stallPct: number };

/** Where the weather comes from: Open-Meteo, nowhere (clear sky), or a fixed preset (dev only). */
export type WeatherSource = 'live' | 'off' | { fixed: Weather };

export type Config = {
  port: number;
  maxPlayers: number;
  /**
   * Colyseus' publicAddress: host[:port][/path] the clients open the game socket on, without a scheme (the client
   * adds ws:// or wss:// itself). From PUBLIC_URL, which may be given with https:// and a trailing slash. Not needed
   * when the clients reach the server on the address the page came from.
   */
  publicUrl: string | null;
  logLevel: LogLevel;
  /** NODE_ENV !== 'production': dev hooks (devTeleport, fake lag, client fly mode) allowed. */
  dev: boolean;
  /** Directory with manifest.json, collision.bin and terrain.bin. */
  worldDir: string;
  /** Built client to serve (apps/client/dist), or null when there is none. */
  clientDir: string | null;
  fakeLag: FakeLag | null;
  /** Seconds a dropped player keeps their figure and car . */
  reconnectS: number;
  /** Joins allowed per address in a sliding 60 s window; NN_JOIN_PER_MIN raises it, in dev only (load test: all bots share one address). */
  joinPerMin: number;
  weather: WeatherSource;
};

type Env = Record<string, string | undefined>;

/** Highest MAX_PLAYERS accepted from the environment (the default is MAX_PLAYERS = 60, sized for 2 vCPU). */
export const PLAYER_LIMIT = 100;

const repoPath = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/** apps/client/dist/world (built client) if it exists, else apps/client/public/world (pipeline output). */
function defaultWorldDir(): string {
  const dist = repoPath('apps/client/dist/world');
  return existsSync(`${dist}/manifest.json`) ? dist : repoPath('apps/client/public/world');
}

/** apps/client/dist if it has been built. */
function defaultClientDir(): string | null {
  const dist = repoPath('apps/client/dist');
  return existsSync(`${dist}/index.html`) ? dist : null;
}

function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}, got "${raw}"`);
  return n;
}

/** NN_FAKE_LAG = "ms,jitter,stallPct", e.g. "80,20,1". */
function parseFakeLag(raw: string): FakeLag {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  const [ms, jitterMs, stallPct] = parts;
  if (parts.length !== 3 || !parts.every((v) => Number.isFinite(v) && v >= 0) || stallPct! > 100) {
    throw new Error(`NN_FAKE_LAG must be "ms,jitter,stallPct", got "${raw}"`);
  }
  return { ms: ms!, jitterMs: jitterMs!, stallPct: stallPct! };
}

/** NN_WEATHER = live | off | a preset name; presets are dev-only (production falls back to live). */
function parseWeather(raw: string | undefined, dev: boolean): WeatherSource {
  if (!raw || raw === 'live') return 'live';
  if (raw === 'off') return 'off';
  const fixed = weatherPreset(raw);
  if (!fixed) throw new Error(`NN_WEATHER must be one of live|off|${WEATHER_PRESETS.join('|')}, got "${raw}"`);
  return dev ? { fixed } : 'live';
}

/** Server configuration from environment variables; `overrides` (tests) win over the environment. */
export function loadConfig(env: Env = process.env, overrides: Partial<Config> = {}): Config {
  const logLevel = (env.LOG_LEVEL || 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}, got "${env.LOG_LEVEL}"`);
  const dev = env.NODE_ENV !== 'production';
  return {
    port: intEnv(env, 'PORT', 2567, 0, 65535),
    maxPlayers: intEnv(env, 'MAX_PLAYERS', MAX_PLAYERS, 1, PLAYER_LIMIT),
    publicUrl: env.PUBLIC_URL ? env.PUBLIC_URL.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '') || null : null,
    logLevel,
    dev,
    worldDir: env.NN_WORLD_DIR || defaultWorldDir(),
    clientDir: env.NN_CLIENT_DIR || defaultClientDir(),
    fakeLag: dev && env.NN_FAKE_LAG ? parseFakeLag(env.NN_FAKE_LAG) : null,
    reconnectS: RECONNECT_S,
    joinPerMin: dev ? intEnv(env, 'NN_JOIN_PER_MIN', JOIN_PER_IP_PER_MIN, 1, 100_000) : JOIN_PER_IP_PER_MIN,
    weather: parseWeather(env.NN_WEATHER, dev),
    ...overrides,
  };
}
