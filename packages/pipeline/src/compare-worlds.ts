import { resolve } from 'node:path';
import { compareWorlds } from './compare/compare.js';

/** `npm run world:compare -- <dirA> <dirB>`: exit code 0 when both worlds are identical, else 1 and the differences. */
if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error('usage: npm run world:compare -- <dirA> <dirB>');
    process.exit(2);
  }
  const r = await compareWorlds(a, b);
  console.log(`world hash A ${r.worldHashA} (${a})`);
  console.log(`world hash B ${r.worldHashB} (${b})`);
  if (r.same) {
    console.log('same: every file is identical');
  } else {
    console.log(`different: ${r.diffs.length} files`);
    for (const d of r.diffs) console.log(`  ${d.kind.padEnd(9)} ${d.name}${d.detail ? `: ${d.detail}` : ''}`);
    process.exitCode = 1;
  }
}
