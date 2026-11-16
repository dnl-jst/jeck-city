import { REMOTE_ENGINE_VOICES, REMOTE_RADIO_GAIN_DB, REMOTE_RADIO_RADIUS, type SnapshotCar } from '@nn/shared';
import type { RemoteCarInfo } from '../remote/remote-players';
import { HornState } from './horn';
import { MIX, type LoopVoice, type PositionalLoopVoice, type StreamOut } from './mixer';
import { RADIO_VOLUME } from './radio';
import type { SoundId } from './sounds';
import { STATIONS, type StationId } from './stations';
import { VehicleSound } from './vehicle-sound';

/** One remote car as the audio sees it: pose and speed from the snapshots, engine and radio from the slow state. */
export type RemoteCarIn = {
  id: number; x: number; z: number; speed: number; accel: number;
  engine: 'off' | 'starting' | 'running'; radio: StationId | null; horn: boolean;
};

/** The parts of a stream element the remote radio uses (fakes in tests). */
export type RemoteStreamEl = Pick<
  HTMLAudioElement,
  'src' | 'crossOrigin' | 'muted' | 'volume' | 'play' | 'pause' | 'load' | 'removeAttribute' | 'addEventListener'
>;

export interface RemoteMixer {
  loopAt(id: SoundId): PositionalLoopVoice;
  attachStream(el: RemoteStreamEl): StreamOut | null;
}

/** Engine voices fade in and out over about this long (s). */
const FADE_S = 0.5;
/** Most horns sounding at once. */
export const REMOTE_HORNS = 6;
/** Smoothing time of the accel estimate (s) and the acceleration (m/s²) that counts as full throttle. */
const ACCEL_TAU = 0.25;
const ACCEL_FULL = 5;
const RADIO_GAIN = RADIO_VOLUME * 10 ** (REMOTE_RADIO_GAIN_DB / 20);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The radio of another player's car: a second HTMLAudioElement with crossOrigin 'anonymous', through lowpass, panner
 * and gain (so it is muffled and positional). A station whose element errors is marked "no remote radio" for the
 * session and stays silent, as is one the mixer cannot route: it is never played unfiltered. The own radio is a different element, untouched.
 */
export class RemoteRadio {
  private cur: { station: StationId; el: RemoteStreamEl; out: StreamOut } | null = null;
  private readonly silent = new Set<StationId>();
  private muted = false;
  private hidden = false;

  constructor(private readonly deps: { make(): RemoteStreamEl; attach(el: RemoteStreamEl): StreamOut | null }) {}

  /** The station playing now (null: none). */
  get playing(): StationId | null {
    return this.cur?.station ?? null;
  }

  isSilenced(id: StationId): boolean {
    return this.silent.has(id);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.cur) this.cur.el.muted = m;
  }

  setHidden(h: boolean): void {
    this.hidden = h;
  }

  /** Every frame: the nearest radio within range (or null), at distance `dist` from the listener. */
  update(target: { station: StationId; x: number; z: number; dist: number } | null): void {
    const want = target && !this.muted && !this.hidden && !this.silent.has(target.station) ? target : null;
    if (this.cur && this.cur.station !== want?.station) this.stop();
    if (!want) return;
    this.cur ??= this.start(want.station);
    this.cur?.out.setPosition(want.x, want.z);
    this.cur?.out.setGain(RADIO_GAIN * clamp01(1 - want.dist / REMOTE_RADIO_RADIUS));
  }

  private start(station: StationId): { station: StationId; el: RemoteStreamEl; out: StreamOut } | null {
    const def = STATIONS.find((s) => s.id === station);
    if (!def) return null;
    const el = this.deps.make();
    el.crossOrigin = 'anonymous'; // before src: the request is then a CORS one
    el.volume = 1;
    el.muted = this.muted;
    const out = this.deps.attach(el);
    if (!out) {
      // not routable through the filter graph: silent for the session (and no new element every frame)
      this.silent.add(station);
      return null;
    }
    const cur = { station, el, out };
    el.addEventListener('error', () => {
      if (this.cur !== cur) return;
      this.silent.add(station); // CORS refused or stream dead: no remote radio for this station
      this.stop();
    });
    el.src = def.url;
    el.play().catch(() => undefined);
    return cur;
  }

  private stop(): void {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    c.el.pause();
    c.el.removeAttribute('src');
    c.el.load();
    c.out.close();
  }
}

interface EngineEntry {
  sound: VehicleSound;
  voices: PositionalLoopVoice[];
  /** 0..1 fade level applied to every engine gain. */
  level: number;
  x: number; z: number; speed: number; accel: number;
}

/**
 * Sound of the other players' cars: engine voices for the nearest REMOTE_ENGINE_VOICES running cars (the rest fade
 * out), a positional horn loop per honking car (nearest REMOTE_HORNS), and the muffled radio of the nearest car with one.
 * Call update() only once sounds are loaded and the mixer is unlocked.
 */
export class RemoteAudio {
  private readonly engines = new Map<number, EngineEntry>();
  private readonly horns = new Map<number, { state: HornState; voice: PositionalLoopVoice | null }>();
  readonly radio: RemoteRadio;

