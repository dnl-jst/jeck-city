import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CAR_TYPES, type WorldManifest } from '@nn/shared';
import { prepareProp } from './models.js';

/** Car models, built by their build.py (data/models/cars/README.md). */
export const CAR_MODELS = 'data/models/cars';

/**
 * The helicopter: on the meadow in the middle of the Nippeser Tälchen (level ground, clear of trees and lamps).
 * It is a parked "car" of type heli, the last one, so every other car keeps its index.
 */
export const HELI_SPOT = { x: -199, z: -702, heading: 0.6, color: 0xe69e0d, type: CAR_TYPES.indexOf('heli') };

/** `parked` with the helicopter at its end (once). */
export function withHeli(parked: WorldManifest['parked']): WorldManifest['parked'] {
  return parked.some((c) => c.type === HELI_SPOT.type) ? parked : [...parked, HELI_SPOT];
}

/** Re-encodes <type>.glb and its distance version <type>_lod.glb (meshopt) into `outDir`; returns the manifest entries. */
export async function shipCarModels(outDir: string, srcDir = CAR_MODELS): Promise<WorldManifest['carModels']> {
  const out: WorldManifest['carModels'] = [];
  for (const type of CAR_TYPES) {
    let bytes = 0;
    for (const suffix of ['', '_lod']) {
      const glb = await prepareProp(await readFile(join(srcDir, type, `${type}${suffix}.glb`)));
      await writeFile(join(outDir, `car_${type}${suffix}.glb`), glb);
      bytes += glb.byteLength;
    }
    out.push({ type, file: `car_${type}.glb`, lod: `car_${type}_lod.glb`, bytes });
  }
  return out;
}

/**
 * `npm run ship-cars [-- worldDir]`: ships only the car models into an existing world (default
 * apps/client/public/world) and updates its manifest (models, and the helicopter among the parked cars), without
 * rerunning the whole pipeline.
 */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const dir = process.argv[2] ?? 'apps/client/public/world';
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as WorldManifest;
  manifest.carModels = await shipCarModels(dir);
  manifest.parked = withHeli(manifest.parked); // (a world built before there was a helicopter)
  await writeFile(path, JSON.stringify(manifest));
  console.log(`car models: ${manifest.carModels.map((c) => `${c.type} ${(c.bytes / 1024).toFixed(0)} KB`).join(', ')}`);
}
