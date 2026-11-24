import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BIKE_TYPES, CAR_TYPES, CHUNK_SIZE, chunkKey, decodeTerrain, encodeCollision, encodeTerrain, heightAt, openingTest, ORIGIN_UTM, type TerrainGrid, type WorldManifest } from '@nn/shared';
import { buildBuildingMesh, type BuildingMesh } from './buildings.js';
import { buildCollision, chunkGeometries, encodeChunkGlb, STREET_MESHES, worldRect, type Overrides, type Rect, type StreetMeshes } from './chunks.js';
import { gaussBlur, mosaic, readDgmTile, terrainFromMosaic, TERRAIN_SIGMA } from './dgm.js';
import { drapeMesh } from './drape.js';
import { followDeviation, followTerrain } from './follow.js';
import { insideAnyFootprint } from './footprint.js';
import { prepareModel, prepareProp, type PreparedModel } from './models.js';
import { applyTerrainCuts, applyTerrainFills } from './terraincut.js';
import { shipCharacterModels } from './characters.js';
import { shipCarModels, withHeli } from './ship-cars.js';
import { writeWorldIndex } from './worldindex.js';
import { parseCityGml } from './citygml.js';
import { DGM_TILES, LOD2_TILES, TRANSIT_ROUTES_FILE } from './fetch.js';
import { GTFS_ZIP, readRawLock, requireTimetable } from './raw/lock.js';
import { unpackGtfs } from './raw/gtfs-zip.js';
import { ensureRawFiles } from './raw/resolve.js';
import { generatedLamps } from './lamps.js';
import { buildMapData } from './map.js';
import { parseOsm } from './osm.js';
import { placeScooters } from './escooters.js';
import { parkedCarSpots } from './parking.js';
import { dropCarsAtRacks, fillRacks, layoutRacks, spawnBikeSpot } from './bikeracks.js';
import { assignShops, classifyBuildings, parkedCars } from './placements.js';
import { buildRoadGraph } from './roadgraph.js';
import { placeSpawn, SPAWN_AT, SPAWN_LOOK_AT, topSurface } from './spawn.js';
import { assignShopLabels, isNeusserAddress } from './shops.js';
import { placeShelter } from './stops.js';
import { sidewalkFit } from './sidewalkmetric.js';
import { allSidewalkWidths } from './sidewalkwidth.js';
import { buildStreetGeometry, type Mesh } from './streets.js';
import { streetTrees } from './streettrees.js';
import { trackBed } from './trackbed.js';
import { abutmentFills, bridgeBodies, concatMeshes, liftOntoDecks, onBridge, planBridges, triangleSoup } from './bridges.js';
import { carveRiverBed, findWater, waterOutlines, waterShare, waterSurface } from './water.js';
import { railMesh } from './streets.js';
import { meshCovers, punchMesh } from './punch.js';
import type { TransitBuild } from './transit.js';
import { buildNetwork } from './transitgen.js';
import { parseRoutes, railWays } from './transitnet.js';
import { applyTimetable, loadGtfsTrips } from './gtfs.js';
import { decodeEnv, encodeEnv, footprintTest } from './transitenv.js';

const RAW_DIR = 'data/raw';
const OVERRIDES = 'data/building-overrides.json';
/** Curated shop names: OSM name → invented allusion (user-approved). */
const SHOP_NAMES = 'data/shop-names.json';
const SHOP_SEED = 2613766;
/** Where the world is written unless `--out <dir>` says otherwise. */
const DEFAULT_OUT_DIR = 'apps/client/public/world';
/** What the full run remembers for `--transit-only` (the city above the tunnels, see transitenv.ts). */
const TRANSIT_ENV = 'data/cache/transit-env.bin';
const TRANSIT_COLLISION = 'transit-collision.bin';
const PARKING_SEED = 2613766;
const BIKE_SEED = 5032024;
const SCOOTER_SEED = 2025611;
const BIKE_MODELS = 'data/models/bikes';
/** Frame colour of the cargo bike at the spawn. */
const SPAWN_BIKE_COLOR = 0x2f5d3a;
/** Rack bikes this close to the spawn bike are left out (m). */
const SPAWN_BIKE_CLEAR = 3;
/**
 * The sound Long John (type 5, sound box on the deck, radio while riding): on the sidewalk in front of Neusser Str. 381
 * (LOD2 DENW37AL1000AGv2), at its corner with Niehler Kirchweg, parallel to the Neusser Str. facade and facing the corner.
 */
