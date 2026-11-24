import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { s3Store } from './publish/s3.js';
import { parseRawLock, RAW_LOCK_FILE } from './raw/lock.js';
import { RAW_SOURCES, updateRaw, type RawSource } from './raw/update.js';

/**
 * `npm run raw:update [-- osm] [tiles] [gtfs]` (no argument: all): fetches those sources anew from the origin servers
 * into data/raw, uploads every raw file the mirror lacks (with S3_* in the environment, see .env) and writes
 * data/raw.lock.json. The mirror's public base URL comes from RAW_MIRROR_URL, else the lock's.
 */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !RAW_SOURCES.includes(a as RawSource));
  if (unknown.length) throw new Error(`raw:update: unknown source ${unknown.join(', ')} (known: ${RAW_SOURCES.join(', ')})`);
  const what = args.length ? (args as RawSource[]) : [...RAW_SOURCES];
  const env = process.env;
  // with any S3_* variable set, all are required (s3Store names the missing ones, never a value)
  const store = Object.keys(env).some((k) => k.startsWith('S3_')) ? s3Store(env) : null;
  const lockMirror = existsSync(RAW_LOCK_FILE) ? parseRawLock(JSON.parse(readFileSync(RAW_LOCK_FILE, 'utf8'))).mirror : null;
  const lock = await updateRaw({ dir: 'data/raw', lockFile: RAW_LOCK_FILE, what, store, mirror: env.RAW_MIRROR_URL || lockMirror });
  console.log(`raw:update: ${Object.keys(lock.files).length} files pinned, mirror ${lock.mirror ?? 'none'}, sample days ${lock.gtfsDays?.join(', ') ?? 'none'}`);
}
