import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { DGM_TILES, LOD2_TILES, TRANSIT_ROUTES_FILE } from '../fetch.js';

/** The pinned raw data: which content each input file of the pipeline must have, and where to get it. */
export type RawLock = {
  version: 1;
  /** Public base URL of the mirror, with trailing slash; null: no mirror (local files only). */
  mirror: string | null;
  /** Logical path under data/raw → content hash and size, sorted by path. */
  files: Record<string, { hash: string; bytes: number }>;
  /** Sample days of the timetable as yyyymmdd: a weekday, a Saturday, a Sunday (Task 3). */
  gtfsDays?: [number, number, number];
};

/** Where the lock lives, relative to the repository root. */
export const RAW_LOCK_FILE = 'data/raw.lock.json';
/** The command that refreshes raw data and lock; every error about a raw file names it. */
export const RAW_UPDATE_HINT = 'npm run raw:update';

const HASH_RE = /^[0-9a-f]{32}$/;
/** A mirror's public base URL: http(s), with trailing slash. */
export const MIRROR_RE = /^https?:\/\/.+\/$/;
/** Forward-slash segments, no empty, '.' or '..' segment, no leading slash. */
const PATH_RE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^/\\]+(?:\/[^/\\]+)*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseRawLock(json: unknown): RawLock {
  if (!isRecord(json)) throw new Error('raw lock: not an object');
  if (json.version !== 1) throw new Error(`raw lock: unknown version ${JSON.stringify(json.version)}`);
  const { mirror } = json;
  if (mirror !== null && (typeof mirror !== 'string' || !MIRROR_RE.test(mirror))) {
    throw new Error(`raw lock: mirror must be null or an http(s) URL with trailing slash, got ${JSON.stringify(mirror)}`);
  }
  if (!isRecord(json.files)) throw new Error('raw lock: files must be an object');
  const files: RawLock['files'] = {};
  for (const [path, e] of Object.entries(json.files)) {
    if (!PATH_RE.test(path)) throw new Error(`raw lock: bad path ${JSON.stringify(path)}`);
    if (!isRecord(e) || typeof e.hash !== 'string' || !HASH_RE.test(e.hash)) throw new Error(`raw lock: ${path}: hash must be 32 lowercase hex characters`);
    if (typeof e.bytes !== 'number' || !Number.isSafeInteger(e.bytes) || e.bytes < 0) throw new Error(`raw lock: ${path}: bytes must be a non-negative integer`);
    files[path] = { hash: e.hash, bytes: e.bytes };
  }
  const lock: RawLock = { version: 1, mirror, files };
  if (json.gtfsDays !== undefined) {
    const d = json.gtfsDays;
    if (!Array.isArray(d) || d.length !== 3 || !d.every((x) => Number.isInteger(x) && x >= 19700101 && x <= 99991231)) {
      throw new Error(`raw lock: gtfsDays must be three yyyymmdd numbers, got ${JSON.stringify(d)}`);
    }
    lock.gtfsDays = [d[0], d[1], d[2]];
  }
  return lock;
}

/** The mirror's object key of a raw file: 'raw/<first two hash chars>/<hash><extension of the path>'. */
export function rawKey(path: string, hash: string): string {
  return `raw/${hash.slice(0, 2)}/${hash}${extname(path)}`;
}

/** The timetable's logical path: VRS's GTFS feed as downloaded (GTFS_URL in gtfs.ts). */
export const GTFS_ZIP = 'gtfs.zip';

/** The pinned timetable (the feed's hash and the sample days); throws, naming `raw:update -- gtfs`, if the lock lacks either. */
export function requireTimetable(lock: RawLock, file: string = RAW_LOCK_FILE): { hash: string; days: [number, number, number] } {
  const zip = lock.files[GTFS_ZIP];
  if (!zip || !lock.gtfsDays) {
    throw new Error(`${file} pins no timetable (${zip ? 'gtfsDays' : GTFS_ZIP} missing). Run \`${RAW_UPDATE_HINT} -- gtfs\`.`);
  }
  return { hash: zip.hash, days: lock.gtfsDays };
}

/** The logical paths every pipeline run reads (besides the timetable, see requireTimetable). */
export function pipelineRawPaths(): string[] {
  return ['osm.json', TRANSIT_ROUTES_FILE, ...LOD2_TILES.map((t) => `lod2/${t}`), ...DGM_TILES.map((t) => `dgm1/${t}`)];
}

/** Reads and checks the lock; rejects if it lacks a file the pipeline reads (before any work is done). */
export async function readRawLock(path: string = RAW_LOCK_FILE): Promise<RawLock> {
  const lock = parseRawLock(JSON.parse(await readFile(path, 'utf8')));
  const missing = pipelineRawPaths().filter((p) => !(p in lock.files));
  if (missing.length) {
    throw new Error(`${path} lacks ${missing.length} file(s) the pipeline needs: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}. Run \`${RAW_UPDATE_HINT}\`.`);
  }
  return lock;
}