const SOUND_BIKE = { x: 35.0, z: -729.6, heading: -2.912, type: 5, color: 0xc0262d };
const TREE_SEED = 2613766;
/** The two trees in the planting beds of the Erft-Haus courtyard (data/models/erft-haus-hof; OSM has none there). */
const YARD_TREES = [{ x: 286.3, z: 1203.0 }, { x: 263.5, z: 1202.4 }];
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

/** `--out <dir>`: the world folder to write (and, with `--transit-only`, to read); default DEFAULT_OUT_DIR. */
function parseOutDir(args: string[]): string {
  const i = args.indexOf('--out');
  if (i < 0) return DEFAULT_OUT_DIR;
  const dir = args[i + 1];
  if (!dir || dir.startsWith('--')) throw new Error('--out needs a folder');
  return dir;
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = parseOutDir(args);
  // the pinned raw data, checked file by file (missing or changed files come from the mirror, never an origin server)
  const lock = await readRawLock();
  const pinned = requireTimetable(lock); // (before any work: the timetable is not optional)
  await ensureRawFiles(lock, RAW_DIR);
  // unpacked before any work too: a feed the build cannot read fails here, not after terrain, buildings and streets
  const timetable = { dir: await unpackGtfs(join(RAW_DIR, GTFS_ZIP), pinned.hash), hash: pinned.hash, days: pinned.days };
  if (args.includes('--transit-only')) return transitOnly(outDir, timetable);

  const osmJson: unknown = JSON.parse(await readFile(join(RAW_DIR, 'osm.json'), 'utf8'));
  const f = parseOsm(osmJson);
  if (f.boundary.length < 3) throw new Error('OSM boundary missing');
  console.log(`osm: ${f.roads.length} roads, ${f.shops.length} shops, ${f.trees.length} trees, ${f.lamps.length} lamps`);

  // terrain first: buildings are placed relative to its datum. From here on only the decoded grid is used, so the
  // pipeline sees exactly the (quantized) heights the client reads from terrain.bin.
  const area = worldRect(f.boundary);
  const dgm = mosaic(await Promise.all(DGM_TILES.map(async (t) => {
    const buf = await readFile(join(RAW_DIR, 'dgm1', t));
    return readDgmTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  })));
  let terrainBin = encodeTerrain(terrainFromMosaic(gaussBlur(dgm, TERRAIN_SIGMA), area));
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
  let active = buildings.filter((b) => !(b.id in overrides));

  // replacement models, prepared now: their *_cut surfaces lower the terrain before anything is draped on it
  // (several LOD2 buildings may share one model, a structure split into parts: it is shipped once)
  const byPath = new Map<string, string[]>();
  for (const [id, path] of Object.entries(overrides)) byPath.set(path, [...(byPath.get(path) ?? []), id]);
  const prepared = new Map<string, { m: PreparedModel; parts: BuildingMesh[]; lift: number }>();
  for (const [path, ids] of byPath) {
    const parts = ids.map((id) => buildings.find((x) => x.id === id) ?? fail(`override ${id}: no such building in the play area`));
    // the model is authored with y = 0 at the LoD2 base; on a slope the lowest base of its buildings
    const lift = Math.min(...parts.map((p) => p.base));
    prepared.set(path, { m: await prepareModel(await readFile(path), lift), parts, lift });
  }
  const cuts = [...prepared.values()].filter((p) => p.m.cut.length);
  if (cuts.length) {
    let n = 0;
    for (const { m } of cuts) n += applyTerrainCuts(terrain, m.cut);
    // the client reads the quantized heights from terrain.bin: re-encode and use exactly those from here on
    terrainBin = encodeTerrain(terrain);
    terrain.heights.set(decodeTerrain(terrainBin).heights);
    console.log(`terrain cuts: ${n} grid points lowered under ${cuts.length} model(s)`);
  }

  // the Rhine: water found on the DGM water surface, the bed carved below it; then the bridges over it
  const water = findWater(terrain, f.rivers);
  const carved = carveRiverBed(terrain, water);
  terrainBin = encodeTerrain(terrain);
  terrain.heights.set(decodeTerrain(terrainBin).heights);
  const bridges = planBridges(f, terrain, water);
  // the ground behind the abutments ramps up to the deck (DGM1 dips at quay edges and underpasses)
  const filled = applyTerrainFills(terrain, abutmentFills(bridges), water.mask);
  terrainBin = encodeTerrain(terrain);
  terrain.heights.set(decodeTerrain(terrainBin).heights);
  console.log(`terrain fills: ${filled} grid points raised behind ${bridges.ends.length} abutments`);
  // LoD2 models the Rhine bridges as solid blocks from the water up to the deck: the bridges are built from OSM instead
  const wetBuildings = new Set(buildings.filter((b) => !(b.id in overrides) && waterShare(terrain, water, b) > 0.5));
  buildings = buildings.filter((b) => !wetBuildings.has(b));
  active = active.filter((b) => !wetBuildings.has(b));
  console.log(`buildings over the water dropped: ${wetBuildings.size}`);
  console.log(`water: ${water.mask.reduce((n, v) => n + v, 0)} m², level ${(water.meanLevel + datum).toFixed(2)} m NHN, bed carved at ${carved} grid points; bridges: ${bridges.structures.length} structures, ${bridges.roads.size} ways, ${bridges.tracks.size} tram tracks, ${bridges.rails.length} railways`);

  const placedShops = assignShops(f.shops, f.boundary, active);
  if (args.includes('--list-shops')) return listNeusserShops(f, placedShops, active);
  const curated: Record<string, string> = existsSync(SHOP_NAMES) ? JSON.parse(await readFile(SHOP_NAMES, 'utf8')) : {};
  const labels = assignShopLabels(f.shops, curated, SHOP_SEED);
  const shops = assignShops(f.shops.map((s, i) => ({ ...s, label: labels[i]!.label })), f.boundary, active, f.roads);
  console.log(`shops: ${shops.length} (${Object.keys(curated).length} curated names, ${shops.filter((s) => s.sign).length} with sign)`);

  // the building line comes from every LoD2 footprint, overridden ones too (their footprint is where the model stands);
  // streets, trees, lamps, parking and the spawn all use this one set
  const sidewalks = allSidewalkWidths(f.roads, buildings);
  const { bridge: deckFlat, ...flat } = buildStreetGeometry(f, sidewalks, { roads: bridges.roads, tracks: bridges.tracks });
  const fit = sidewalkFit(flat.sidewalk, [flat.road, flat.curb, flat.parking, flat.green, flat.squares], buildings);
  const pc = (v: number) => `${((100 * v) / fit.area).toFixed(2)} %`;
  console.log(`sidewalk: ${(fit.area / 1e3).toFixed(1)}k m², overshoot: ${fit.overshoot.toFixed(0)} m² (${pc(fit.overshoot)}), undershoot: ${fit.undershoot.toFixed(0)} m² (${pc(fit.undershoot)})`);
  const bed = trackBed(flat.tram.positions, flat.tram.uv, flat.tram.indices);
  const empty = { positions: new Float32Array(), indices: new Uint32Array(), uv: new Float32Array() };
  const flatStreets: StreetMeshes = { ...flat, trackbed: { positions: bed.positions, uv: bed.uv, indices: Uint32Array.from(bed.index) }, water: empty, bridge: empty, steel: empty };
  // decks: the bridge ways' geometry (and the rails of railway bridges) lifted onto the deck heights
  const deckTram = concatMeshes([deckFlat.tram, railMesh(bridges.rails)]);
  const deckBed = trackBed(deckTram.positions, deckTram.uv, deckTram.indices);
  const deckFlatAll: StreetMeshes = { ...deckFlat, tram: deckTram, trackbed: { positions: deckBed.positions, uv: deckBed.uv, indices: Uint32Array.from(deckBed.index) }, water: empty, bridge: empty, steel: empty };
  const decks = {} as StreetMeshes;
  for (const name of STREET_MESHES) decks[name] = liftOntoDecks(cropMesh(deckFlatAll[name], area), bridges);
  const deckSurfaces = (['road', 'sidewalk', 'curb', 'parking', 'green', 'squares', 'trackbed'] as const).map((n) => decks[n]);
  const bodies = bridgeBodies(bridges, deckSurfaces, terrain);
  const streets = {} as StreetMeshes;
  for (const name of STREET_MESHES) {
    if (name === 'water' || name === 'bridge' || name === 'steel') continue;
    streets[name] = drapeMesh(cropMesh(flatStreets[name], area), terrain);
    console.log(`drape ${name}: ${flatStreets[name].indices.length / 3} → ${streets[name].indices.length / 3} triangles (${decks[name].indices.length / 3} on bridges)`);
  }
  streets.water = cropMesh(waterSurface(terrain, water), area);
  streets.bridge = bodies.mesh;
  streets.steel = bodies.steel;
  console.log(`water surface: ${streets.water.indices.length / 3} triangles; bridge bodies: ${bodies.mesh.indices.length / 3} triangles, steel arches: ${bodies.steel.indices.length / 3} triangles`);
  // the underground Stadtbahn: tunnel, stations and stairs; the stairwells are cut out of the ground and the pavement
  const onSidewalk = meshCovers(flat.sidewalk), onSquare = meshCovers(flat.squares);
  const cityEnv = { built: footprintTest(buildings), pavement: (p: { x: number; z: number }) => onSidewalk(p) || onSquare(p), roadway: meshCovers(flat.road) };
  const transitBuild = await buildNetwork(parseRoutes(osmJson, JSON.parse(await readFile(join(RAW_DIR, TRANSIT_ROUTES_FILE), 'utf8'))), railWays(osmJson), f, { terrain, area, ...cityEnv });
  // (remembered along the tunnel tracks, so the Stadtbahn alone can be rebuilt later: --transit-only)
  await mkdir('data/cache', { recursive: true });
  await writeFile(TRANSIT_ENV, encodeEnv(cityEnv, f.tunnelTracks.map((t) => t.pts)));
  const holes = transitBuild?.openings ?? [];
  const holeBox = holes.map((ring) => ({
    minX: Math.min(...ring.map((p) => p.x)), maxX: Math.max(...ring.map((p) => p.x)), minZ: Math.min(...ring.map((p) => p.z)), maxZ: Math.max(...ring.map((p) => p.z)),
  }));
  /** Clear of the stairwells (and a step around them): nothing is placed there. */
  const inHole = openingTest(holes.map((ring) => ring.flatMap((p) => [p.x, p.z])));
  const offHoles = <T extends { x: number; z: number }>(p: T) =>
    !holeBox.some((b) => p.x > b.minX - 1.5 && p.x < b.maxX + 1.5 && p.z > b.minZ - 1.5 && p.z < b.maxZ + 1.5) && !inHole(p.x, p.z);
  const graph = buildRoadGraph(f);
  const spawn = placeSpawn(SPAWN_AT, SPAWN_LOOK_AT, f.boundary, buildings);

  await mkdir(outDir, { recursive: true });
  for (const file of await readdir(outDir)) if (/^(chunk|model|transit)_.*\.glb$/.test(file)) await rm(join(outDir, file));

  const chunks: WorldManifest['chunks'] = [];
  // one chunk at a time: build → punch → encode → write, then let it go
  for (const c of chunkGeometries(buildings, streets, overrides, area, terrain, decks)) {
    const file = `chunk_${c.key}.glb`;
    // (triangles belong to the chunk of their centroid and may reach a little beyond its square)
    const x0 = c.ix * CHUNK_SIZE - 10, z0 = c.iz * CHUNK_SIZE - 10, x1 = x0 + CHUNK_SIZE + 20, z1 = z0 + CHUNK_SIZE + 20;
    if (holeBox.some((b) => b.maxX >= x0 && b.minX <= x1 && b.maxZ >= z0 && b.minZ <= z1)) {
      if (c.ground) c.ground = punchMesh(c.ground, holes);
      for (const name of STREET_MESHES) if (c.streets[name]) c.streets[name] = punchMesh(c.streets[name], holes);
    }
    const glb = await encodeChunkGlb(c);
    await writeFile(join(outDir, file), glb);
    chunks.push({ key: c.key, x: c.ix * CHUNK_SIZE, z: c.iz * CHUNK_SIZE, file, bytes: glb.byteLength });
  }

  const models: WorldManifest['models'] = [];
  const modelCollision: Float32Array[] = [];
  for (const [path, ids] of byPath) {
    const { m, parts, lift } = prepared.get(path)!;
    const id = ids[0]!;
    const b = parts[0]!;
    const off = Math.min(...parts.map((p) => Math.hypot(m.centre.x - p.centroid.x, m.centre.z - p.centroid.z)));
    // a model far from its building was exported in the wrong frame (local origin, Z up, …); a large model that
    // reaches out (the Dom with the Domtreppe and the Kreuzblume) passes as long as its building lies inside it
    const inside = parts.some((p) => p.centroid.x >= m.bounds.minX && p.centroid.x <= m.bounds.maxX && p.centroid.z >= m.bounds.minZ && p.centroid.z <= m.bounds.maxZ);
    if (off > 25 && !inside) throw new Error(`override ${ids.join(', ')}: model centre is ${off.toFixed(1)} m from the building (${path})`);
    const chunk = chunkKey(b.centroid.x, b.centroid.z);
    if (!chunks.some((c) => c.key === chunk)) throw new Error(`override ${id}: chunk ${chunk} does not exist`);
    const file = `model_${basename(path, '.glb')}.glb`;
    await writeFile(join(outDir, file), m.glb);
    models.push({ id, chunk, file, bytes: m.glb.byteLength });
    modelCollision.push(m.collision);
    console.log(`model ${file} for ${ids.join(', ')}: chunk ${chunk}, ${m.collision.length / 9} collision triangles, ${mb(m.glb.byteLength)}, centre ${off.toFixed(1)} m from the LOD2 centroid, lift ${lift.toFixed(2)} m`);
  }

  if (transitBuild) await withTimetable(transitBuild, area, timetable);
  const transitFiles = transitBuild ? await writeTransit(outDir, transitBuild, new Set(chunks.map((c) => c.key))) : null;
  if (transitFiles) models.push(...transitFiles.models);

  // collision: the 1 m drape would put millions of kerb triangles into the trimesh; a coarse terrain-following copy
  // of the flat kerbs and sidewalks is enough (rendering keeps the draped meshes)
  const curb = punchMesh(followTerrain(cropMesh(flatStreets.curb, area), terrain, KERB_EDGE, KERB_TOLERANCE, KERB_MIN_EDGE), holes);
  const sidewalk = punchMesh(followTerrain(cropMesh(flatStreets.sidewalk, area), terrain, KERB_EDGE, KERB_TOLERANCE, KERB_MIN_EDGE), holes);
  for (const [name, m] of [['curb', curb], ['sidewalk', sidewalk]] as const) {
    const d = followDeviation(m, terrain);
    console.log(`collision ${name}: ${m.indices.length / 3} triangles (≤ ${KERB_EDGE} m edges, ${KERB_TOLERANCE * 100} cm tolerance), deviation from the drape max ${(d.max * 100).toFixed(1)} cm at (${d.at.x.toFixed(1)}, ${d.at.z.toFixed(1)}), p99 ${(d.p99 * 100).toFixed(2)} cm`);
  }
  const deckCollision = [...deckSurfaces.map(triangleSoup), bodies.collision];
  const collision = buildCollision({ buildings, curb, sidewalk, boundary: f.boundary, overrides, extra: [...modelCollision, ...deckCollision], terrain });
  console.log(`collision: ${collision.vertices.length / 3} vertices, ${collision.indices.length / 3} triangles`);
  // the spawn stands on the walkable surface there: pavement if any, else the terrain
  const spawnGround = heightAt(terrain, spawn.x, spawn.z);
  const spawnY = topSurface(collision, spawn.x, spawn.z, spawnGround);
  console.log(`spawn: (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) on the Domplatte, ${(spawnY - spawnGround).toFixed(2)} m above the terrain`);
  await writeFile(join(outDir, 'collision.bin'), new Uint8Array(encodeCollision(collision)));
  await writeFile(join(outDir, 'terrain.bin'), new Uint8Array(terrainBin));

  const roundPt = (p: { x: number; z: number }) => ({ x: r2(p.x), z: r2(p.z) });
  await writeFile(join(outDir, 'roadgraph.json'), JSON.stringify({
    nodes: graph.nodes.map((n) => ({ id: n.id, pos: roundPt(n.pos) })),
    edges: graph.edges,
    stops: graph.stops.map((s) => ({ ...s, pos: roundPt(s.pos) })),
  }));

  const map = buildMapData(f, buildings, waterOutlines(terrain, water));
  await writeFile(join(outDir, 'map.json'), JSON.stringify(map));
  console.log(`map: ${map.roads.length} roads (${map.roads.filter((r) => r.name).length} named), ${map.buildings.length} buildings, ${map.greens.length} greens`);

  const extraLamps = generatedLamps(f, buildings); // overridden footprints keep lamps out too
  // props stand on the terrain: none on the bridges (they would stand on the water below)
  const offBridge = <T extends { x: number; z: number }>(p: T) => !onBridge(bridges, terrain, p);
  const lamps = [...f.lamps, ...extraLamps].filter(offBridge).filter(offHoles);
  const nearSpawn = lamps.filter((p) => Math.hypot(p.x - spawn.x, p.z - spawn.z) < 100).length;
  console.log(`lamps: ${f.lamps.length} OSM + ${extraLamps.length} generated = ${lamps.length} (${nearSpawn} within 100 m of spawn)`);
  const extraTrees = streetTrees(f, buildings, spawn, TREE_SEED, lamps, sidewalks);
  const trees = [...f.trees, ...extraTrees, ...YARD_TREES].filter(offBridge).filter(offHoles);
  const treesNearSpawn = trees.filter((p) => Math.hypot(p.x - spawn.x, p.z - spawn.z) < 100).length;
  console.log(`trees: ${f.trees.length} OSM + ${extraTrees.length} street trees = ${trees.length} (${treesNearSpawn} within 100 m of spawn)`);

  // bike and rack models (data/models/bikes, built by their build.py)
  const bikeModels: WorldManifest['bikeModels'] = [];
  for (const type of BIKE_TYPES) {
    const glb = await prepareProp(await readFile(join(BIKE_MODELS, type, `${type}.glb`)));
    const file = `bike_${type}.glb`;
    await writeFile(join(outDir, file), glb);
    bikeModels.push({ type, file, bytes: glb.byteLength });
  }
  const rackModels: WorldManifest['rackModels'] = [];
  for (const [kind, name] of [[0, 'rack_hoop'], [1, 'rack_wall']] as const) {
    const glb = await prepareProp(await readFile(join(BIKE_MODELS, 'racks', `${name}.glb`)));
    await writeFile(join(outDir, `${name}.glb`), glb);
    rackModels.push({ kind, file: `${name}.glb`, bytes: glb.byteLength });
  }
  const characterModels = await shipCharacterModels(outDir);

  // car models (data/models/cars, built by their build.py): full detail and the distance version
  const carModels = await shipCarModels(outDir);
  console.log(`car models: ${carModels.map((c) => `${c.type} ${(c.bytes / 1024).toFixed(0)} KB`).join(', ')}`);

  const racks = layoutRacks(f, buildings).filter((r) => r.hoops.every(offBridge) && r.hoops.every(offHoles));
  const carSpots = dropCarsAtRacks(parkedCarSpots(f, PARKING_SEED, buildings).filter((c) => offBridge(c.pos) && offHoles(c.pos)), racks);
  const spawnBike = spawnBikeSpot(f, spawn, buildings);
  if (insideAnyFootprint(SOUND_BIKE, buildings)) throw new Error('sound bike: spot lies inside a building');
  const rackBikes = fillRacks(racks, BIKE_SEED, buildings).filter(offBridge).filter(offHoles).filter((b) =>
    Math.hypot(b.x - spawnBike.x, b.z - spawnBike.z) >= SPAWN_BIKE_CLEAR && Math.hypot(b.x - SOUND_BIKE.x, b.z - SOUND_BIKE.z) >= SPAWN_BIKE_CLEAR);
  const scooters = placeScooters(f, buildings, SCOOTER_SEED, {
    lamps, trees, hoops: racks.flatMap((r) => r.hoops), keepClear: [spawn, spawnBike, SOUND_BIKE],
  }, sidewalks).filter(offBridge).filter(offHoles);
  console.log(`e-scooters: ${scooters.length} (${scooters.filter((s) => s.down).length} lying)`);
  const hoopCount = racks.reduce((n, r) => n + r.hoops.length, 0);
  console.log(`bikes: ${f.bikeParking.length} OSM bike parkings → ${racks.length} rack rows (${racks.filter((r) => r.inStrip).length} in parking strips), ${hoopCount} hoops, ${rackBikes.length} bikes + the spawn Long John ${Math.hypot(spawnBike.x - spawn.x, spawnBike.z - spawn.z).toFixed(2)} m from the spawn`);

  const manifest: WorldManifest = {
    version: 2,
    origin: { e: ORIGIN_UTM.e, n: ORIGIN_UTM.n },
    chunkSize: CHUNK_SIZE,
    chunks,
    spawn: { x: r2(spawn.x), y: r2(spawnY), z: r2(spawn.z), heading: r3(spawn.heading) },
    boundary: f.boundary.map((p) => [r2(p.x), r2(p.z)]),
    lamps: lamps.map((p) => [r2(p.x), r2(p.z)]),
    trees: trees.map((p) => [r2(p.x), r2(p.z)]),
    tramStops: graph.stops.map((s) => {
      const p = placeShelter(s.pos, f);
      return { name: s.name, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) };
    }),
    shops: shops.map((s) => ({
      ...s, x: r2(s.x), z: r2(s.z),
      ...(s.sign ? { sign: { x: r2(s.sign.x), y: r2(s.sign.y), z: r2(s.sign.z), heading: r3(s.sign.heading), width: r2(s.sign.width) } } : {}),
    })),
    models,
    bikeModels,
    rackModels,
    carModels,
    characterModels,
    bikeRacks: racks.flatMap((r) => r.hoops.map((h) => ({ x: r2(h.x), z: r2(h.z), heading: r3(r.heading), kind: r.kind }))),
    bikes: [
      ...[{ ...spawnBike, type: 3, color: SPAWN_BIKE_COLOR }, SOUND_BIKE, ...rackBikes].map((b) => ({ ...b, x: r2(b.x), z: r2(b.z), heading: r3(b.heading) })),
      ...scooters.map(({ down, ...b }) => ({ ...b, x: r2(b.x), z: r2(b.z), heading: r3(b.heading), ...(down ? { down } : {}) })),
    ],
    parked: withHeli(parkedCars(carSpots, PARKING_SEED).map((p) => ({ ...p, x: r2(p.x), z: r2(p.z), heading: r3(p.heading) }))),
    terrain: { file: 'terrain.bin', bytes: terrainBin.byteLength },
    datum,
    farGroundY: r2(borderMin(terrain) - 0.5),
    ...(transitBuild && transitFiles ? { transit: transitBuild.transit, transitCollision: transitFiles.collision } : {}),
    attribution: ATTRIBUTION,
  };
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  await writeWorldIndex(outDir); // (last write: the dev script restarts the game server when index.json changes)
  console.log(`manifest: ${chunks.length} chunks, ${manifest.shops.length} shops, ${manifest.tramStops.length} tram stops, ${manifest.parked.length} parked cars`);

  let total = 0;
  const sizes: [string, number][] = [];
  for (const file of (await readdir(outDir)).sort()) {
    const size = (await stat(join(outDir, file))).size;
    sizes.push([file, size]);
    total += size;
  }
  for (const [file, size] of sizes.filter(([n]) => !n.startsWith('chunk_'))) console.log(`  ${file.padEnd(22)} ${mb(size)}`);
  const chunkBytes = sizes.filter(([n]) => n.startsWith('chunk_')).map(([, s]) => s);
  console.log(`  chunk_*.glb (${chunkBytes.length})       ${mb(chunkBytes.reduce((a, b) => a + b, 0))} (max ${mb(Math.max(...chunkBytes))})`);
  console.log(`world total: ${mb(total)}`); // report only: visual quality wins over download size
}

