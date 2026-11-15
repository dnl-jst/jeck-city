import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHUNK_SIZE, encodeCollision, ORIGIN_UTM, type WorldManifest } from '@nn/shared';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { buildChunks, buildCollision, encodeChunkGlb, worldRect, type Overrides } from './chunks.js';
import { parseCityGml } from './citygml.js';
import { fetchLod2Tiles, fetchOsm, LOD2_TILES } from './fetch.js';
import { generatedLamps } from './lamps.js';
import { parseOsm } from './osm.js';
import { parkedCarSpots } from './parking.js';
import { assignShops, classifyBuildings, parkedCars } from './placements.js';
import { buildRoadGraph } from './roadgraph.js';
import { findSpawn } from './spawn.js';
import { assignShopLabels, isNeusserAddress } from './shops.js';
import { placeShelter } from './stops.js';
import { buildStreetGeometry } from './streets.js';

const RAW_DIR = 'data/raw';
const OVERRIDES = 'data/building-overrides.json';
/** Curated shop names: OSM name → invented allusion (user-approved). */
const SHOP_NAMES = 'data/shop-names.json';
const SHOP_SEED = 2613766;
const OUT_DIR = 'apps/client/public/world';
const BUDGET = 25 * 1024 * 1024;
const PARKING_SEED = 2613766;
const SPAWN_TARGET = { x: 0, z: 0 };
const ATTRIBUTION = '© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude: Geobasis NRW (dl-de/zero-2.0)';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** Raw data present → never touch the network; `--skip-fetch` additionally insists on it. */
async function ensureRaw(skipFetch: boolean): Promise<void> {
  const have = existsSync(join(RAW_DIR, 'osm.json')) && LOD2_TILES.every((t) => existsSync(join(RAW_DIR, 'lod2', t)));
  if (have) return console.log('raw data present, no fetch');
  if (skipFetch) throw new Error(`--skip-fetch: ${RAW_DIR} is incomplete`);
  await fetchLod2Tiles(join(RAW_DIR, 'lod2'));
  await fetchOsm(RAW_DIR);
}

