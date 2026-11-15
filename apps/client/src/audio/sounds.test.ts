import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ENGINE_LOOPS, SOUNDS, type SoundId } from './sounds';

const AUDIO_DIR = join(import.meta.dirname, '../../public/audio');
const ids = Object.keys(SOUNDS) as SoundId[];

test('every catalogued file exists', () => {
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(existsSync(join(AUDIO_DIR, SOUNDS[id].file)), SOUNDS[id].file).toBe(true);
});

test('every file is credited as CC0', () => {
  const lines = readFileSync(join(AUDIO_DIR, 'CREDITS.md'), 'utf8').split('\n');
  for (const id of ids) {
    const file = SOUNDS[id].file;
    expect(lines.some((l) => l.includes(file) && l.includes('CC0')), file).toBe(true);
  }
});

test('engine loops are ordered by rpm', () => {
  expect(ENGINE_LOOPS.length).toBeGreaterThanOrEqual(1);
  let prev = -Infinity;
  for (const id of ENGINE_LOOPS) {
    const s = SOUNDS[id];
    expect(s.loop, id).toBe(true);
    expect(s.rpm, id).toBeTypeOf('number');
    expect(s.rpm!, id).toBeGreaterThan(prev);
    prev = s.rpm!;
  }
});
