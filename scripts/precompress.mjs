// Usage: node scripts/precompress.mjs [dir]   (default apps/client/dist)
// Writes <file>.br (Brotli quality 11) and <file>.gz (gzip level 9) next to every js/css/html/json/bin/glb file; the game
// server serves them when the browser accepts them. A variant that is not smaller than the original is not kept.
import { constants, brotliCompress, gzip } from 'node:zlib';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
for await (const f of walk(root)) files.push(f);

let before = 0, br = 0, gzSize = 0;
const next = (async function* () { yield* files; })();
async function worker() {
  for await (const f of next) {
    const data = await readFile(f);
    before += data.length;
    const [b, g] = await Promise.all([
      brotli(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
      gz(data, { level: 9 }),
    ]);
    for (const [ext, out] of [['.br', b], ['.gz', g]]) {
      if (out.length < data.length) await writeFile(f + ext, out);
      else await rm(f + ext, { force: true });
    }
    br += Math.min(b.length, data.length);
    gzSize += Math.min(g.length, data.length);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
const mb = (n) => (n / 1048576).toFixed(1);
console.log(`precompress: ${files.length} files, ${mb(before)} MB -> br ${mb(br)} MB, gz ${mb(gzSize)} MB`);