async function main() {
  const args = process.argv.slice(2);
  await ensureRaw(args.includes('--skip-fetch'));
  if (args.includes('--fetch-only')) return;

  const f = parseOsm(JSON.parse(await readFile(join(RAW_DIR, 'osm.json'), 'utf8')));
  if (f.boundary.length < 3) throw new Error('OSM boundary missing');
  console.log(`osm: ${f.roads.length} roads, ${f.shops.length} shops, ${f.trees.length} trees, ${f.lamps.length} lamps`);

  // one tile at a time: a parsed tile holds ~700 MB, the XML string is dropped right after parsing
  const seen = new Set<string>();
  let buildings: BuildingMesh[] = [];
  for (const tile of LOD2_TILES) {
    const meshes: BuildingMesh[] = [];
    for (const b of parseCityGml(await readFile(join(RAW_DIR, 'lod2', tile), 'utf8'))) {
      if (seen.has(b.id)) continue; // buildings on tile borders appear in both tiles
      seen.add(b.id);
      const m = buildBuildingMesh(b);
      if (m) meshes.push(m);
    }
    const kept = classifyBuildings(meshes, f.boundary);
    buildings = buildings.concat(kept);
    console.log(`${tile}: ${meshes.length} meshes, ${kept.length} kept`);
  }
  const backdrop = buildings.filter((b) => b.flags & 2).length;
  console.log(`buildings: ${buildings.length} (${backdrop} backdrop)`);

  const overrides: Overrides = existsSync(OVERRIDES) ? JSON.parse(await readFile(OVERRIDES, 'utf8')) : {};
  if (Object.keys(overrides).length) console.log(`overrides: ${Object.keys(overrides).join(', ')}`);
  const active = buildings.filter((b) => !(b.id in overrides));

  const placedShops = assignShops(f.shops, f.boundary, active);
  if (args.includes('--list-shops')) return listNeusserShops(f, placedShops, active);
  const curated: Record<string, string> = existsSync(SHOP_NAMES) ? JSON.parse(await readFile(SHOP_NAMES, 'utf8')) : {};
  const labels = assignShopLabels(f.shops, curated, SHOP_SEED);
  const shops = assignShops(f.shops.map((s, i) => ({ ...s, label: labels[i]!.label })), f.boundary, active, f.roads);
  console.log(`shops: ${shops.length} (${Object.keys(curated).length} curated names, ${shops.filter((s) => s.sign).length} with sign)`);

  const streets = buildStreetGeometry(f);
  const graph = buildRoadGraph(f);
  const spawn = findSpawn(f.roads, SPAWN_TARGET, active);
  console.log(`spawn: (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}), ${Math.hypot(spawn.x, spawn.z).toFixed(1)} m from origin`);

  await mkdir(OUT_DIR, { recursive: true });
  for (const file of await readdir(OUT_DIR)) if (/^chunk_.*\.glb$/.test(file)) await rm(join(OUT_DIR, file));

  const chunks: WorldManifest['chunks'] = [];
  for (const c of buildChunks(buildings, streets, overrides, worldRect(f.boundary))) {
    const file = `chunk_${c.key}.glb`;
    const glb = await encodeChunkGlb(c);
    await writeFile(join(OUT_DIR, file), glb);
    chunks.push({ key: c.key, x: c.ix * CHUNK_SIZE, z: c.iz * CHUNK_SIZE, file, bytes: glb.byteLength });
  }

  const collision = buildCollision({ buildings, curb: streets.curb, sidewalk: streets.sidewalk, boundary: f.boundary, overrides });
  console.log(`collision: ${collision.vertices.length / 3} vertices, ${collision.indices.length / 3} triangles`);
  await writeFile(join(OUT_DIR, 'collision.bin'), new Uint8Array(encodeCollision(collision)));

  const roundPt = (p: { x: number; z: number }) => ({ x: r2(p.x), z: r2(p.z) });
  await writeFile(join(OUT_DIR, 'roadgraph.json'), JSON.stringify({
    nodes: graph.nodes.map((n) => ({ id: n.id, pos: roundPt(n.pos) })),
    edges: graph.edges,
    stops: graph.stops.map((s) => ({ ...s, pos: roundPt(s.pos) })),
  }));

  const extraLamps = generatedLamps(f, active);
  const lamps = [...f.lamps, ...extraLamps];
  const nearSpawn = lamps.filter((p) => Math.hypot(p.x - spawn.x, p.z - spawn.z) < 100).length;
  console.log(`lamps: ${f.lamps.length} OSM + ${extraLamps.length} generated = ${lamps.length} (${nearSpawn} within 100 m of spawn)`);

  const manifest: WorldManifest = {
    version: 1,
    origin: { e: ORIGIN_UTM.e, n: ORIGIN_UTM.n },
    chunkSize: CHUNK_SIZE,
    chunks,
    spawn: { x: r2(spawn.x), y: spawn.y, z: r2(spawn.z), heading: r3(spawn.heading) },
    boundary: f.boundary.map((p) => [r2(p.x), r2(p.z)]),
    lamps: lamps.map((p) => [r2(p.x), r2(p.z)]),
    trees: f.trees.map((p) => [r2(p.x), r2(p.z)]),
    tramStops: graph.stops.map((s) => {
      const p = placeShelter(s.pos, f);
      return { name: s.name, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) };
    }),
    shops: shops.map((s) => ({
      ...s, x: r2(s.x), z: r2(s.z),
      ...(s.sign ? { sign: { x: r2(s.sign.x), z: r2(s.sign.z), heading: r3(s.sign.heading), width: r2(s.sign.width) } } : {}),
    })),
    parked: parkedCars(parkedCarSpots(f, PARKING_SEED), PARKING_SEED).map((p) => ({ ...p, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) })),
    attribution: ATTRIBUTION,
  };
  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));
  console.log(`manifest: ${chunks.length} chunks, ${manifest.shops.length} shops, ${manifest.tramStops.length} tram stops, ${manifest.parked.length} parked cars`);

  let total = 0;
  const sizes: [string, number][] = [];
  for (const file of (await readdir(OUT_DIR)).sort()) {
    const size = (await stat(join(OUT_DIR, file))).size;
    sizes.push([file, size]);
    total += size;
  }
  for (const [file, size] of sizes.filter(([n]) => !n.startsWith('chunk_'))) console.log(`  ${file.padEnd(22)} ${mb(size)}`);
  const chunkBytes = sizes.filter(([n]) => n.startsWith('chunk_')).map(([, s]) => s);
  console.log(`  chunk_*.glb (${chunkBytes.length})       ${mb(chunkBytes.reduce((a, b) => a + b, 0))} (max ${mb(Math.max(...chunkBytes))})`);
  console.log(`world total: ${mb(total)} (budget ${mb(BUDGET)})`);
  if (total > BUDGET) throw new Error('world assets over budget');
}

/**
 * `--list-shops`: every shop in the play area on Neusser Straße (OSM address, or placed in a building with an
 * NRW Neusser Str. address), as JSON lines { realName, type, address } — input for data/shop-names.json.
 */
function listNeusserShops(f: ReturnType<typeof parseOsm>, placed: WorldManifest['shops'], buildings: BuildingMesh[]): void {
  const neusserBuilding = new Set(buildings.filter((b) => b.flags & 1).map((b) => b.id));
  let n = 0;
  for (const s of f.shops) {
    const p = placed.find((q) => q.x === s.pos.x && q.z === s.pos.z);
    if (!p) continue; // outside the play area
    const onNeusser = isNeusserAddress(s.street) || (!s.street && p.buildingId !== undefined && neusserBuilding.has(p.buildingId));
    if (!onNeusser) continue;
    const address = s.street ? `${s.street} ${s.housenumber ?? ''}`.trim() : 'Neusser Str. (Gebäudeadresse)';
    console.log(JSON.stringify({ realName: s.name ?? null, type: s.type, address }));
    n++;
  }
  console.log(`${n} shops on Neusser Straße`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
