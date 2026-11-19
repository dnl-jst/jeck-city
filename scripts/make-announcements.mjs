// Usage: node scripts/make-announcements.mjs <piper-binary> <voice.onnx>
// Makes the trains' announcements with a local text-to-speech program (Piper, https://github.com/rhasspy/piper, and one
// of its German voice models): "Nächster Halt" once, then one clip per station name of the built world
// (apps/client/public/world/manifest.json, transit.stations) and the end-of-line announcement, as Ogg Vorbis in
// apps/client/public/audio/stops/, with index.json mapping station name → file. The game plays the prefix and then the
// station's clip (GameAudio.announceStop); without these files it falls back to the browser's speech synthesis.
// Needs ffmpeg. Run again when stations are added.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [piper, voice] = process.argv.slice(2);
if (!piper || !voice) {
  console.error('usage: node scripts/make-announcements.mjs <piper-binary> <voice.onnx>');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'apps/client/public/audio/stops');
const manifest = JSON.parse(readFileSync(join(root, 'apps/client/public/world/manifest.json'), 'utf8'));
const stations = [...new Set((manifest.transit?.stations ?? []).map((s) => s.name))].sort((a, b) => a.localeCompare(b, 'de'));
if (stations.length === 0) throw new Error('the world has no transit stations (run the pipeline first)');

/** File name for a station: its name in plain ASCII. */
export const slug = (name) => name.toLowerCase()
  .replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue').replaceAll('ß', 'ss')
  .normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A station name as it is spoken: abbreviations written out, a pause for "/". */
const spoken = (name) => name
  .replace(/\bHbf\b/g, 'Hauptbahnhof').replace(/\bBf\b/g, 'Bahnhof').replace(/Str\./g, 'Straße')
  .replace(/LANXESS arena/i, 'Lanxess Arena').replace(/Koelnmesse/, 'Kölnmesse')
  .replace(/\s*\/\s*/g, ', ');

const tmp = mkdtempSync(join(tmpdir(), 'stops-'));
mkdirSync(out, { recursive: true });
const say = (text, file) => {
  const wav = join(tmp, 'a.wav');
  const p = spawnSync(piper, ['--model', voice, '--output_file', wav, '--sentence_silence', '0.1'], { input: `${text}\n`, encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`piper failed for ${JSON.stringify(text)}: ${p.stderr}`);
  // trimmed of silence at both ends, a short fade, peak at −3 dBFS, mono Ogg Vorbis
  const f = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,afade=t=in:d=0.01,loudnorm=I=-18:TP=-3',
    '-ac', '1', '-ar', '32000', '-c:a', 'libvorbis', '-q:a', '4', join(out, file)], { encoding: 'utf8' });
  if (f.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${f.stderr}`);
};
try {
  say('Nächster Halt:', 'next.ogg');
  say('Endstation. Bitte alle aussteigen.', 'end.ogg');
  const index = {};
  for (const name of stations) {
    const file = `${slug(name)}.ogg`;
    say(`${spoken(name)}.`, file);
    index[name] = file;
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${stations.length} station announcements in ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
