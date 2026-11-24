import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHARACTER_VARIANTS, type WorldManifest } from '@nn/shared';
import { prepareProp } from './models.js';
import { writeWorldIndex } from './worldindex.js';

/** Player figures, built by data/models/character/build.py (MPFB in Blender). */
export const CHARACTER_MODELS = 'data/models/character';

/** Re-encodes character_<variant>.glb (meshopt) into `outDir`; returns the manifest entries. */
export async function shipCharacterModels(outDir: string, srcDir = CHARACTER_MODELS): Promise<WorldManifest['characterModels']> {
  const out: WorldManifest['characterModels'] = [];
  for (const variant of CHARACTER_VARIANTS) {
    const file = `character_${variant}.glb`;
    const glb = await prepareProp(await readFile(join(srcDir, file)));
    await writeFile(join(outDir, file), glb);
    out.push({ variant, file, bytes: glb.byteLength });
  }
  return out;
}

/**
 * `npx tsx packages/pipeline/src/characters.ts [worldDir]`: ships only the character models into an existing world
 * (default apps/client/public/world) and updates its manifest, without rerunning the whole pipeline.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? 'apps/client/public/world';
  const path = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')) as WorldManifest;
  manifest.characterModels = await shipCharacterModels(dir);
  await writeFile(path, JSON.stringify(manifest));
  await writeWorldIndex(dir); // (last write: the content hashes changed)
  console.log('characters:', manifest.characterModels.map((c) => `${c.file} ${(c.bytes / 1e6).toFixed(1)} MB`).join(', '));
}
