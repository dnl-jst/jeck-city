import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { DGM_TILES, fetchDgmTiles, fetchGtfs, fetchLod2Tiles, fetchOsm, fetchTransitRoutes, LOD2_TILES, TRANSIT_ROUTES_FILE } from '../fetch.js';
import { GTFS_URL, gtfsCalendar, gtfsSampleDays } from '../gtfs.js';
import { encode, inPool } from '../publish/publish.js';
import type { ObjectStore } from '../publish/store.js';
import { contentHash } from '../worldindex.js';
import { readZipText, zipEntryNames } from './gtfs-zip.js';
import { GTFS_ZIP, parseRawLock, pipelineRawPaths, RAW_UPDATE_HINT, rawKey, type RawLock } from './lock.js';
import { ensureRawFiles } from './resolve.js';

/** What `npm run raw:update` can fetch anew from the origin servers. */
export type RawSource = 'osm' | 'tiles' | 'gtfs';
export const RAW_SOURCES: readonly RawSource[] = ['osm', 'tiles', 'gtfs'];

/** The logical paths (under data/raw) each source provides. */
const SOURCE_PATHS: Record<RawSource, () => string[]> = {
  osm: () => ['osm.json', TRANSIT_ROUTES_FILE],
  tiles: () => [...LOD2_TILES.map((t) => `lod2/${t}`), ...DGM_TILES.map((t) => `dgm1/${t}`)],
  gtfs: () => [GTFS_ZIP],
};

function sourceOf(path: string): RawSource | null {
  return RAW_SOURCES.find((s) => SOURCE_PATHS[s]().includes(path)) ?? null;
}

/** Downloads land here (inside data/raw, so they can be renamed into place) and move only once all of them are done. */
const STAGING = '.update';
/** The licence notice in the mirror, next to the raw objects. */
export const LICENSE_KEY = 'raw/LICENSE.txt';
const UPLOADS_IN_FLIGHT = 4;

/** Plain-text notice uploaded as raw/LICENSE.txt (sources and licences of the mirrored raw data). */
const LICENCE = `Rohdaten der Welt von Jeck City / Raw data of the Jeck City world

Unveränderte Kopien der Originaldaten. Die Objekte unter raw/ sind nach ihrem Inhalt benannt (SHA-256); welche Datei
welche ist, steht in data/raw.lock.json im Repository des Spiels.
Unmodified copies of the original data. The objects under raw/ are named by their content (SHA-256); which file is
which is listed in data/raw.lock.json in the game's repository.

lod2/*.gml (3D-Gebäudemodelle LoD2 / 3D building models) und dgm1/*.tif (Digitales Geländemodell DGM1 / terrain)
  Quelle / source: Geobasis NRW, https://www.opengeodata.nrw.de
  Lizenz / licence: Datenlizenz Deutschland – Zero – Version 2.0 (dl-de/zero-2.0), https://www.govdata.de/dl-de/zero-2-0

osm.json, transit-routes.json (OpenStreetMap)
  © OpenStreetMap-Mitwirkende / OpenStreetMap contributors, https://www.openstreetmap.org/copyright
  Lizenz / licence: Open Database License 1.0 (ODbL), https://opendatacommons.org/licenses/odbl/1-0/

gtfs.zip (Fahrplandaten / timetable data, GTFS)
  Quelle / source: Verkehrsverbund Rhein-Sieg (VRS), ${GTFS_URL}
  Lizenz / licence: Datenlizenz Deutschland – Zero – Version 2.0 (dl-de/zero-2.0) laut / according to
  https://www.vrs.de/fahren/fahrplanauskunft/opendata-/-openservice (geprüft / checked 2026-11-24)
`;

/** The licence notice; with the feed's own licence files (if it has any) appended. */
async function licenceText(zip: string | null): Promise<string> {
  let text = LICENCE;
  if (!zip) return text;
  for (const name of (await zipEntryNames(zip)).filter((n) => /(licen[cs]e|lizenz)[^/]*$/i.test(n))) {
    text += `\n--- ${name} (aus dem Feed / from the feed) ---\n${(await readZipText(zip, name))!.trim()}\n`;
  }
  return text;
}

