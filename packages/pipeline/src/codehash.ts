import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The code the pipeline's caches are built by: every non-test .ts file of the pipeline and of @nn/shared (a hand-kept
 * list misses helpers such as polyline.ts). Any edit there rebuilds a cache keyed on it once: the safe direction.
 */
export const CODE_ROOTS = [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../../shared/src/', import.meta.url))];

/** Hash over the non-test .ts files under `roots` (not *.test.ts, *.test-util.ts): root index, relative path and content, sorted by path. */
export async function codeHash(roots: string[]): Promise<string> {
  const h = createHash('sha256');
  for (const [i, root] of roots.entries()) {
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !/\.test(-util)?\.ts$/.test(e.name))
      .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
      .filter((path) => !path.split('/').includes('node_modules'))
      .sort();
    for (const path of files) h.update(Buffer.from(`${i}:${path}`, 'utf8')).update('\0').update(await readFile(join(root, path))).update('\0');
  }
  return h.digest('hex').slice(0, 32);
}