/** The pinned GTFS feed: its unpacked folder (data/cache/gtfs/<hash>/, see unpackGtfs), hash and sample days. */
type Timetable = { dir: string; hash: string; days: [number, number, number] };

/** The real timetable for the line paths: the pinned GTFS feed (data/raw/gtfs.zip) on the lock's sample days. */
async function withTimetable(build: TransitBuild, area: Rect, timetable: Timetable): Promise<void> {
  const lines = [...new Set(build.transit.tracks.map((t) => t.line ?? '').filter(Boolean))];
  const trips = await loadGtfsTrips(timetable.dir, lines, (x, z) => x > area.minX && x < area.maxX && z > area.minZ && z < area.maxZ, 'data/cache/gtfs-trips.json', timetable.days, timetable.hash);
  const { placed, lost } = applyTimetable(build.transit.tracks, trips);
  // a path no trip was put on is a branch that shares its way through the area with another path of its line (12 to
  // Niehl and to Merkenich): that one carries its trips; this one would only run on the makeshift headway
  const all = build.transit.tracks.length;
  if (placed > 0) build.transit.tracks = build.transit.tracks.filter((t) => t.timetable);
  const withTrips = build.transit.tracks.length;
  console.log(`transit: timetable: ${placed} trips on ${withTrips} of ${all} line paths (${lost} trips fit no path)`);
}

