import { resolve } from 'node:path';
import { writeWorldIndex } from './worldindex.js';

/** `npm run world:index [-- worldDir]`: (re)writes index.json of an existing world (default apps/client/public/world). */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const dir = process.argv[2] ?? 'apps/client/public/world';
  const index = await writeWorldIndex(dir);
  console.log(`${dir}/index.json: ${Object.keys(index.files).length} files`);
}
