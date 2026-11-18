// Usage: node scripts/precompress.mjs [dir] [--cache <dir>] [--cache-only] [--prune]   (default dir apps/client/dist)
// Writes <file>.br (Brotli quality 9) and <file>.gz (gzip level 6) next to every js/css/html/json/bin/glb file; the game
// server serves them when the browser accepts them. A variant that is not smaller than the original is not kept.
//
// Brotli 9, not 11: ~14x faster (7 vs 0.5 MB/s per core) for ~10 % larger files. The world is over a GB, though, and
// the pipeline is deterministic: between two builds almost every file is byte-identical. With --cache (or
// NN_PRECOMPRESS_CACHE) the compressed variants are kept in that directory under the SHA-256 of their source and
// reused instead of compressed again.
//   --cache-only  fill the cache only, write nothing next to the files (CI: compress the world on the runner, where
//                 the cache persists between runs; the image build then finds every world file in it)
//   --prune       afterwards, delete cache entries this run did not use (the cache stays the size of one world)
import { constants, brotliCompress, gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';

// zlib's async functions run on libuv's thread pool (4 threads by default). Size it to the machine before the first
// async fs/zlib call starts the pool, so every core compresses.
const THREADS = availableParallelism();
process.env.UV_THREADPOOL_SIZE ??= String(THREADS);

const EXT = new Set(['.js', '.css', '.html', '.json', '.bin', '.glb']);
const BR_QUALITY = 9;
// level 9 is 3x slower than 6 for 0.3 % smaller files (measured on the world's glb/bin files)
const GZ_LEVEL = 6;
/** Part of every cache key: a change of the settings must not reuse variants made with the old ones. */
const SETTINGS = `br${BR_QUALITY}-gz${GZ_LEVEL}`;
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`precompress: ${name} needs a directory`);
    process.exit(2);
  }
  args.splice(i, 2);
  return v;
};
const cacheOnly = flag('--cache-only');
const prune = flag('--prune');
const cacheArg = option('--cache') ?? process.env.NN_PRECOMPRESS_CACHE;
const cacheDir = cacheArg ? resolve(cacheArg) : null;
if ((cacheOnly || prune) && !cacheDir) {
  console.error('precompress: --cache-only and --prune need --cache <dir>');
  process.exit(2);
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

const root = resolve(args[0] ?? fileURLToPath(new URL('../apps/client/dist', import.meta.url)));
if (!(await stat(root).catch(() => null))?.isDirectory()) {
  console.error(`precompress: ${root} does not exist (run the client build first)`);
  process.exit(1);
}
if (cacheDir) await mkdir(cacheDir, { recursive: true });
const files = [];
for await (const f of walk(root)) files.push({ f, size: (await stat(f)).size });
// biggest first: a large file started last would leave all other threads idle at the end
files.sort((a, b) => b.size - a.size);

/** Cache entry names used this run (for --prune). */
const used = new Set();
let hits = 0;

/** A cached variant, or null. */
const cached = (name) => readFile(join(cacheDir, name)).catch(() => null);
/** Writes atomically: a cancelled run leaves no truncated entry that a later run would take for a hit. */
async function store(name, data) {
  const p = join(cacheDir, name);
  await writeFile(`${p}.tmp`, data);
  await rename(`${p}.tmp`, p);
}

/** [brotli, gzip] of data, from the cache when it has both. */
async function compress(data) {
  const key = cacheDir && `${createHash('sha256').update(data).digest('hex')}-${SETTINGS}`;
  if (key) {
    used.add(`${key}.br`).add(`${key}.gz`);
    const [b, g] = await Promise.all([cached(`${key}.br`), cached(`${key}.gz`)]);
    if (b && g) {
      hits++;
      return [b, g];
    }
  }
  const out = await Promise.all([
    brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: BR_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
    gz(data, { level: GZ_LEVEL }),
  ]);
  if (key) await Promise.all([store(`${key}.br`, out[0]), store(`${key}.gz`, out[1])]);
  return out;
}

let before = 0, br = 0, gzSize = 0;
const next = (async function* () { for (const x of files) yield x.f; })();
async function worker() {
  for await (const f of next) {
    const data = await readFile(f);
    before += data.length;
    const [b, g] = await compress(data);
    if (!cacheOnly) {
      for (const [ext, out] of [['.br', b], ['.gz', g]]) {
        if (out.length < data.length) await writeFile(f + ext, out);
        else await rm(f + ext, { force: true });
      }
    }
    br += Math.min(b.length, data.length);
    gzSize += Math.min(g.length, data.length);
  }
}
// each worker runs brotli and gzip at once, so half as many workers as threads keeps every thread busy
await Promise.all(Array.from({ length: Math.max(1, Math.ceil(THREADS / 2)) }, worker));

let pruned = 0;
if (prune) {
  for (const name of await readdir(cacheDir)) {
    if (name.startsWith('.') || used.has(name)) continue; // dotfiles: the directory's .gitignore
    await rm(join(cacheDir, name), { force: true });
    pruned++;
  }
}
const mb = (n) => (n / 1048576).toFixed(1);
const cacheInfo = cacheDir ? `; cache: ${hits}/${files.length} reused${prune ? `, ${pruned} stale entries pruned` : ''}` : '';
console.log(`precompress: ${files.length} files, ${mb(before)} MB -> br ${mb(br)} MB, gz ${mb(gzSize)} MB${cacheInfo}`);
