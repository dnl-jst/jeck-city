import { ImpactDetector, landed, skidAmount, StepClock, TramBell } from './cues';
import { MIX, type AudioMixer, type LoopVoice } from './mixer';
import type { Radio } from './radio';
import type { SoundId } from './sounds';
import { stationLabel, type RadioTuner, type StationId } from './stations';
import { VehicleSound } from './vehicle-sound';

/** The parts of AudioMixer that GameAudio uses (fakes in tests). */
export type AudioMixerLike = Pick<
  AudioMixer, 'unlock' | 'load' | 'setMuted' | 'setInCar' | 'oneShot' | 'loop' | 'setListener' | 'suspend' | 'resume'
>;
/** The parts of Radio that GameAudio uses (fakes in tests). */
export type RadioLike = Pick<Radio, 'tune' | 'setMuted' | 'unlocked' | 'suspend' | 'resume'>;

/** Door shut, then the engine starts, this long after the door opens. */
const DOOR_DELAY = 0.35;
/** Cue detectors never see a longer step (no step bursts after a hitch). */
const MAX_DT = 0.1;
const STEPS: SoundId[] = ['step1', 'step2', 'step3', 'step4'];

/**
 * The game's sound: turns player/car state into mixer cues and drives the car radio.
 * Loops (ambience, engine) start only once the sounds are loaded and the mixer is unlocked.
 */
export class GameAudio {
  /** Radio callbacks; main.ts hands these to the Radio. */
  readonly radioEvents = {
    onConnecting: (): void => {
      this.stopStatic();
      this.staticVoice = this.d.mixer.loop('static', 'sfx');
      this.staticVoice.setGain(MIX.static);
    },
    onPlaying: (): void => this.stopStatic(),
    onUnreachable: (): void => {
      this.stopStatic();
      this.d.flash('Sender nicht erreichbar');
    },
  };
  private readonly rand: () => number;
  private readonly vehicle: VehicleSound;
  private readonly steps = new StepClock();
  private readonly bell: TramBell;
  private impacts = new ImpactDetector();
  private staticVoice: LoopVoice | null = null;
  private ambience: LoopVoice | null = null;
  private unlocking: Promise<void> | null = null;
  private unlocked = false;
  private loaded = false;
  private inCar = false;
  private engineOn = false;
  /** Seconds until door close + engine start; null when nothing is pending. */
  private doorTimer: number | null = null;
  private muted = false;
  private wasGrounded = true;

  constructor(private readonly d: { mixer: AudioMixerLike; radio: RadioLike; tuner: RadioTuner; flash(text: string): void; rand?: () => number }) {
    this.rand = d.rand ?? Math.random;
    this.vehicle = new VehicleSound({ loop: (id) => d.mixer.loop(id, 'sfx') });
    this.bell = new TramBell(this.rand);
  }

  /** Chosen station while in a car, null on foot. */
  get station(): StationId | null {
    return this.d.tuner.inCar ? this.d.tuner.current : null;
  }

  /** Fetches and decodes the recordings (call at boot, in parallel with the world). */
  async load(): Promise<void> {
    await this.d.mixer.load();
    this.loaded = true;
    this.startLoops();
  }

  /** First user gesture: unlocks Web Audio and a radio stream waiting for it. */
  unlock(): void {
    const p = this.d.mixer.unlock().catch(() => undefined);
    // only the first unlock decodes the buffers; later calls merely resume
    this.unlocking ??= p.then(() => {
      this.unlocked = true;
      this.startLoops();
    });
    this.d.radio.unlocked();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.d.mixer.setMuted(this.muted);
    this.d.radio.setMuted(this.muted);
    this.d.flash(this.muted ? 'Ton aus' : 'Ton an');
  }

  /** Tab hidden: radio off and the audio context suspended; back on when visible (radio only in a car). */
  setHidden(hidden: boolean): void {
    if (hidden) {
      this.stopStatic();
      this.d.radio.suspend();
      this.d.mixer.suspend();
    } else {
      this.d.mixer.resume();
      if (this.inCar) this.d.radio.resume();
    }
  }

