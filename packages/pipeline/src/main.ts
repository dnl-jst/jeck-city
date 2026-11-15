import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CHUNK_SIZE, chunkKey, decodeTerrain, encodeCollision, encodeTerrain, heightAt, ORIGIN_UTM, type TerrainGrid, type WorldManifest } from '@nn/shared';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { buildChunks, buildCollision, encodeChunkGlb, STREET_MESHES, worldRect, type Overrides, type Rect, type StreetMeshes } from './chunks.js';
import { gaussBlur, mosaic, readDgmTile, terrainFromMosaic, TERRAIN_SIGMA } from './dgm.js';
import { drapeMesh } from './drape.js';
import { followDeviation, followTerrain } from './follow.js';
import { prepareModel } from './models.js';
import { parseCityGml } from './citygml.js';
import { DGM_TILES, fetchDgmTiles, fetchLod2Tiles, fetchOsm, LOD2_TILES } from './fetch.js';
import { generatedLamps } from './lamps.js';
import { parseOsm } from './osm.js';
import { parkedCarSpots, spawnCarSpot, withSpawnCar } from './parking.js';
import { assignShops, classifyBuildings, parkedCars } from './placements.js';
import { buildRoadGraph } from './roadgraph.js';
import { findSpawn } from './spawn.js';
import { assignShopLabels, isNeusserAddress } from './shops.js';
import { placeShelter } from './stops.js';
import { buildStreetGeometry, type Mesh } from './streets.js';
import { trackBed } from './trackbed.js';

const RAW_DIR = 'data/raw';
const OVERRIDES = 'data/building-overrides.json';
/** Curated shop names: OSM name → invented allusion (user-approved). */
const SHOP_NAMES = 'data/shop-names.json';
const SHOP_SEED = 2613766;
const OUT_DIR = 'apps/client/public/world';
const PARKING_SEED = 2613766;
const SPAWN_TARGET = { x: 0, z: 0 };
/**
 * Terrain-following kerbs and sidewalks in the collision mesh (see followTerrain): xz edges ≤ 8 m, refined
 * adaptively until every triangle lies within 2 cm of the 1 m drape (edges down to 5 cm at sharp terrain kinks).
 */
const KERB_EDGE = 8;
const KERB_TOLERANCE = 0.02;
const KERB_MIN_EDGE = 0.05;
const ATTRIBUTION = '© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude und Gelände: Geobasis NRW (dl-de/zero-2.0)';

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/** Raw data present → never touch the network; `--skip-fetch` additionally insists on it. */
async function ensureRaw(skipFetch: boolean): Promise<void> {
  const have = existsSync(join(RAW_DIR, 'osm.json')) && LOD2_TILES.every((t) => existsSync(join(RAW_DIR, 'lod2', t)))
    && DGM_TILES.every((t) => existsSync(join(RAW_DIR, 'dgm1', t)));
  if (have) return console.log('raw data present, no fetch');
  if (skipFetch) throw new Error(`--skip-fetch: ${RAW_DIR} is incomplete`);
  await fetchLod2Tiles(join(RAW_DIR, 'lod2'));
  await fetchDgmTiles(join(RAW_DIR, 'dgm1'));
  await fetchOsm(RAW_DIR);
}