/** The lock at `file`, or an empty one if there is none yet. */
async function readLockIfAny(file: string): Promise<RawLock> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, mirror: null, files: {} };
    throw err;
  }
  return parseRawLock(JSON.parse(text));
}

async function describe(path: string): Promise<{ hash: string; bytes: number }> {
  const data = await readFile(path);
  return { hash: contentHash(data), bytes: data.byteLength };
}

/** The bytes of a stored object, uncompressed. */
async function storedBytes(store: ObjectStore, key: string): Promise<Uint8Array> {
  const o = await store.get(key);
  return o.contentEncoding === 'br' ? new Uint8Array(brotliDecompressSync(o.body)) : o.body;
}

/**
 * Uploads every file of `files` (read from `where(path)`) the mirror lacks under its rawKey (Brotli when smaller,
 * immutable), and the licence notice if it changed. Objects already there are never overwritten. Rejects unless every
 * file's object is in the mirror afterwards.
 */
async function fillMirror(store: ObjectStore, files: RawLock['files'], where: (path: string) => string, licence: string, log: (line: string) => void): Promise<void> {
  const byKey = new Map<string, string>();
  for (const [path, e] of Object.entries(files)) if (!byKey.has(rawKey(path, e.hash))) byKey.set(rawKey(path, e.hash), path);
  const existing = new Set((await store.list('raw/')).map((o) => o.key));
  const missing = [...byKey].filter(([key]) => !existing.has(key));
  const mb = (missing.reduce((sum, [, path]) => sum + files[path]!.bytes, 0) / 1e6).toFixed(1);
  log(`mirror: ${byKey.size} raw files; ${byKey.size - missing.length} already there, ${missing.length} to upload (${mb} MB uncompressed)`);
  let uploaded = 0;
  await inPool(missing, UPLOADS_IN_FLIGHT, async ([key, path]) => {
    const data = await readFile(where(path));
    // a key is never overwritten: bytes that changed since they were hashed would stay wrong for good
    if (contentHash(data) !== files[path]!.hash) throw new Error(`raw data: ${path} changed while uploading. Run \`${RAW_UPDATE_HINT}\` again.`);
    const { body, meta } = await encode(data, path);
    await store.put(key, body, meta);
    if (++uploaded % 20 === 0) log(`  ${uploaded}/${missing.length} uploaded`);
  });
  const notice = new TextEncoder().encode(licence);
  if (!existing.has(LICENSE_KEY) || Buffer.compare(await storedBytes(store, LICENSE_KEY), notice) !== 0) {
    const { body, meta } = await encode(notice, LICENSE_KEY);
    await store.put(LICENSE_KEY, body, meta);
    log(`mirror: ${LICENSE_KEY} written`);
  }
  // list once more: the lock must never name a mirror that lacks one of its files
  const stored = new Set((await store.list('raw/')).map((o) => o.key));
  const lost = [...byKey.keys()].filter((key) => !stored.has(key));
  if (lost.length) {
    throw new Error(`mirror: ${lost.length} object(s) missing after the upload (${lost.slice(0, 5).join(', ')}); the lock was not written. Run \`${RAW_UPDATE_HINT}\` again.`);
  }
}

/** Writes the lock atomically, as the repository keeps it (two-space JSON, trailing newline). */
async function writeLock(file: string, lock: RawLock): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  await writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * `npm run raw:update`: fetches the sources in `what` anew from the origin servers (fetch.ts), and keeps every other
 * file the old lock pins as it is (checked, restored from the mirror if missing; never fetched from an origin). With a
 * `store`, every file of the new lock the mirror lacks is uploaded – also files that were already here and are not
 * refreshed (the first fill of the mirror) – and the lock names `mirror`; without one nothing is uploaded and the lock
 * keeps its old mirror. When the timetable is fetched, its sample days are taken from `now` (gtfsSampleDays).
 *
 * Nothing in `dir` and the lock changes until every download (and upload) succeeded: downloads go to `dir/.update`
 * first and are renamed into place right before the lock is written.
 */