/** Writes the Stadtbahn's files (its models per chunk, its collision) and returns their manifest entries. */
async function writeTransit(outDir: string, build: TransitBuild, chunkKeys: Set<string>): Promise<{ models: WorldManifest['models']; collision: NonNullable<WorldManifest['transitCollision']> }> {
  const models: WorldManifest['models'] = [];
  for (const [key, glb] of build.models) {
    if (!chunkKeys.has(key)) throw new Error(`transit: chunk ${key} does not exist`);
    const file = `transit_${key}.glb`;
    await writeFile(join(outDir, file), glb);
    models.push({ id: `transit_${key}`, chunk: key, file, bytes: glb.byteLength });
  }
  // its collision as a soup of its own: three vertices per triangle (collision.bin's format, no boundary)
  const col = new Uint8Array(encodeCollision({ vertices: build.collision, indices: Uint32Array.from({ length: build.collision.length / 3 }, (_, i) => i), boundary: new Float32Array() }));
  await writeFile(join(outDir, TRANSIT_COLLISION), col);
  console.log(`transit: ${build.models.size} models, ${build.collision.length / 9} collision triangles, ${build.openings.length} openings in the ground`);
  return { models, collision: { file: TRANSIT_COLLISION, bytes: col.byteLength } };
}

/**
 * `--transit-only`: rebuilds the Stadtbahn alone (tunnels, stations, stairs, tracks and stops) into an existing world,
 * in seconds: from the cached OSM data, the world's terrain.bin and the city raster the last full run left
 * (TRANSIT_ENV). The stairwells are cut out of the ground and the pavement by the full run only: if they moved, it warns.
 */
