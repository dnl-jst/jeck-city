/**
 * Build time (Node, imported by vite.config.ts): how much the game downloads, for the warning on the intro screen.
 *
 * Sizes are compressed estimates (gzip level 1 per file; the server sends Brotli 11, which is a little smaller), so the
 * intro's numbers are honest upper bounds. Compressed sizes are cached by file name, size and mtime: the world is
 * ≈ 1 GB and only changes when the pipeline runs.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createGzip, constants } from 'node:zlib';

export interface DownloadSize {
  /** Bytes until the game is playable and the city around the spawn has streamed in. */
  start: number;
  /** Bytes when the whole city has been explored. */
  total: number;
}

/** Same as LOAD_RADIUS in loader.ts (not imported: that module pulls in three.js): chunks streamed around the player. */
const START_RADIUS = 600;

interface ManifestLike {
  chunkSize: number;
  spawn: { x: number; z: number };
  chunks: { key: string; x: number; z: number; file: string }[];
  models: { chunk: string; file: string }[];
}

/**
 * Which world files are downloaded at the start: everything that is not a chunk or a chunk's building model (physics,
 * map, vehicles, figures), plus the chunks within START_RADIUS of the spawn and their models.
 */
export function startWorldFiles(manifest: ManifestLike, files: readonly string[]): Set<string> {
  const half = manifest.chunkSize / 2;
  const near = new Set(manifest.chunks
    .filter((c) => Math.hypot(c.x + half - manifest.spawn.x, c.z + half - manifest.spawn.z) <= START_RADIUS)
    .map((c) => c.key));
  const streamed = new Set([...manifest.chunks.map((c) => c.file), ...manifest.models.map((m) => m.file)]);
  const wanted = new Set([
    ...manifest.chunks.filter((c) => near.has(c.key)).map((c) => c.file),
    ...manifest.models.filter((m) => near.has(m.chunk)).map((m) => m.file),
  ]);
  return new Set(files.filter((f) => !streamed.has(f) || wanted.has(f)));
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    // a linked world (e.g. in a second checkout) counts like a real folder
    const s = e.isSymbolicLink() ? await stat(p) : e;
    if (s.isDirectory()) yield* walk(p);
    else if (s.isFile() && !/\.(br|gz)$/.test(e.name)) yield p;
  }
}

function gzipSize(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const z = createGzip({ level: constants.Z_BEST_SPEED });
    z.on('data', (c: Buffer) => { n += c.length; });
    z.on('end', () => resolve(n));
    z.on('error', reject);
    createReadStream(file).on('error', reject).pipe(z);
  });
}

type Cache = Record<string, { size: number; mtime: number; gz: number }>;

/**
 * The download size of the files under `publicDir` (world/, audio/, portraits/ …); null without a generated world
 * (the intro then shows the warning without numbers).
 */
export async function measureDownload(publicDir: string, cacheFile: string): Promise<DownloadSize | null> {
  const worldDir = join(publicDir, 'world');
  let manifest: ManifestLike;
  try {
    manifest = JSON.parse(await readFile(join(worldDir, 'manifest.json'), 'utf8')) as ManifestLike;
  } catch {
    return null;
  }
  const cache: Cache = await readFile(cacheFile, 'utf8').then((s) => JSON.parse(s) as Cache, () => ({}));
  const next: Cache = {};
  const files: { rel: string; abs: string }[] = [];
  for await (const abs of walk(publicDir)) files.push({ abs, rel: relative(publicDir, abs).split('\\').join('/') });
  const sizes = new Map<string, number>();
  // a few at a time: zlib streams run on libuv's thread pool
  const queue = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const s = await stat(f.abs);
      const hit = cache[f.rel];
      const gz = hit && hit.size === s.size && hit.mtime === s.mtimeMs ? hit.gz : Math.min(s.size, await gzipSize(f.abs));
      next[f.rel] = { size: s.size, mtime: s.mtimeMs, gz };
      sizes.set(f.rel, gz);
    }
  }));
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(next));
  const worldFiles = files.filter((f) => f.rel.startsWith('world/')).map((f) => f.rel.slice('world/'.length));
  const atStart = startWorldFiles(manifest, worldFiles);
  let start = 0, total = 0;
  for (const [rel, gz] of sizes) {
    total += gz;
    if (!rel.startsWith('world/') || atStart.has(rel.slice('world/'.length))) start += gz;
  }
  return { start, total };
}
