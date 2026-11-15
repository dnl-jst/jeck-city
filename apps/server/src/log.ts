import { createHash, randomBytes } from 'node:crypto';
import { LOG_LEVELS, type LogLevel } from './config';

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** One JSON line on stdout ({ t, level, msg, ...fields }), dropped below the configured level. */
export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(minLevel)) return;
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

/** Salt for ipHash, new on every process start: hashes cannot be joined across restarts or reversed by lookup. */
const SALT = randomBytes(16);

/** First 8 hex digits of the salted SHA-256 of an address: what logs and the join limiter use instead of the IP. */
export function ipHash(ip: string | undefined): string {
  return createHash('sha256').update(SALT).update(ip ?? '').digest('hex').slice(0, 8);
}
