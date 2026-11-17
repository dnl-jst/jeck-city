// Dev shortcut: writes signals.json from an existing npc.json, ships the traffic light models and lists both in the
// manifest (the pipeline does all of it itself).
//   npx tsx scripts/signals-from-npc.ts [worldDir]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNpcNet, signalJunctionsOf } from '@nn/shared';
import { prepareProp } from '../packages/pipeline/src/models.js';

const dir = process.argv[2] ?? 'apps/client/public/world';
const net = parseNpcNet(JSON.parse(readFileSync(`${dir}/npc.json`, 'utf8')));
const json = JSON.stringify(signalJunctionsOf(net.junctions));
writeFileSync(`${dir}/signals.json`, json);
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
manifest.signals = { file: 'signals.json', bytes: Buffer.byteLength(json) };
manifest.signalModels = [];
for (const [kind, name] of [['car', 'signal_car'], ['ped', 'signal_ped'], ['car+ped', 'signal_carped']] as const) {
  const glb = await prepareProp(readFileSync(`data/models/signals/${name}.glb`));
  writeFileSync(`${dir}/${name}.glb`, glb);
  manifest.signalModels.push({ kind, file: `${name}.glb`, bytes: glb.byteLength });
}
writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
console.log(`signals.json: ${net.junctions.filter((j) => j.signal).length} junctions, ${(json.length / 1024).toFixed(0)} KB; models: ${manifest.signalModels.map((m: { file: string }) => m.file).join(', ')}`);
