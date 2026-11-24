import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORLD_INDEX_FILE, type WorldIndex } from '@nn/shared';

/** First 32 hex characters of the SHA-256 over the (uncompressed) bytes. */
export function contentHash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 32);
}

/** Hashes every file of the (flat) world folder, except index.json itself and dot files. Keys are sorted by name. */
export async function buildWorldIndex(dir: string): Promise<WorldIndex> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.name !== WORLD_INDEX_FILE && !e.name.startsWith('.'));
  const files: WorldIndex['files'] = {};
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isFile()) throw new Error(`world folder must be flat, found ${entry.name} (not a file)`);
    const data = await readFile(join(dir, entry.name));
    files[entry.name] = { hash: contentHash(data), bytes: data.byteLength };
  }
  return { version: 1, files };
}

/** Writes <dir>/index.json (compact JSON, sorted keys: the same world always gives the same bytes). */
export async function writeWorldIndex(dir: string): Promise<WorldIndex> {
  const index = await buildWorldIndex(dir);
  await writeFile(join(dir, WORLD_INDEX_FILE), JSON.stringify(index));
  return index;
}
