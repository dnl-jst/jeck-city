import { expect, test } from 'vitest';
import { GameAudio, type AudioMixerLike, type RadioLike } from './game-audio';
import type { LoopVoice } from './mixer';
import type { SoundId } from './sounds';
import { RadioTuner, type StationId } from './stations';

interface FakeVoice extends LoopVoice {
  id: SoundId;
  gain: number;
  stopped: boolean;
}

function setup() {
  const shots: { id: SoundId; o: { gain?: number; rate?: number; at?: { x: number; z: number } } }[] = [];
  const voices: FakeVoice[] = [];
  const calls: string[] = [];
  const mixer: AudioMixerLike = {
    unlock: () => { calls.push('mixer.unlock'); return Promise.resolve(); },
    load: () => Promise.resolve(),
    setMuted: (m) => calls.push(`mixer.setMuted(${m})`),
    setInCar: (c) => calls.push(`mixer.setInCar(${c})`),
    oneShot: (id, o = {}) => shots.push({ id, o }),
    loop: (id) => {
      const v: FakeVoice = { id, gain: 0, stopped: false, setGain(g) { v.gain = g; }, setRate() {}, stop() { v.stopped = true; } };
      voices.push(v);
      return v;
    },
    setListener: () => {},
    suspend: () => calls.push('mixer.suspend'),
    resume: () => calls.push('mixer.resume'),
  };
  const tunes: (StationId | null)[] = [];
  const radio: RadioLike = {
    tune: (id) => tunes.push(id),
    setMuted: (m) => calls.push(`radio.setMuted(${m})`),
    unlocked: () => calls.push('radio.unlocked'),
    suspend: () => calls.push('radio.suspend'),
    resume: () => calls.push('radio.resume'),
  };
  const flashes: string[] = [];
  const audio = new GameAudio({ mixer, radio, tuner: new RadioTuner(), flash: (t) => flashes.push(t), rand: () => 0.5 });
  return { audio, shots, voices, calls, tunes, flashes };
}

