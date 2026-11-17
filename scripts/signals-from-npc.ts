// Dev shortcut: writes signals.json from an existing npc.json and lists it in the manifest (the pipeline does both itself).
//   npx tsx scripts/signals-from-npc.ts [worldDir]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNpcNet, signalJunctionsOf } from '@nn/shared';

const dir = process.argv[2] ?? 'apps/client/public/world';
const net = parseNpcNet(JSON.parse(readFileSync(`${dir}/npc.json`, 'utf8')));
const json = JSON.stringify(signalJunctionsOf(net.junctions));
writeFileSync(`${dir}/signals.json`, json);
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
manifest.signals = { file: 'signals.json', bytes: Buffer.byteLength(json) };
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
console.log(`signals.json: ${net.junctions.filter((j) => j.signal).length} junctions, ${(json.length / 1024).toFixed(0)} KB`);
