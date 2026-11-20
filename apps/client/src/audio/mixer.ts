import { synthBell, synthTick } from './bike-sound';
import { synthHorn } from './horn';
import { synthTrainChime, synthTrainDoorClose, synthTrainDoorOpen, synthTrainMotor, synthTrainRoll } from './train-sound';
import { synthRotor } from './rotor';
import { REMOTE_RADIO_LOWPASS_HZ } from '@nn/shared';
import { SOUNDS, type FileSoundId, type SoundId, type SynthSoundId } from './sounds';

/** All mix levels in one place; callers multiply their voice gains by these. */
export const MIX = {
  steps: 0.5,
  land: 0.6,
  doors: 0.8,
  engine: 0.55,
  skid: 0.6,
  impact: 0.9,
  ambience: 0.17,
  rain: 0.5,
  tramBell: 0.7,
  static: 0.25,
  bikeTick: 0.8,
  bikeBell: 0.7,
  horn: 0.6,
  train: 0.55,
  trainDoors: 0.5,
  trainChime: 0.45,
  heli: 0.55,
} as const;

/** Synthesised samples (made once the AudioContext exists): sample rate → mono samples. */
const SYNTH: Record<SynthSoundId, (rate: number) => Float32Array> = {
  bikeTick: synthTick,
  bikeBell: synthBell,
  carHorn: synthHorn,
  trainRoll: synthTrainRoll,
  trainMotor: synthTrainMotor,
  trainDoorOpen: synthTrainDoorOpen,
  trainDoorClose: synthTrainDoorClose,
  trainChime: synthTrainChime,
  heliRotor: synthRotor,
};

export interface LoopVoice {
  setGain(g: number): void;
  setRate(r: number): void;
  stop(): void;
}

/** A loop placed in the world (HRTF panner, inverse distance falloff). */
export interface PositionalLoopVoice extends LoopVoice {
  setPosition(x: number, z: number): void;
}

/** A radio stream element routed through Web Audio: lowpass, panner, gain. */
export interface StreamOut {
  setPosition(x: number, z: number): void;
  setGain(g: number): void;
  close(): void;
}

/** Time constant for parameter ramps (avoids clicks). */
const RAMP = 0.03;
/** In-car / outside transition: ramp over ~0.3 s. */
const CAR_RAMP = 0.3 / 3;

/** Outside ambience while sitting in the car: level and lowpass cutoff (Hz). */
const AMBIENCE_IN_CAR = { gain: 0.35, lowpassHz: 700 };
/** The own car's engine and tyres heard from the driver's seat: a bit quieter, muffled by the body. */
export const CABIN_IN_CAR = { gain: 0.75, lowpassHz: 2200 };
/** Lowpass cutoff that leaves a bus effectively unfiltered. */
const OPEN_HZ = 20000;

export type Bus = 'sfx' | 'ambience' | 'cabin';

/** A playing one-shot; stop() fades it out quickly and disconnects it. */
export interface ShotVoice {
  stop(): void;
}

const SILENT: LoopVoice = { setGain() {}, setRate() {}, stop() {} };
const SILENT_AT: PositionalLoopVoice = { ...SILENT, setPosition() {} };

function newPanner(ctx: AudioContext): PannerNode {
  return new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 5, positionY: 0 });
}

/** Moves a panner to (x, 0, z); Firefox-style fallback where the AudioParams are missing. */
function movePanner(p: PannerNode, x: number, z: number, t: number): void {
  if (p.positionX) {
    p.positionX.setTargetAtTime(x, t, RAMP);
    p.positionZ.setTargetAtTime(z, t, RAMP);
  } else p.setPosition(x, 0, z);
}

/**
 * Web Audio mixer for the game's recordings (never the radio — that stays on an HTMLAudioElement).
 * Buses: master → destination, sfx → master, ambience → lowpass → master, cabin (own car) → lowpass → master.
 * Nothing touches `AudioContext` before `unlock()` (first user gesture).
 */
