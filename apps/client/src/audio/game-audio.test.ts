import { expect, test } from 'vitest';
import { GameAudio, type AudioMixerLike, type RadioLike } from './game-audio';
import type { LoopVoice } from './mixer';
import type { SoundId } from './sounds';
import { RadioTuner, type StationId } from './stations';

interface FakeVoice extends LoopVoice {
  id: SoundId;
  bus: string;
  gain: number;
  stopped: boolean;
}

function setup() {
  const shots: { id: SoundId; o: { gain?: number; rate?: number; at?: { x: number; z: number } }; stopped: boolean }[] = [];
  const voices: FakeVoice[] = [];
  const calls: string[] = [];
  const mixer: AudioMixerLike = {
    unlock: () => { calls.push('mixer.unlock'); return Promise.resolve(); },
    load: () => Promise.resolve(),
    setMuted: (m) => calls.push(`mixer.setMuted(${m})`),
    setInCar: (c) => calls.push(`mixer.setInCar(${c})`),
    oneShot: (id, o = {}) => {
      const shot = { id, o, stopped: false };
      shots.push(shot);
      return { stop() { shot.stopped = true; } };
    },
    loop: (id, bus) => {
      const v: FakeVoice = { id, bus, gain: 0, stopped: false, setGain(g) { v.gain = g; }, setRate() {}, stop() { v.stopped = true; } };
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

test('radio waits for the engine', () => {
  const { audio, shots, tunes, flashes } = setup();
  audio.enterCar();
  expect(tunes).toEqual([]);
  expect(flashes).toEqual([]);
  expect(audio.station).toBeNull();
  expect(shots.map((s) => s.id)).toEqual(['doorOpen']);
  audio.engineRunning();
  expect(tunes).toEqual(['koellefornia']);
  expect(flashes).toEqual(['Radio Köllefornia']);
  expect(audio.station).toBe('koellefornia');
});

test('crank plays the starter', () => {
  const { audio, shots } = setup();
  audio.enterCar();
  for (let i = 0; i < 60; i++) audio.drive(DRIVE, 0.1);
  expect(shots.map((s) => s.id)).toEqual(['doorOpen']); // no door timer of its own any more
  audio.doorClosed();
  audio.crank();
  expect(shots.map((s) => s.id)).toEqual(['doorOpen', 'doorClose', 'engineStart']);
});

test('own engine, tyres and starter play on the muffled cabin bus', async () => {
  const { audio, shots, voices } = setup();
  audio.unlock();
  await flush();
  await audio.load();
  audio.enterCar();
  audio.doorClosed();
  audio.crank();
  audio.engineRunning();
  expect(shots.find((s) => s.id === 'engineStart')!.o).toMatchObject({ bus: 'cabin' });
  const car = voices.filter((v) => v.id.startsWith('engine') || v.id === 'skid');
  expect(car.length).toBeGreaterThan(1);
  expect(car.every((v) => v.bus === 'cabin')).toBe(true);
});

test('leaving while cranking', () => {
  const { audio, shots, tunes } = setup();
  audio.enterCar();
  audio.doorClosed();
  audio.crank();
  audio.exitCar();
  expect(shots.map((s) => s.id)).not.toContain('engineStop');
  expect(tunes.every((t) => t === null)).toBe(true);
  expect(audio.station).toBeNull();
});

test('leaving while cranking stops the starter', () => {
  const { audio, shots } = setup();
  audio.enterCar();
  audio.doorClosed();
  audio.crank();
  audio.exitCar();
  expect(shots.find((s) => s.id === 'engineStart')!.stopped).toBe(true);
  expect(shots.filter((s) => s.id !== 'engineStart').every((s) => !s.stopped)).toBe(true);
});

test('the starter clip plays out once the engine runs', () => {
  const { audio, shots } = setup();
  audio.enterCar();
  audio.crank();
  audio.engineRunning();
  audio.exitCar();
  expect(shots.find((s) => s.id === 'engineStart')!.stopped).toBe(false);
});

test('radioStep before the engine runs does nothing', () => {
  const { audio, tunes, flashes } = setup();
  audio.enterCar();
  audio.radioStep(1);
  audio.radioStep(-1);
  expect(tunes).toEqual([]);
  expect(flashes).toEqual([]);
});

test('R cycles and flashes', () => {
  const { audio, tunes, flashes } = setup();
  audio.enterCar();
  audio.engineRunning();
  flashes.length = 0;
  for (let i = 0; i < 4; i++) audio.radioStep(1);
  expect(flashes).toEqual(['Radio Köln', '1LIVE', 'Radio aus', 'Radio Köllefornia']);
  expect(tunes.at(-1)).toBe('koellefornia');
});

test('radioSelect tunes and flashes', () => {
  const { audio, tunes, flashes } = setup();
  audio.enterCar();
  audio.radioSelect('einslive'); // engine not running yet
  expect(tunes).toEqual([]);
  audio.engineRunning();
  flashes.length = 0;
  audio.radioSelect('einslive');
  audio.radioSelect(null);
  expect(tunes).toEqual(['koellefornia', 'einslive', null]);
  expect(flashes).toEqual(['1LIVE', 'Radio aus']);
  expect(audio.station).toBeNull();
});

test('radioSelect same station only flashes', () => {
  const { audio, tunes, flashes } = setup();
  audio.enterCar();
  audio.engineRunning();
  flashes.length = 0;
  audio.radioSelect('koellefornia');
  expect(tunes).toEqual(['koellefornia']);
  expect(flashes).toEqual(['Radio Köllefornia']);
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
  audio.engineRunning();
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
  audio.engineRunning();
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
  audio.engineRunning();
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
  audio.engineRunning();
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

test('a later gesture revives a waiting stream', async () => {
  const { audio, calls } = setup();
  audio.unlock();
  await flush();
  calls.length = 0;
  audio.unlock();
  expect(calls).toEqual(['mixer.unlock', 'radio.unlocked']);
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

test('bike: freewheel ticks while coasting, silent while pedalling, bell and crash cues', async () => {
  const { audio, shots, voices } = setup();
  await audio.load();
  audio.unlock();
  await flush();
  const loopsBefore = voices.length;
  audio.mountBike();
  for (let i = 0; i < 30; i++) audio.ride({ speed: 6, pedalling: true, grounded: true }, 1 / 60);
  expect(shots.some((s) => s.id === 'bikeTick')).toBe(false);
  for (let i = 0; i < 30; i++) audio.ride({ speed: 6, pedalling: false, grounded: true }, 1 / 60);
  expect(shots.some((s) => s.id === 'bikeTick')).toBe(true);
  expect(voices).toHaveLength(loopsBefore); // no rolling or chain loop
  audio.bell();
  expect(shots.map((s) => s.id)).toContain('bikeBell');
  audio.crashBike();
  expect(shots.map((s) => s.id)).toContain('impact2');
  audio.dismountBike();
});

test('bike ticks wait for unlock', async () => {
  const { audio, shots } = setup();
  audio.mountBike();
  for (let i = 0; i < 30; i++) audio.ride({ speed: 6, pedalling: false, grounded: true }, 1 / 60);
  expect(shots.some((s) => s.id === 'bikeTick')).toBe(false);
  await audio.load();
  audio.unlock();
  await flush();
  for (let i = 0; i < 30; i++) audio.ride({ speed: 6, pedalling: false, grounded: true }, 1 / 60);
  expect(shots.some((s) => s.id === 'bikeTick')).toBe(true);
});

test('horn: loop while held in the car, stops on release and on getting out, never on foot', async () => {
  const { audio, voices } = setup();
  audio.unlock();
  await audio.load();
  await flush();
  audio.horn(true, 0.016);
  expect(voices.filter((v) => v.id === 'carHorn')).toHaveLength(0);
  audio.enterCar();
  audio.horn(true, 0.016);
  audio.horn(true, 0.016);
  const horns = () => voices.filter((v) => v.id === 'carHorn');
  expect(horns()).toHaveLength(1);
  expect(horns()[0]!.gain).toBeGreaterThan(0);
  audio.horn(false, 0.1);
  audio.horn(false, 0.1); // the tap minimum has run out
  expect(horns()[0]!.stopped).toBe(true);
  audio.horn(true, 0.016);
  expect(horns()).toHaveLength(2);
  audio.exitCar();
  expect(horns()[1]!.stopped).toBe(true);
});

test('sound Long John: radio on while sitting on it, tunable, off on getting off; plain bikes stay silent', () => {
  const { audio, tunes } = setup();
  audio.mountBike();
  expect(tunes).toEqual([]);
  expect(audio.station).toBeNull();
  audio.radioStep(1);
  expect(tunes).toEqual([]);
  audio.dismountBike();
  audio.mountBike(true);
  expect(tunes).toEqual(['koellefornia']);
  expect(audio.station).toBe('koellefornia');
  audio.radioStep(1);
  expect(tunes).toEqual(['koellefornia', 'radiokoeln']);
  audio.dismountBike();
  expect(tunes.at(-1)).toBeNull();
  expect(audio.station).toBeNull();
  audio.radioStep(1);
  expect(tunes).toHaveLength(3);
});

test('weather(rain) sets the rain loop gain on the ambience bus', async () => {
  const { audio, voices } = setup();
  audio.unlock();
  await audio.load();
  await flush();
  audio.weather(0.5);
  const rain = voices.filter((v) => v.id === 'rain');
  expect(rain).toHaveLength(1);
  expect(rain[0]!.bus).toBe('ambience');
  expect(rain[0]!.gain).toBeCloseTo(0.25);
});

test('weather(0) silences the rain loop without stopping it', async () => {
  const { audio, voices } = setup();
  audio.unlock();
  await audio.load();
  await flush();
  audio.weather(0.5);
  audio.weather(0);
  const rain = voices.find((v) => v.id === 'rain')!;
  expect(rain.gain).toBe(0);
  expect(rain.stopped).toBe(false);
});

test('weather before unlock is applied when the loops start', async () => {
  const { audio, voices } = setup();
  audio.weather(1);
  expect(voices).toEqual([]);
  await audio.load();
  audio.unlock();
  await flush();
  expect(voices.find((v) => v.id === 'rain')?.gain).toBeCloseTo(0.5);
});

test('riding along: the passenger hears the car\'s radio as in the car, following what the driver tunes', () => {
  const { audio, tunes, calls, flashes } = setup();
  audio.rideAlong('einslive');
  expect(calls).toContain('mixer.setInCar(true)');
  expect(tunes).toEqual(['einslive']);
  audio.rideAlong('einslive'); // every frame: nothing new
  expect(tunes).toEqual(['einslive']);
  audio.rideAlong('radiokoeln'); // the driver changed the station
  expect(tunes).toEqual(['einslive', 'radiokoeln']);
  audio.rideAlong(null); // … or switched it off (or got out: engine off)
  expect(tunes).toEqual(['einslive', 'radiokoeln', null]);
  expect(flashes).toHaveLength(2); // the station names, as for the driver
  // a passenger cannot tune
  audio.radioStep(1);
  expect(tunes).toHaveLength(3);
  audio.rideAlong('einslive');
  audio.leaveRide();
  expect(tunes.at(-1)).toBeNull();
  expect(calls.at(-1)).toBe('mixer.setInCar(false)');
  audio.leaveRide(); // twice does nothing
  expect(calls.filter((c) => c === 'mixer.setInCar(false)')).toHaveLength(1);
});