const DRIVE = { forward: 0, lateral: 0, vx: 0, vz: 0, throttle: 0, handbrake: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

test('entering starts Köllefornia and flashes its name', () => {
  const { audio, shots, tunes, flashes } = setup();
  audio.enterCar();
  expect(tunes).toEqual(['koellefornia']);
  expect(flashes).toEqual(['Radio Köllefornia']);
  expect(shots.map((s) => s.id)).toContain('doorOpen');
  expect(shots.map((s) => s.id)).not.toContain('engineStart');
  for (let i = 0; i < 4; i++) audio.drive(DRIVE, 0.1);
  expect(shots.map((s) => s.id)).toEqual(['doorOpen', 'doorClose', 'engineStart']);
});

test('R cycles and flashes', () => {
  const { audio, tunes, flashes } = setup();
  audio.enterCar();
  flashes.length = 0;
  for (let i = 0; i < 4; i++) audio.radioStep(1);
  expect(flashes).toEqual(['Radio Köln', '1LIVE', 'Radio aus', 'Radio Köllefornia']);
  expect(tunes.at(-1)).toBe('koellefornia');
});

test('radio step on foot does nothing', () => {
  const { audio, tunes, flashes } = setup();
  audio.radioStep(1);
  expect(tunes).toEqual([]);
  expect(flashes).toEqual([]);
});

test('exit stops the radio', () => {
  const { audio, tunes, shots } = setup();
  audio.enterCar();
  expect(audio.station).toBe('koellefornia');
  audio.exitCar();
  expect(tunes.at(-1)).toBeNull();
  expect(audio.station).toBeNull();
  expect(shots.map((s) => s.id)).toEqual(['doorOpen', 'engineStop', 'doorOpen', 'doorClose']);
});

test('visibility resume only in car', () => {
  const { audio, calls } = setup();
  audio.setHidden(true);
  audio.setHidden(false);
  expect(calls).not.toContain('radio.resume');
  audio.enterCar();
  calls.length = 0;
  audio.setHidden(true);
  audio.setHidden(false);
  expect(calls.filter((c) => c.startsWith('radio.'))).toEqual(['radio.suspend', 'radio.resume']);
  expect(calls.filter((c) => c.startsWith('mixer.'))).toEqual(['mixer.suspend', 'mixer.resume']);
});

test('mute toggles and flashes', () => {
  const { audio, calls, flashes } = setup();
  audio.toggleMute();
  expect(flashes).toEqual(['Ton aus']);
  expect(calls).toContain('radio.setMuted(true)');
  expect(calls).toContain('mixer.setMuted(true)');
  audio.toggleMute();
  expect(flashes).toEqual(['Ton aus', 'Ton an']);
  expect(calls).toContain('radio.setMuted(false)');
});

test('unreachable flashes once', () => {
  const { audio, voices, flashes } = setup();
  audio.enterCar();
  audio.radioEvents.onConnecting();
  const stat = voices.find((v) => v.id === 'static')!;
  expect(stat.stopped).toBe(false);
  flashes.length = 0;
  audio.radioEvents.onUnreachable();
  expect(flashes).toEqual(['Sender nicht erreichbar']);
  expect(stat.stopped).toBe(true);
});

test('static stops before every tune and once playing', () => {
  const { audio, voices } = setup();
  audio.enterCar();
  audio.radioEvents.onConnecting();
  audio.radioStep(1);
  expect(voices.filter((v) => v.id === 'static').every((v) => v.stopped)).toBe(true);
  audio.radioEvents.onConnecting();
  audio.radioEvents.onPlaying();
  expect(voices.filter((v) => v.id === 'static').every((v) => v.stopped)).toBe(true);
});

test('loops start only once loaded and unlocked; engine waits for both', async () => {
  const { audio, voices } = setup();
  audio.enterCar();
  for (let i = 0; i < 4; i++) audio.drive(DRIVE, 0.1);
  audio.unlock();
  await flush();
  expect(voices).toEqual([]);
  await audio.load();
  expect(voices.find((v) => v.id === 'ambience')?.gain).toBeGreaterThan(0);
  expect(voices.some((v) => v.id === 'engineIdle')).toBe(true);
  audio.unlock();
  await flush();
  expect(voices.filter((v) => v.id === 'ambience')).toHaveLength(1);
});

test('steps, landing, impacts and tram bell', () => {
  const { audio, shots } = setup();
  for (let i = 0; i < 60; i++) audio.walk({ speed: 1.5, grounded: true, airTime: 0 }, 1 / 60);
  expect(shots.some((s) => s.id.startsWith('step'))).toBe(true);
  shots.length = 0;
  audio.walk({ speed: 0, grounded: false, airTime: 0.2 }, 0.1);
  audio.walk({ speed: 0, grounded: true, airTime: 0.5 }, 0.1);
  expect(shots.map((s) => s.id)).toContain('land');
  audio.enterCar();
  shots.length = 0;
  audio.drive({ ...DRIVE, vx: 15 }, 0.05);
  audio.drive({ ...DRIVE, vx: 0 }, 0.05);
  expect(shots.map((s) => s.id)).toContain('impact3');
  shots.length = 0;
  for (let i = 0; i < 2000; i++) audio.listener(0, 0, 0, { x: 10, z: 0, dist: 10 }, 0.1);
  expect(shots.filter((s) => s.id === 'tramBell')[0]?.o.at).toEqual({ x: 10, z: 0 });
});

test('a fresh impact detector per car entry (no false hit from 0 to speed)', () => {
  const { audio, shots } = setup();
  audio.enterCar();
  audio.drive({ ...DRIVE, vx: 15 }, 0.05);
  audio.exitCar();
  audio.enterCar();
  audio.drive({ ...DRIVE, vx: 0 }, 0.05);
  expect(shots.some((s) => s.id.startsWith('impact'))).toBe(false);
});

test('braking through a frame hitch is no impact (detector sees the real dt)', () => {
  const { audio, shots } = setup();
  audio.enterCar();
  audio.drive({ ...DRIVE, vx: 15 }, 1 / 60);
  audio.drive({ ...DRIVE, vx: 11 }, 0.5); // 8 m/s^2: hard braking, not a crash
  expect(shots.some((s) => s.id.startsWith('impact'))).toBe(false);
});