  enterCar(): void {
    this.inCar = true;
    this.impacts = new ImpactDetector();
    this.d.mixer.oneShot('doorOpen', { gain: MIX.doors });
    this.doorTimer = DOOR_DELAY;
    this.d.mixer.setInCar(true);
    this.tune(this.d.tuner.enterCar());
  }

  exitCar(): void {
    this.inCar = false;
    this.engineOn = false;
    this.doorTimer = null;
    this.stopStatic();
    this.d.radio.tune(null);
    this.d.tuner.exitCar();
    this.vehicle.stop();
    this.d.mixer.oneShot('engineStop', { gain: MIX.engine });
    this.d.mixer.oneShot('doorOpen', { gain: MIX.doors });
    this.d.mixer.oneShot('doorClose', { gain: MIX.doors });
    this.d.mixer.setInCar(false);
  }

  /** Next (1) or previous (-1) station; only in a car. */
  radioStep(dir: 1 | -1): void {
    if (!this.inCar) return;
    this.tune(dir === 1 ? this.d.tuner.next() : this.d.tuner.prev());
  }

  /** On foot, every frame: footsteps and landings. */
  walk(s: { speed: number; grounded: boolean; airTime: number }, dt: number): void {
    dt = Math.min(dt, MAX_DT);
    if (this.steps.update(s.speed, s.grounded, dt)) {
      const id = STEPS[Math.min(STEPS.length - 1, Math.floor(this.rand() * STEPS.length))]!;
      this.d.mixer.oneShot(id, { gain: MIX.steps, rate: 0.92 + 0.16 * this.rand() });
    }
    if (landed(this.wasGrounded, s.grounded, s.airTime)) this.d.mixer.oneShot('land', { gain: MIX.land });
    this.wasGrounded = s.grounded;
  }

  /** In a car, every frame: door/engine start sequence, impacts, engine and skid voices. Speeds in m/s. */
  drive(s: { forward: number; lateral: number; vx: number; vz: number; throttle: number; handbrake: boolean }, dt: number): void {
    dt = Math.min(dt, MAX_DT);
    if (this.doorTimer !== null) {
      this.doorTimer -= dt;
      if (this.doorTimer <= 0) {
        this.doorTimer = null;
        this.d.mixer.oneShot('doorClose', { gain: MIX.doors });
        this.d.mixer.oneShot('engineStart', { gain: MIX.engine });
        this.engineOn = true;
        this.startLoops();
      }
    }
    const hit = this.impacts.update(s.vx, s.vz, dt);
    if (hit > 0) {
      const id: SoundId = hit >= 0.7 ? 'impact3' : hit >= 0.35 ? 'impact2' : 'impact1';
      this.d.mixer.oneShot(id, { gain: hit * MIX.impact });
    }
    this.vehicle.update({ speed: s.forward, throttle: s.throttle, skid: skidAmount(s.forward, s.lateral, s.handbrake) }, dt);
  }

  /** Every frame: listener pose (yaw: forward = (sin, cos)) and the tram bell near the nearest stop. */
  listener(x: number, z: number, yaw: number, nearestTramStop: { x: number; z: number; dist: number } | null, dt: number): void {
    this.d.mixer.setListener(x, z, yaw);
    if (nearestTramStop && this.bell.update(Math.min(dt, MAX_DT), nearestTramStop.dist)) {
      this.d.mixer.oneShot('tramBell', { gain: MIX.tramBell, at: { x: nearestTramStop.x, z: nearestTramStop.z } });
    }
  }

  private tune(id: StationId | null): void {
    this.stopStatic(); // Radio never reports 'playing' after a retune
    this.d.radio.tune(id);
    this.d.flash(stationLabel(id));
  }

  private stopStatic(): void {
    this.staticVoice?.stop();
    this.staticVoice = null;
  }

  /** A loop requested before its buffer is decoded stays silent, so wait for load + unlock. */
  private startLoops(): void {
    if (!this.loaded || !this.unlocked) return;
    if (!this.ambience) {
      this.ambience = this.d.mixer.loop('ambience', 'ambience');
      this.ambience.setGain(MIX.ambience);
    }
    if (this.inCar && this.engineOn) this.vehicle.start();
  }
}
