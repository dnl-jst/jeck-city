// Usage: node scripts/precompress.mjs [dir]   (default apps/client/dist)
// Writes <file>.br (Brotli quality 5) and <file>.gz (gzip level 6) next to every js/css/html/json/bin/glb file; the game
// server serves them when the browser accepts them. A variant that is not smaller than the original is not kept.
// Measured on the world's glb/bin files: Brotli 5 is ~80x faster than 11 (41 vs 0.5 MB/s per core) for ~15 % larger
// files; gzip 6 is 3x faster than 9 for 0.3 % larger ones. The world is over a GB, so speed wins.
import { constants, brotliCompress, gzip } from 'node:zlib';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';

// zlib's async functions run on libuv's thread pool (4 threads by default). Size it to the machine before the first
// async fs/zlib call starts the pool, so every core compresses.
const THREADS = availableParallelism();
process.env.UV_THREADPOOL_SIZE ??= String(THREADS);

const BR_QUALITY = 5;
const GZ_LEVEL = 6;
const EXT = new Set(['.js', '.css', '.html', '.json', '.bin', '.glb']);
const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../apps/client/dist', import.meta.url)));
if (!(await stat(root).catch(() => null))?.isDirectory()) {
  console.error(`precompress: ${root} does not exist (run the client build first)`);
  process.exit(1);
}
const files = [];
for await (const f of walk(root)) files.push({ f, size: (await stat(f)).size });
// biggest first: a large file started last would leave all other threads idle at the end
files.sort((a, b) => b.size - a.size);

let before = 0, br = 0, gzSize = 0;
const next = (async function* () { for (const x of files) yield x.f; })();
async function worker() {
  for await (const f of next) {
    const data = await readFile(f);
    before += data.length;
    const [b, g] = await Promise.all([
      brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: BR_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gz(data, { level: GZ_LEVEL }),
    ]);
    for (const [ext, out] of [['.br', b], ['.gz', g]]) {
      if (out.length < data.length) await writeFile(f + ext, out);
      else await rm(f + ext, { force: true });
    }
    br += Math.min(b.length, data.length);
    gzSize += Math.min(g.length, data.length);
  }
}
// each worker runs brotli and gzip at once, so half as many workers as threads keeps every thread busy
await Promise.all(Array.from({ length: Math.max(1, Math.ceil(THREADS / 2)) }, worker));
const mb = (n) => (n / 1048576).toFixed(1);
console.log(`precompress: ${files.length} files, ${mb(before)} MB -> br ${mb(br)} MB, gz ${mb(gzSize)} MB`);
