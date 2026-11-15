import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const LOD2_BASE = 'https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/';
const DGM_BASE = 'https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'nippes-nights-pipeline/0.1';

// Nippes bbox (UTM 32N) + 150 m backdrop margin.
const BOUNDS = { minE: 355389 - 150, minN: 5646699 - 150, maxE: 357399 + 150, maxN: 5648852 + 150 };

// Overpass bbox: Nippes (50.9537445..50.9735975, 6.9410780..6.9688318) + ~150 m.
const OSM_BBOX = '50.95234,6.93898,50.97500,6.97093'; // S,W,N,E

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

export const DGM_TILES: string[] = LOD2_TILES.map((n) => {
  const [, , e, nn] = n.split('_');
  return `dgm1_32_${e}_${nn}_1_nw_2022.tif`;
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
  relation(2613766);
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
);
out geom;`;

/** Fetches OSM data via Overpass into `dir/osm.json`; returns the path. Cached if present. */
export async function fetchOsm(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'osm.json');
  if (await exists(path)) {
    console.log('skip osm.json (cached)');
    return path;
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: OVERPASS_QUERY }),
    });
    if (res.ok) {
      const text = await res.text();
      JSON.parse(text); // reject truncated/invalid responses
      const tmp = `${path}.part`;
      await writeFile(tmp, text);
      await rename(tmp, path);
      return path;
    }
    if (([429, 502, 503, 504].includes(res.status)) && attempt < 3) {
      console.log(`overpass HTTP ${res.status}, retry in 30 s`);
      await sleep(30_000);
      continue;
    }
    throw new Error(`Overpass: HTTP ${res.status}`);
  }
}