async function main() {
  const args = process.argv.slice(2);
  await ensureRaw(args.includes('--skip-fetch'));
  if (args.includes('--fetch-only')) return;

  const f = parseOsm(JSON.parse(await readFile(join(RAW_DIR, 'osm.json'), 'utf8')));
  if (f.boundary.length < 3) throw new Error('OSM boundary missing');
  console.log(`osm: ${f.roads.length} roads, ${f.shops.length} shops, ${f.trees.length} trees, ${f.lamps.length} lamps`);

  // terrain first: buildings are placed relative to its datum. From here on only the decoded grid is used, so the
  // pipeline sees exactly the (quantized) heights the client reads from terrain.bin.
  const area = worldRect(f.boundary);
  const dgm = mosaic(await Promise.all(DGM_TILES.map(async (t) => {
    const buf = await readFile(join(RAW_DIR, 'dgm1', t));
    return readDgmTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  })));
  const terrainBin = encodeTerrain(terrainFromMosaic(gaussBlur(dgm, TERRAIN_SIGMA), area));
  const terrain = decodeTerrain(terrainBin);
  const { datum } = terrain;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of terrain.heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
  console.log(`terrain: ${terrain.cols}×${terrain.rows}, datum ${datum} m, ${(hMin + datum).toFixed(1)}–${(hMax + datum).toFixed(1)} m NHN, σ ${TERRAIN_SIGMA} m`);

  // one tile at a time: a parsed tile holds ~700 MB, the XML string is dropped right after parsing
  const seen = new Set<string>();
  let buildings: BuildingMesh[] = [];
  for (const tile of LOD2_TILES) {
    const meshes: BuildingMesh[] = [];
    for (const b of parseCityGml(await readFile(join(RAW_DIR, 'lod2', tile), 'utf8'))) {
      if (seen.has(b.id)) continue; // buildings on tile borders appear in both tiles
      seen.add(b.id);
      const m = buildBuildingMesh(b, { datum, terrain });
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

  const flat = buildStreetGeometry(f);
  const bed = trackBed(flat.tram.positions, flat.tram.uv, flat.tram.indices);
  const flatStreets: StreetMeshes = { ...flat, trackbed: { positions: bed.positions, uv: bed.uv, indices: Uint32Array.from(bed.index) } };
  const streets = {} as StreetMeshes;
  for (const name of STREET_MESHES) {
    streets[name] = drapeMesh(cropMesh(flatStreets[name], area), terrain);
    console.log(`drape ${name}: ${flatStreets[name].indices.length / 3} → ${streets[name].indices.length / 3} triangles`);
  }
  const graph = buildRoadGraph(f);
  const flatSpawn = findSpawn(f.roads, SPAWN_TARGET, active);
  const spawn = { ...flatSpawn, y: heightAt(terrain, flatSpawn.x, flatSpawn.z) + flatSpawn.y }; // flat y = sidewalk height
  console.log(`spawn: (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}), ${Math.hypot(spawn.x, spawn.z).toFixed(1)} m from origin`);

  await mkdir(OUT_DIR, { recursive: true });
  for (const file of await readdir(OUT_DIR)) if (/^(chunk|model)_.*\.glb$/.test(file)) await rm(join(OUT_DIR, file));

  const chunks: WorldManifest['chunks'] = [];
  for (const c of buildChunks(buildings, streets, overrides, area, terrain)) {
    const file = `chunk_${c.key}.glb`;
    const glb = await encodeChunkGlb(c);
    await writeFile(join(OUT_DIR, file), glb);
    chunks.push({ key: c.key, x: c.ix * CHUNK_SIZE, z: c.iz * CHUNK_SIZE, file, bytes: glb.byteLength });
  }

  const models: WorldManifest['models'] = [];
  const modelCollision: Float32Array[] = [];
  // several LOD2 buildings may share one model (a structure split into parts): ship it once
  const byPath = new Map<string, string[]>();
  for (const [id, path] of Object.entries(overrides)) byPath.set(path, [...(byPath.get(path) ?? []), id]);
  for (const [path, ids] of byPath) {
    const parts = ids.map((id) => buildings.find((x) => x.id === id) ?? fail(`override ${id}: no such building in the play area`));
    const id = ids[0]!;
    const b = parts[0]!;
    // the model is authored with y = 0 at the LoD2 base; on a slope the lowest base of its buildings
    const lift = Math.min(...parts.map((p) => p.base));
    const m = await prepareModel(await readFile(path), lift);
    const off = Math.min(...parts.map((p) => Math.hypot(m.centre.x - p.centroid.x, m.centre.z - p.centroid.z)));
    // a model far from its building was exported in the wrong frame (local origin, Z up, …)
    if (off > 25) throw new Error(`override ${ids.join(', ')}: model centre is ${off.toFixed(1)} m from the building (${path})`);
    const chunk = chunkKey(b.centroid.x, b.centroid.z);
    if (!chunks.some((c) => c.key === chunk)) throw new Error(`override ${id}: chunk ${chunk} does not exist`);
    const file = `model_${basename(path, '.glb')}.glb`;
    await writeFile(join(OUT_DIR, file), m.glb);
    models.push({ id, chunk, file, bytes: m.glb.byteLength });
    modelCollision.push(m.collision);
    console.log(`model ${file} for ${ids.join(', ')}: chunk ${chunk}, ${m.collision.length / 9} collision triangles, ${mb(m.glb.byteLength)}, centre ${off.toFixed(1)} m from the LOD2 centroid, lift ${lift.toFixed(2)} m`);
  }

  // collision: the 1 m drape would put millions of kerb triangles into the trimesh; a coarse terrain-following copy
  // of the flat kerbs and sidewalks is enough (rendering keeps the draped meshes)
  const curb = followTerrain(cropMesh(flatStreets.curb, area), terrain, KERB_EDGE, KERB_TOLERANCE, KERB_MIN_EDGE);
  const sidewalk = followTerrain(cropMesh(flatStreets.sidewalk, area), terrain, KERB_EDGE, KERB_TOLERANCE, KERB_MIN_EDGE);
  for (const [name, m] of [['curb', curb], ['sidewalk', sidewalk]] as const) {
    const d = followDeviation(m, terrain);
    console.log(`collision ${name}: ${m.indices.length / 3} triangles (≤ ${KERB_EDGE} m edges, ${KERB_TOLERANCE * 100} cm tolerance), deviation from the drape max ${(d.max * 100).toFixed(1)} cm at (${d.at.x.toFixed(1)}, ${d.at.z.toFixed(1)}), p99 ${(d.p99 * 100).toFixed(2)} cm`);
  }
  const collision = buildCollision({ buildings, curb, sidewalk, boundary: f.boundary, overrides, extra: modelCollision, terrain });
  console.log(`collision: ${collision.vertices.length / 3} vertices, ${collision.indices.length / 3} triangles`);
  await writeFile(join(OUT_DIR, 'collision.bin'), new Uint8Array(encodeCollision(collision)));
  await writeFile(join(OUT_DIR, 'terrain.bin'), new Uint8Array(terrainBin));

  const roundPt = (p: { x: number; z: number }) => ({ x: r2(p.x), z: r2(p.z) });
  await writeFile(join(OUT_DIR, 'roadgraph.json'), JSON.stringify({
    nodes: graph.nodes.map((n) => ({ id: n.id, pos: roundPt(n.pos) })),
    edges: graph.edges,
    stops: graph.stops.map((s) => ({ ...s, pos: roundPt(s.pos) })),
  }));

  const extraLamps = generatedLamps(f, buildings); // overridden footprints keep lamps out too
  const lamps = [...f.lamps, ...extraLamps];
  const nearSpawn = lamps.filter((p) => Math.hypot(p.x - spawn.x, p.z - spawn.z) < 100).length;
  console.log(`lamps: ${f.lamps.length} OSM + ${extraLamps.length} generated = ${lamps.length} (${nearSpawn} within 100 m of spawn)`);

  const manifest: WorldManifest = {
    version: 2,
    origin: { e: ORIGIN_UTM.e, n: ORIGIN_UTM.n },
    chunkSize: CHUNK_SIZE,
    chunks,
    spawn: { x: r2(spawn.x), y: r2(spawn.y), z: r2(spawn.z), heading: r3(spawn.heading) },
    boundary: f.boundary.map((p) => [r2(p.x), r2(p.z)]),
    lamps: lamps.map((p) => [r2(p.x), r2(p.z)]),
    trees: f.trees.map((p) => [r2(p.x), r2(p.z)]),
    tramStops: graph.stops.map((s) => {
      const p = placeShelter(s.pos, f);
      return { name: s.name, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) };
    }),
    shops: shops.map((s) => ({
      ...s, x: r2(s.x), z: r2(s.z),
      ...(s.sign ? { sign: { x: r2(s.sign.x), y: r2(s.sign.y), z: r2(s.sign.z), heading: r3(s.sign.heading), width: r2(s.sign.width) } } : {}),
    })),
    models,
    parked: parkedCars(withSpawnCar(spawnCarSpot(f, spawn, buildings), parkedCarSpots(f, PARKING_SEED, buildings)), PARKING_SEED).map((p) => ({ ...p, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) })),
    terrain: { file: 'terrain.bin', bytes: terrainBin.byteLength },
    datum,
    farGroundY: r2(borderMin(terrain) - 0.5),
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
  console.log(`world total: ${mb(total)}`); // report only: visual quality wins over download size
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

/** Triangles of `m` whose centroid lies in `r` (OSM ways reach far beyond the world area; no need to drape those). */
function cropMesh(m: Mesh, r: Rect): Mesh {
  const P = m.positions;
  const idx: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const x = (P[a * 3]! + P[b * 3]! + P[c * 3]!) / 3, z = (P[a * 3 + 2]! + P[b * 3 + 2]! + P[c * 3 + 2]!) / 3;
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) idx.push(a, b, c);
  }
  return { positions: m.positions, uv: m.uv, indices: Uint32Array.from(idx) };
}

/** Lowest height (local y) along the outer rows and columns of the grid. */
function borderMin(t: TerrainGrid): number {
  let min = Infinity;
  const h = (c: number, r: number) => t.heights[r * t.cols + c]!;
  for (let c = 0; c < t.cols; c++) min = Math.min(min, h(c, 0), h(c, t.rows - 1));
  for (let r = 0; r < t.rows; r++) min = Math.min(min, h(0, r), h(t.cols - 1, r));
  return min;
}

function fail(msg: string): never {
  throw new Error(msg);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
