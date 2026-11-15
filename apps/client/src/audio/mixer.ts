import { SOUNDS, type SoundId } from './sounds';

/** All mix levels in one place; callers multiply their voice gains by these. */
export const MIX = {
  steps: 0.5,
  land: 0.6,
  doors: 0.8,
  engine: 0.55,
  skid: 0.6,
  impact: 0.9,
  ambience: 0.4,
  tramBell: 0.7,
  static: 0.25,
} as const;

export interface LoopVoice {
  setGain(g: number): void;
  setRate(r: number): void;
  stop(): void;
}

/** Time constant for parameter ramps (avoids clicks). */
const RAMP = 0.03;
/** In-car / outside transition: ramp over ~0.3 s. */
const CAR_RAMP = 0.3 / 3;

const SILENT: LoopVoice = { setGain() {}, setRate() {}, stop() {} };

/**
 * Web Audio mixer for the game's recordings (never the radio — that stays on an HTMLAudioElement).
 * Buses: master → destination, sfx → master, ambience → lowpass → master.
 * Nothing touches `AudioContext` before `unlock()` (first user gesture).
 */
export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambience: GainNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private readonly raw = new Map<SoundId, ArrayBuffer>();
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
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = this.inCar ? 700 : 20000;
      this.lowpass.connect(this.master);
      this.ambience = ctx.createGain();
      this.ambience.gain.value = this.inCar ? 0.35 : 1;
      this.ambience.connect(this.lowpass);
      await this.decodePending();
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
      (Object.keys(SOUNDS) as SoundId[]).map(async (id) => {
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
    if (!this.ctx || !this.ambience || !this.lowpass) return;
    const t = this.ctx.currentTime;
    this.ambience.gain.setTargetAtTime(inCar ? 0.35 : 1, t, CAR_RAMP);
    this.lowpass.frequency.setTargetAtTime(inCar ? 700 : 20000, t, CAR_RAMP);
  }

  /** Fire-and-forget sample; with `at` it is positioned in the world (HRTF panner). Silent before unlock/load. */
  oneShot(id: SoundId, o: { gain?: number; rate?: number; at?: { x: number; z: number } } = {}): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(id);
    if (!ctx || !this.sfx || !buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = o.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = o.gain ?? 1;
    src.connect(gain);
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
      panner.connect(this.sfx);
    } else {
      gain.connect(this.sfx);
    }
    src.start();
  }

  /** Looping voice on a bus. Starts silent: call setGain to fade it in. Silent no-op before unlock/load. */
  loop(id: SoundId, bus: 'sfx' | 'ambience'): LoopVoice {
    const ctx = this.ctx;
    const out = bus === 'sfx' ? this.sfx : this.ambience;
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

  /** Listener at (x, 0, z) facing the heading convention: forward = (sin yaw, 0, cos yaw). */
  setListener(x: number, z: number, yaw: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    l.positionX.setTargetAtTime(x, t, RAMP);
    l.positionY.setTargetAtTime(0, t, RAMP);
    l.positionZ.setTargetAtTime(z, t, RAMP);
    l.forwardX.setTargetAtTime(Math.sin(yaw), t, RAMP);
    l.forwardY.setTargetAtTime(0, t, RAMP);
    l.forwardZ.setTargetAtTime(Math.cos(yaw), t, RAMP);
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  }
}
