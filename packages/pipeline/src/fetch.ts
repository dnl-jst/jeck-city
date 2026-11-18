import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BOUNDARY_IDS } from './osm.js';

const LOD2_BASE = 'https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/';
const DGM_BASE = 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/';
/**
 * Overpass instances tried in turn (main instance first, then public mirrors in Germany). The main instance is often
 * overloaded or unreachable from CI runners, so one server is not enough.
 */
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** Attempts over all instances (round robin) before giving up, and the pause between two attempts. */
const OVERPASS_ATTEMPTS = 9;
const OVERPASS_RETRY_MS = 20_000;
/** Longest one Overpass request may take (the query itself allows 180 s on the server). */
const OVERPASS_REQUEST_MS = 240_000;
const USER_AGENT = 'nippes-nights-pipeline/0.1';

// Play area bbox (UTM 32N): Nippes, Neustadt-Nord (Agnesviertel), Altstadt-Nord, Altstadt-Süd, Neustadt-Süd and Deutz,
// + 250 m: covers the 150 m backdrop and the world rect (boundary bbox + 200 m, see worldRect) that the terrain is
// cut from.
const MARGIN = 250;
const BOUNDS = { minE: 354118 - MARGIN, minN: 5642367 - MARGIN, maxE: 359222 + MARGIN, maxN: 5648852 + MARGIN };

// Overpass bbox: Nippes (50.9537445..50.9735975, 6.9410780..6.9688318) ∪ Neustadt-Nord
// (50.9365632..50.9592877, 6.9247210..6.9755545) ∪ Altstadt-Nord (50.9344518..50.9500937, 6.9395438..6.9688513)
// ∪ Altstadt-Süd (50.9213181..50.9370187, 6.9392632..6.9698465) ∪ Neustadt-Süd (50.9153860..50.9377646,
// 6.9246950..6.9733400) ∪ Deutz (50.9172265..50.9546524, 6.9650439..6.9956111) + ~150 m.
const OSM_BBOX = '50.91404,6.92256,50.97500,6.99775'; // S,W,N,E

export function tileNamesForBounds(minE: number, minN: number, maxE: number, maxN: number): string[] {
  const names: string[] = [];
  for (let e = Math.floor(minE / 1000); e <= Math.floor(maxE / 1000); e++) {
    for (let n = Math.floor(minN / 1000); n <= Math.floor(maxN / 1000); n++) {
      names.push(`LoD2_32_${e}_${n}_1_NW.gml`);
    }
  }
  return names;
}

export const LOD2_TILES: string[] = tileNamesForBounds(BOUNDS.minE, BOUNDS.minN, BOUNDS.maxE, BOUNDS.maxN);

/** NRW publishes DGM1 per vintage; the year is part of the file name. */
export const DGM_VINTAGE = '2022';

export const DGM_TILES: string[] = LOD2_TILES.map((n) => {
  const [, , e, nn] = n.split('_');
  return `dgm1_32_${e}_${nn}_1_nw_${DGM_VINTAGE}.tif`;
});

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Downloads LoD2 tiles into `dir`, skipping existing files. Returns file paths. */
export async function fetchLod2Tiles(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const name of LOD2_TILES) {
    const path = join(dir, name);
    paths.push(path);
    if (await exists(path)) {
      console.log(`skip ${name} (cached)`);
      continue;
    }
    console.log(`download ${name}`);
    const res = await fetch(LOD2_BASE + name, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok || !res.body) throw new Error(`LoD2 ${name}: HTTP ${res.status}`);
    const tmp = `${path}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  return paths;
}

/** Downloads DGM1 GeoTIFF tiles into `dir`, skipping existing files. Returns file paths. */
export async function fetchDgmTiles(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const name of DGM_TILES) {
    const path = join(dir, name);
    paths.push(path);
    if (await exists(path)) {
      console.log(`skip ${name} (cached)`);
      continue;
    }
    console.log(`download ${name}`);
    const res = await fetch(DGM_BASE + name, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 404) throw new Error(`DGM1 ${name}: HTTP 404. DGM_VINTAGE ('${DGM_VINTAGE}') in fetch.ts may be outdated, the NRW vintage may have changed (check the directory listing at ${DGM_BASE}).`);
    if (!res.ok || !res.body) throw new Error(`DGM1 ${name}: HTTP ${res.status}`);
    const tmp = `${path}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
  return paths;
}

export const OVERPASS_QUERY = `[out:json][timeout:180];
(
  relation(id:${BOUNDARY_IDS.join(',')});
);
out geom;
(
  nwr["highway"](${OSM_BBOX});
  nwr["railway"="tram"](${OSM_BBOX});
  nwr["railway"="light_rail"](${OSM_BBOX});
  nwr["railway"="tram_stop"](${OSM_BBOX});
  nwr["public_transport"](${OSM_BBOX});
  nwr["leisure"](${OSM_BBOX});
  nwr["landuse"](${OSM_BBOX});
  nwr["natural"~"^(tree|tree_row)$"](${OSM_BBOX});
  nwr["shop"](${OSM_BBOX});
  nwr["amenity"](${OSM_BBOX});
  way[~"^parking:"~"."](${OSM_BBOX});
  way["waterway"="river"](${OSM_BBOX});
  way["man_made"="bridge"](${OSM_BBOX});
  way["railway"="rail"]["bridge"](${OSM_BBOX});
);
out geom;`;

/**
 * Fetches OSM data via Overpass into `dir/osm.json`; returns the path. Cached if present. Network errors, timeouts,
 * overload answers (429/5xx) and broken JSON move on to the next instance in OVERPASS_URLS after a pause; other HTTP
 * errors (e.g. 400, a broken query) fail at once.
 */
export async function fetchOsm(dir: string, o: { urls?: readonly string[]; attempts?: number; retryMs?: number } = {}): Promise<string> {
  const { urls = OVERPASS_URLS, attempts = OVERPASS_ATTEMPTS, retryMs = OVERPASS_RETRY_MS } = o;
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'osm.json');
  if (await exists(path)) {
    console.log('skip osm.json (cached)');
    return path;
  }
  const failures: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = urls[attempt % urls.length]!;
    if (attempt > 0) await sleep(retryMs);
    console.log(`overpass ${url} (attempt ${attempt + 1}/${attempts})`);
    let why: string;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: OVERPASS_QUERY }),
        signal: AbortSignal.timeout(OVERPASS_REQUEST_MS),
      });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // reject truncated/invalid responses (throws → next instance)
        const tmp = `${path}.part`;
        await writeFile(tmp, text);
        await rename(tmp, path);
        return path;
      }
      if (res.status !== 429 && res.status < 500) throw new Error(`Overpass ${url}: HTTP ${res.status}`);
      why = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Overpass ')) throw err;
      why = err instanceof Error ? `${err.name}: ${err.message}${err.cause instanceof Error ? ` (${err.cause.message || err.cause.name})` : ''}` : String(err);
    }
    console.log(`overpass ${url}: ${why}`);
    failures.push(`${url}: ${why}`);
  }
  throw new Error(`Overpass: all ${attempts} attempts failed:\n  ${failures.join('\n  ')}`);
}
