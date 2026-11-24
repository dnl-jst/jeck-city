#!/usr/bin/env node
// `node scripts/pipeline-peak.mjs [--max <MB>] -- <pipeline arguments>`: runs the pipeline (the same command line as
// `npm run pipeline`, read from package.json) under /usr/bin/time and prints its run time and peak RSS in MB.
// With --max, exits 1 when the peak RSS exceeds that many MB. The pipeline's own output stays visible.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep < 0 ? argv : argv.slice(0, sep);
const pipelineArgs = sep < 0 ? [] : argv.slice(sep + 1);
let maxMb = null;
for (let i = 0; i < own.length; i++) {
  if (own[i] === '--max') {
    maxMb = Number(own[++i]);
    if (!Number.isFinite(maxMb) || maxMb <= 0) fail('--max needs a number of MB');
  } else fail(`unknown option ${own[i]} (usage: node scripts/pipeline-peak.mjs [--max <MB>] -- <pipeline arguments>)`);
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const [cmd, ...cmdArgs] = pkg.scripts.pipeline.trim().split(/\s+/); // plain words only, no quoting in that script
const mac = process.platform === 'darwin';
// /usr/bin/time writes its report to a file of its own (-o), so it never mixes with the pipeline's stderr
const dir = await mkdtemp(join(tmpdir(), 'pipeline-peak-'));
const report = join(dir, 'time.txt');
const timeArgs = [mac ? '-l' : '-v', '-o', report, cmd, ...cmdArgs, ...pipelineArgs];
console.log(`pipeline-peak: /usr/bin/time ${timeArgs.join(' ')}`);

const start = Date.now();
const code = await new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/time', timeArgs, { stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
});
const seconds = (Date.now() - start) / 1000;
const text = await readFile(report, 'utf8').catch(() => '');
await rm(dir, { recursive: true, force: true });

// macOS: "<n>  maximum resident set size" in bytes; Linux: "Maximum resident set size (kbytes): <n>"
const m = mac ? /(\d+)\s+maximum resident set size/.exec(text) : /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
const peakMb = m ? (mac ? Number(m[1]) / 1024 / 1024 : Number(m[1]) / 1024) : null;
const min = Math.floor(seconds / 60), sec = Math.round(seconds - min * 60);
console.log(`pipeline-peak: run time ${seconds.toFixed(1)} s (${min} min ${sec} s), exit code ${code}`);
console.log(`pipeline-peak: peak RSS ${peakMb === null ? 'unknown (no time report)' : `${peakMb.toFixed(0)} MB`}`);

if (code !== 0) process.exit(code);
if (peakMb === null) fail('could not read the peak RSS from /usr/bin/time');
if (maxMb !== null && peakMb > maxMb) fail(`peak RSS ${peakMb.toFixed(0)} MB exceeds --max ${maxMb} MB`);

function fail(msg) {
  console.error(`pipeline-peak: ${msg}`);
  process.exit(1);
}