export async function updateRaw(o: {
  dir: string;
  lockFile: string;
  what: RawSource[];
  store: ObjectStore | null;
  mirror: string | null;
  fetchFn?: typeof fetch;
  now?: Date;
  log?: (line: string) => void;
}): Promise<RawLock> {
  const { dir, lockFile, store, fetchFn = fetch, now = new Date(), log = console.log } = o;
  const refresh = new Set(o.what);
  const old = await readLockIfAny(lockFile);

  // every file a pipeline run needs is either fetched now or pinned already
  const absent = [...pipelineRawPaths(), GTFS_ZIP].filter((p) => !refresh.has(sourceOf(p)!) && !(p in old.files));
  if (absent.length) {
    const sources = [...new Set(absent.map((p) => sourceOf(p)!))];
    throw new Error(`${lockFile} lacks ${absent.length} file(s) the pipeline needs (${absent.slice(0, 3).join(', ')}${absent.length > 3 ? ', …' : ''}) and this run does not fetch them. Run \`${RAW_UPDATE_HINT} -- ${sources.join(' ')}\`.`);
  }

  // the files that are not refreshed: as the old lock pins them (and fetched from its mirror if missing here)
  const kept = Object.fromEntries(Object.entries(old.files).filter(([p]) => { const s = sourceOf(p); return !s || !refresh.has(s); }));
  await ensureRawFiles({ ...old, files: kept }, dir, { fetchFn, log });

  const staging = join(dir, STAGING);
  await rm(staging, { recursive: true, force: true });
  try {
    const opts = { fetchFn, log };
    if (refresh.has('osm')) {
      await fetchOsm(staging, opts);
      await fetchTransitRoutes(staging, opts);
    }
    if (refresh.has('tiles')) {
      await fetchLod2Tiles(join(staging, 'lod2'), opts);
      await fetchDgmTiles(join(staging, 'dgm1'), opts);
    }
    if (refresh.has('gtfs')) await fetchGtfs(staging, GTFS_ZIP, opts);

    const fresh: RawLock['files'] = {};
    for (const s of RAW_SOURCES) if (refresh.has(s)) for (const p of SOURCE_PATHS[s]()) fresh[p] = await describe(join(staging, p));
    const merged: RawLock['files'] = { ...kept, ...fresh };
    const files = Object.fromEntries(Object.keys(merged).sort().map((p) => [p, merged[p]!]));
    const where = (p: string) => join(p in fresh ? staging : dir, p);

    let gtfsDays = old.gtfsDays;
    if (refresh.has('gtfs')) {
      const calendar = await readZipText(where(GTFS_ZIP), 'calendar.txt');
      if (calendar === null) throw new Error(`gtfs: the feed from ${GTFS_URL} has no calendar.txt`);
      gtfsDays = gtfsSampleDays(gtfsCalendar(calendar), now);
      log(`gtfs: sample days ${gtfsDays.join(', ')} (Tuesday, Saturday, Sunday)`);
    }

    let mirror = old.mirror;
    if (store) {
      await fillMirror(store, files, where, await licenceText(GTFS_ZIP in files ? where(GTFS_ZIP) : null), log);
      mirror = o.mirror;
      if (!mirror) log('raw: no mirror URL (RAW_MIRROR_URL): the lock names no mirror');
    } else {
      log(`raw: no S3_* credentials: nothing uploaded; the lock keeps its mirror (${old.mirror ?? 'none'}), which may lack the new files until \`${RAW_UPDATE_HINT}\` runs with them`);
    }
    const lock = parseRawLock({ version: 1, mirror, files, ...(gtfsDays ? { gtfsDays } : {}) });

    for (const p of Object.keys(fresh)) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await rename(join(staging, p), join(dir, p));
    }
    await writeLock(lockFile, lock);
    log(`raw: ${lockFile}: ${Object.keys(files).length} files${refresh.size ? ` (${[...refresh].join(', ')} fetched anew)` : ''}`);
    return lock;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