export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambience: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private cabin: GainNode | null = null;
  private cabinLowpass: BiquadFilterNode | null = null;
  private readonly raw = new Map<FileSoundId, ArrayBuffer>();
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  private muted = false;
  private inCar = false;

  constructor(private readonly base = '/audio/') {}

  /** Creates (or resumes) the AudioContext; call from a click/keydown handler. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      const amb = this.inCar ? AMBIENCE_IN_CAR : { gain: 1, lowpassHz: OPEN_HZ };
      this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: amb.lowpassHz });
      this.lowpass.connect(this.master);
      this.ambience = new GainNode(ctx, { gain: amb.gain });
      this.ambience.connect(this.lowpass);
      const cab = this.inCar ? CABIN_IN_CAR : { gain: 1, lowpassHz: OPEN_HZ };
      this.cabinLowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: cab.lowpassHz });
      this.cabinLowpass.connect(this.master);
      this.cabin = new GainNode(ctx, { gain: cab.gain });
      this.cabin.connect(this.cabinLowpass);
      const l = ctx.listener;
      if (l.upX) {
        l.upX.value = 0;
        l.upY.value = 1;
        l.upZ.value = 0;
      }
      // resume inside the gesture's call stack (Safari/iOS), before any await
      const resumed = ctx.resume().catch(() => undefined);
      await this.decodePending();
      await resumed;
      return;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
  }

  suspend(): void {
    void this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    void this.ctx?.resume().catch(() => undefined);
  }

  /** Fetches and decodes every sound in parallel; missing files are logged, not fatal. */
  async load(): Promise<void> {
    await Promise.all(
      (Object.keys(SOUNDS) as FileSoundId[]).map(async (id) => {
        if (this.raw.has(id) || this.buffers.has(id)) return;
        const url = this.base + SOUNDS[id].file;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.raw.set(id, await res.arrayBuffer());
        } catch (e) {
          console.warn(`audio: could not load ${url}`, e);
        }
      }),
    );
    await this.decodePending();
  }

  private async decodePending(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [id, make] of Object.entries(SYNTH) as [SynthSoundId, (rate: number) => Float32Array][]) {
      if (this.buffers.has(id)) continue;
      const data = make(ctx.sampleRate);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(id, buf);
    }
    const pending = [...this.raw];
    this.raw.clear();
    await Promise.all(
      pending.map(async ([id, data]) => {
        try {
          this.buffers.set(id, await ctx.decodeAudioData(data));
        } catch (e) {
          console.warn(`audio: could not decode ${SOUNDS[id].file}`, e);
        }
      }),
    );
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, RAMP);
  }

  setInCar(inCar: boolean): void {
    this.inCar = inCar;
    if (!this.ctx || !this.ambience || !this.lowpass || !this.cabin || !this.cabinLowpass) return;
    const t = this.ctx.currentTime;
    this.ambience.gain.setTargetAtTime(inCar ? AMBIENCE_IN_CAR.gain : 1, t, CAR_RAMP);
    this.lowpass.frequency.setTargetAtTime(inCar ? AMBIENCE_IN_CAR.lowpassHz : OPEN_HZ, t, CAR_RAMP);
    this.cabin.gain.setTargetAtTime(inCar ? CABIN_IN_CAR.gain : 1, t, CAR_RAMP);
    this.cabinLowpass.frequency.setTargetAtTime(inCar ? CABIN_IN_CAR.lowpassHz : OPEN_HZ, t, CAR_RAMP);
  }

  /**
   * Sample played once; with `at` it is positioned in the world (HRTF panner). `bus` 'cabin' for the own car's
   * sounds (muffled while inside). Silent before unlock/load.
   */
  oneShot(
    id: SoundId,
    o: { gain?: number; rate?: number; at?: { x: number; z: number }; bus?: 'sfx' | 'cabin' } = {},
  ): ShotVoice {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id);
    const out = o.bus === 'cabin' ? this.cabin : this.sfx;
    if (!ctx || !out || !buffer) return SILENT;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = o.gain ?? 1;
    src.connect(gain);
    let pan: PannerNode | null = null;
    if (o.at) {
      const panner = new PannerNode(ctx, {
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: 5,
        positionX: o.at.x,
        positionY: 0,
        positionZ: o.at.z,
      });
      gain.connect(panner);
      panner.connect(out);
      pan = panner;
    } else {
      gain.connect(out);
    }
    src.start();
    let ended = false;
    src.onended = () => {
      ended = true;
      gain.disconnect();
      pan?.disconnect();
    };
    return {
      stop() {
        if (ended) return;
        ended = true;
        const t = ctx.currentTime;
        gain.gain.setTargetAtTime(0, t, RAMP);
        src.stop(t + RAMP * 5);
      },
    };
  }

  /** Looping voice on a bus. Starts silent: call setGain to fade it in. Silent no-op before unlock/load. */
  loop(id: SoundId, bus: Bus): LoopVoice {
    const ctx = this.ctx;
    const out = bus === 'sfx' ? this.sfx : bus === 'ambience' ? this.ambience : this.cabin;
    const buffer = this.buffers.get(id);
    if (!ctx || !out || !buffer) return SILENT;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(out);
    src.start();
    let stopped = false;
    return {
      setGain(g) {
        if (!stopped) gain.gain.setTargetAtTime(g, ctx.currentTime, RAMP);
      },
      setRate(r) {
        if (!stopped) src.playbackRate.setTargetAtTime(r, ctx.currentTime, RAMP);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        gain.gain.setTargetAtTime(0, t, RAMP);
        src.stop(t + RAMP * 5);
        src.onended = () => gain.disconnect();
      },
    };
  }

  /** Like loop() on the sfx bus, but placed in the world at (x, z) (set it with setPosition). */
  loopAt(id: SoundId): PositionalLoopVoice {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id);
    if (!ctx || !this.sfx || !buffer) return SILENT_AT;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const panner = newPanner(ctx);
    src.connect(gain);
    gain.connect(panner);
    panner.connect(this.sfx);
    src.start();
    let stopped = false;
    return {
      setGain(g) {
        if (!stopped) gain.gain.setTargetAtTime(g, ctx.currentTime, RAMP);
      },
      setRate(r) {
        if (!stopped) src.playbackRate.setTargetAtTime(r, ctx.currentTime, RAMP);
      },
      setPosition(x, z) {
        if (!stopped) movePanner(panner, x, z, ctx.currentTime);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        gain.gain.setTargetAtTime(0, t, RAMP);
        src.stop(t + RAMP * 5);
        src.onended = () => {
          gain.disconnect();
          panner.disconnect();
        };
      },
    };
  }

  /**
   * Routes a stream element (crossOrigin 'anonymous') through lowpass, panner and gain on the sfx bus. Null before
   * unlock. A stream the browser refuses for CORS reasons plays silence here, never unfiltered.
   */
  attachStream(el: HTMLMediaElement): StreamOut | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;
    let src: MediaElementAudioSourceNode;
    try {
      src = ctx.createMediaElementSource(el);
    } catch {
      return null;
    }
    const lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: REMOTE_RADIO_LOWPASS_HZ });
    const panner = newPanner(ctx);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lowpass);
    lowpass.connect(panner);
    panner.connect(gain);
    gain.connect(this.sfx);
    return {
      setPosition: (x, z) => movePanner(panner, x, z, ctx.currentTime),
      setGain: (g) => gain.gain.setTargetAtTime(g, ctx.currentTime, RAMP),
      close() {
        src.disconnect();
        lowpass.disconnect();
        panner.disconnect();
        gain.disconnect();
      },
    };
  }

  /** Listener at (x, 0, z) facing the heading convention: forward = (sin yaw, 0, cos yaw). */
  setListener(x: number, z: number, yaw: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    placeListener(ctx.listener, x, z, yaw, ctx.currentTime);
  }
}

/**
 * Places the listener at (x, 0, z) facing forward = (sin yaw, 0, cos yaw).
 * Firefox lacks the AudioParam attributes on AudioListener; fall back to setPosition/setOrientation there.
 */
export function placeListener(l: AudioListener, x: number, z: number, yaw: number, t: number): void {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  if (l.positionX) {
    l.positionX.setTargetAtTime(x, t, RAMP);
    l.positionY.setTargetAtTime(0, t, RAMP);
    l.positionZ.setTargetAtTime(z, t, RAMP);
    l.forwardX.setTargetAtTime(fx, t, RAMP);
    l.forwardY.setTargetAtTime(0, t, RAMP);
    l.forwardZ.setTargetAtTime(fz, t, RAMP);
  } else {
    l.setPosition(x, 0, z);
    l.setOrientation(fx, 0, fz, 0, 1, 0);
  }
}