async function transitOnly(outDir: string, timetable: Timetable): Promise<void> {
  for (const file of [join(outDir, 'manifest.json'), join(outDir, 'terrain.bin'), TRANSIT_ENV]) {
    if (!existsSync(file)) throw new Error(`--transit-only: ${file} is missing; run the full pipeline once`);
  }
  const osmJson: unknown = JSON.parse(await readFile(join(RAW_DIR, 'osm.json'), 'utf8'));
  const f = parseOsm(osmJson);
  const bin = await readFile(join(outDir, 'terrain.bin'));
  const terrain = decodeTerrain(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
  const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8')) as WorldManifest;
  const build = await buildNetwork(parseRoutes(osmJson, JSON.parse(await readFile(join(RAW_DIR, TRANSIT_ROUTES_FILE), 'utf8'))), railWays(osmJson), f,
    { terrain, area: worldRect(f.boundary), ...decodeEnv(await readFile(TRANSIT_ENV)) });
  if (!build) throw new Error('--transit-only: the OSM data has no transit line');
  await withTimetable(build, worldRect(f.boundary), timetable);
  const before = JSON.stringify(manifest.transit?.openings ?? []), after = JSON.stringify(build.transit.openings);
  if (before !== after) console.warn('transit: the stairwells moved; the ground and the pavement are only cut out for them by a full pipeline run');
  for (const file of await readdir(outDir)) if (/^transit_.*\.glb$/.test(file)) await rm(join(outDir, file));
  const files = await writeTransit(outDir, build, new Set(manifest.chunks.map((c) => c.key)));
  manifest.models = [...manifest.models.filter((m) => !m.id.startsWith('transit_')), ...files.models];
  manifest.transit = build.transit;
  manifest.transitCollision = files.collision;
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest));
  await writeWorldIndex(outDir); // (last: the dev script restarts the game server when index.json changes)
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
  return { positions: m.positions, uv: m.uv, indices: Uint32Array.from(idx), ...(m.mark ? { mark: m.mark } : {}) };
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