  constructor(private readonly mixer: RemoteMixer, make: () => RemoteStreamEl) {
    this.radio = new RemoteRadio({ make, attach: (el) => mixer.attachStream(el) });
  }

  /** Voice counts for the debug overlay and tests. */
  get stats(): { engines: number; horns: number; radio: StationId | null } {
    return { engines: this.engines.size, horns: [...this.horns.values()].filter((h) => h.voice).length, radio: this.radio.playing };
  }

  /** Engine voices with their current fade level, by car (debug). */
  engineLevels(): Map<number, number> {
    return new Map([...this.engines].map(([id, e]) => [id, e.level]));
  }

  setMuted(m: boolean): void {
    this.radio.setMuted(m);
  }

  setHidden(h: boolean): void {
    this.radio.setHidden(h);
  }

  update(listener: { x: number; z: number }, cars: readonly RemoteCarIn[], dt: number): void {
    const dist = (c: RemoteCarIn) => Math.hypot(c.x - listener.x, c.z - listener.z);
    const near = (list: RemoteCarIn[], n: number) => list.sort((a, b) => dist(a) - dist(b)).slice(0, n);
    this.updateEngines(near(cars.filter((c) => c.engine === 'running'), REMOTE_ENGINE_VOICES), dt);
    this.updateHorns(near(cars.filter((c) => c.horn), REMOTE_HORNS), dt);
    const radio = near(cars.filter((c) => c.radio !== null), 1)[0];
    const d = radio ? dist(radio) : Infinity;
    this.radio.update(radio && d <= REMOTE_RADIO_RADIUS ? { station: radio.radio!, x: radio.x, z: radio.z, dist: d } : null);
  }

  private updateEngines(wanted: RemoteCarIn[], dt: number): void {
    const ids = new Set<number>();
    for (const c of wanted) {
      ids.add(c.id);
      let e = this.engines.get(c.id);
      if (!e) {
        e = this.newEngine();
        this.engines.set(c.id, e);
      }
      e.x = c.x; e.z = c.z; e.speed = c.speed; e.accel = c.accel;
    }
    for (const [id, e] of this.engines) {
      const target = ids.has(id) ? 1 : 0;
      e.level = target > e.level ? Math.min(target, e.level + dt / FADE_S) : Math.max(target, e.level - dt / FADE_S);
      if (target === 0 && e.level === 0) {
        e.sound.stop();
        this.engines.delete(id);
        continue;
      }
      for (const v of e.voices) v.setPosition(e.x, e.z);
      e.sound.update({ speed: e.speed, throttle: e.accel, skid: 0 }, dt);
    }
  }

  private newEngine(): EngineEntry {
    const voices: PositionalLoopVoice[] = [];
    const e: EngineEntry = { sound: null as unknown as VehicleSound, voices, level: 0, x: 0, z: 0, speed: 0, accel: 0 };
    e.sound = new VehicleSound({
      loop: (id): LoopVoice => {
        const v = this.mixer.loopAt(id);
        voices.push(v);
        return { setGain: (g) => v.setGain(g * e.level), setRate: (r) => v.setRate(r), stop: () => v.stop() };
      },
    }, false);
    e.sound.start();
    return e;
  }

  private updateHorns(wanted: RemoteCarIn[], dt: number): void {
    const ids = new Set<number>();
    for (const c of wanted) {
      ids.add(c.id);
      let h = this.horns.get(c.id);
      if (!h) {
        h = { state: new HornState(), voice: null };
        this.horns.set(c.id, h);
      }
      h.state.update(true, dt);
      if (!h.voice) {
        h.voice = this.mixer.loopAt('carHorn');
        h.voice.setGain(MIX.horn);
      }
      h.voice.setPosition(c.x, c.z);
    }
    for (const [id, h] of this.horns) {
      if (ids.has(id)) continue;
      // released (or pushed out of the nearest six): the tap length still sounds
      if (!h.state.update(false, dt)) {
        h.voice?.stop();
        this.horns.delete(id);
      }
    }
  }
}

/** Turns the remote car samples and the slow state into RemoteAudio's input; estimates each car's accel from its speed. */
export class RemoteCarFeed {
  private prev = new Map<number, { speed: number; accel: number }>();

  build(cars: ReadonlyMap<string, SnapshotCar>, info: ReadonlyMap<number, RemoteCarInfo>, me: number, dt: number): RemoteCarIn[] {
    const out: RemoteCarIn[] = [];
    const next = new Map<number, { speed: number; accel: number }>();
    for (const c of cars.values()) {
      const i = info.get(c.id);
      if (!i || i.driver < 0 || i.driver === me) continue;
      const speed = Math.hypot(c.vx, c.vz);
      const p = this.prev.get(c.id);
      let accel = p?.accel ?? 0;
      if (p && dt > 0) {
        const raw = clamp01((speed - p.speed) / dt / ACCEL_FULL);
        accel += (raw - accel) * (1 - Math.exp(-dt / ACCEL_TAU));
      }
      next.set(c.id, { speed, accel });
      out.push({ id: c.id, x: c.x, z: c.z, speed, accel, engine: i.engine ?? 'off', radio: i.radio ?? null, horn: c.horn });
    }
    this.prev = next;
    return out;
  }
}
