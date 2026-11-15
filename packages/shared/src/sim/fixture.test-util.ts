/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorldManifest } from '../assets/manifest';
import type { TerrainGrid } from '../assets/terrain';
import { loadWorldAssets, type WorldAssets } from './assets';

/** Half size of the synthetic world (m). */
const HALF = 150;

/**
 * Small synthetic world: flat terrain at y = 0 (±150 m, no city mesh), boundary ±140 m, spawn at the origin facing
 * +z, 4 parked cars, 2 lamps, 1 tree. Car 0 stands at (5, 0) facing +z, its left side towards +x.
 */
export function fixtureAssets(): WorldAssets {
  const cols = 2 * HALF + 1;
  const terrain: TerrainGrid = { x0: -HALF, z0: -HALF, cols, rows: cols, datum: 0, heights: new Float32Array(cols * cols) };
  const b = HALF - 10;
  const manifest: WorldManifest = {
    version: 2,
    origin: { e: 0, n: 0 },
    chunkSize: 200,
    chunks: [],
    spawn: { x: 0, y: 0, z: 0, heading: 0 },
    boundary: [[-b, -b], [b, -b], [b, b], [-b, b]],
    lamps: [[30, 0], [30, 10]],
    trees: [[-10, -10]],
    tramStops: [],
    shops: [],
    parked: [
      { x: 5, z: 0, heading: 0, color: 0xff0000 },
      { x: 5, z: 20, heading: 0, color: 0x00ff00 },
      { x: -20, z: 0, heading: Math.PI / 2, color: 0x0000ff },
      { x: 0, z: 40, heading: 0, color: 0xffffff },
    ],
    models: [],
    terrain: { file: 'terrain.bin', bytes: 0 },
    datum: 0,
    farGroundY: -0.5,
    attribution: '',
  };
  const collision = {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    boundary: new Float32Array(manifest.boundary.flat()),
  };
  return { manifest, collision, terrain };
}

const WORLD_DIR = fileURLToPath(new URL('../../../../apps/client/public/world/', import.meta.url));
/** The pipeline's world files exist (apps/client/public/world, not versioned). */
export const haveRealAssets = ['manifest.json', 'collision.bin', 'terrain.bin'].every((f) => existsSync(WORLD_DIR + f));

/** Raw bytes of a file in apps/client/public/world. */
export function readWorldFile(file: string): ArrayBuffer {
  const b = readFileSync(WORLD_DIR + file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

let real: Promise<WorldAssets> | null = null;
/** The real world assets (memoised; decoded once per test file). */
export function realAssets(): Promise<WorldAssets> {
  real ??= loadWorldAssets(async (f) => readWorldFile(f));
  return real;
}
