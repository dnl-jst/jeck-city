import { ImpactDetector, landed, skidAmount, StepClock, TramBell } from './cues';
import { MIX, type AudioMixer, type LoopVoice, type ShotVoice } from './mixer';
import type { Radio } from './radio';
import type { SoundId } from './sounds';
import { stationLabel, type RadioTuner, type StationId } from './stations';
import { VehicleSound } from './vehicle-sound';
import { BikeSound } from './bike-sound';
import { HornState } from './horn';
import type { RemoteAudio, RemoteCarIn } from './remote-audio';

/** The parts of AudioMixer that GameAudio uses (fakes in tests). */
export type AudioMixerLike = Pick<
  AudioMixer, 'unlock' | 'load' | 'setMuted' | 'setInCar' | 'oneShot' | 'loop' | 'setListener' | 'suspend' | 'resume'
>;
/** The parts of Radio that GameAudio uses (fakes in tests). */
export type RadioLike = Pick<Radio, 'tune' | 'setMuted' | 'unlocked' | 'suspend' | 'resume'>;

/** Step, landing and bell timing never see a longer step (no step bursts after a hitch); impacts use the real dt. */
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
  private readonly tramBell: TramBell;
  private readonly bike: BikeSound;
  /** On a bike: its loops run (once loaded + unlocked). */
  private riding = false;
  /** On the sound Long John: the radio plays through its box. */
  private boxRadio = false;
  private impacts = new ImpactDetector();
  private staticVoice: LoopVoice | null = null;
  private readonly hornState = new HornState();
  private hornVoice: LoopVoice | null = null;
  private ambience: LoopVoice | null = null;
  private unlocking: Promise<void> | null = null;
  private unlocked = false;
  private loaded = false;
  private inCar = false;
  /** Engine caught (Ignition 'running'): engine voices and radio on. */
  private engineOn = false;
  /** The starter clip while cranking; stopped if the player leaves before the engine catches. */
  private starter: ShotVoice | null = null;
  private muted = false;
  private wasGrounded = true;

  constructor(private readonly d: { mixer: AudioMixerLike; radio: RadioLike; tuner: RadioTuner; flash(text: string): void; rand?: () => number; remote?: RemoteAudio }) {
    this.rand = d.rand ?? Math.random;
    this.vehicle = new VehicleSound({ loop: (id) => d.mixer.loop(id, 'sfx') });
    this.tramBell = new TramBell(this.rand);
    this.bike = new BikeSound({ oneShot: (id, o) => d.mixer.oneShot(id, o) });
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
    this.d.remote?.setMuted(this.muted);
    this.d.flash(this.muted ? 'Ton aus' : 'Ton an');
  }

  /** Tab hidden: radio off and the audio context suspended; back on when visible (radio only in a car). */
  setHidden(hidden: boolean): void {
    this.d.remote?.setHidden(hidden);
    if (hidden) {
      this.stopStatic();
      this.d.radio.suspend();
      this.d.mixer.suspend();
    } else {
      this.d.mixer.resume();
      if (this.inCar || this.boxRadio) this.d.radio.resume();
    }
  }

  /** Getting in: door opens; the Ignition then calls doorClosed(), crank() and engineRunning(). */
  enterCar(): void {
    this.inCar = true;
    this.impacts = new ImpactDetector();
    this.d.mixer.oneShot('doorOpen', { gain: MIX.doors });
    this.d.mixer.setInCar(true);
  }

  doorClosed(): void {
    this.d.mixer.oneShot('doorClose', { gain: MIX.doors });
  }

  crank(): void {
    this.starter?.stop();
    this.starter = this.d.mixer.oneShot('engineStart', { gain: MIX.engine });
  }

  /** The engine has caught: engine voices (once loaded + unlocked) and the radio. */
  engineRunning(): void {
    if (!this.inCar || this.engineOn) return;
    this.engineOn = true;
    this.starter = null; // the clip's own idle tail may play out
    this.startLoops();
    this.tune(this.d.tuner.enterCar());
  }

  exitCar(): void {
    const running = this.engineOn;
    this.starter?.stop(); // left while cranking: no engine
    this.starter = null;
    this.inCar = false;
    this.engineOn = false;
    this.stopStatic();
    this.d.radio.tune(null);
    this.d.tuner.exitCar();
    this.vehicle.stop();
    this.stopHorn();
    if (running) this.d.mixer.oneShot('engineStop', { gain: MIX.engine });
    this.d.mixer.oneShot('doorOpen', { gain: MIX.doors });
    this.d.mixer.oneShot('doorClose', { gain: MIX.doors });
    this.d.mixer.setInCar(false);
  }

  /** Next (1) or previous (-1) station; only in a car with the engine running. */
  radioStep(dir: 1 | -1): void {
    if (!this.radioOn) return;
    this.tune(dir === 1 ? this.d.tuner.next() : this.d.tuner.prev());
  }

  /** Radio wheel pick; only with the engine running. Same station as now: no retune, just the name again. */
  radioSelect(id: StationId | null): void {
    if (!this.radioOn) return;
    if (id === this.d.tuner.current) this.d.flash(stationLabel(id));
    else this.tune(this.d.tuner.select(id));
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

  /** In a car, every frame: impacts, engine and skid voices. Speeds in m/s. */
  drive(s: { forward: number; lateral: number; vx: number; vz: number; throttle: number; handbrake: boolean }, dt: number): void {
    const cueDt = Math.min(dt, MAX_DT);
    // real dt: dv is the change over the whole frame, a clamped dt would inflate the deceleration after a hitch
    const hit = this.impacts.update(s.vx, s.vz, dt);
    if (hit > 0) {
      const id: SoundId = hit >= 0.7 ? 'impact3' : hit >= 0.35 ? 'impact2' : 'impact1';
      this.d.mixer.oneShot(id, { gain: hit * MIX.impact });
    }
    this.vehicle.update({ speed: s.forward, throttle: s.throttle, skid: skidAmount(s.forward, s.lateral, s.handbrake) }, cueDt);
  }

  /** Getting on a bike: its freewheel ticks (once loaded + unlocked); `soundBox`: the radio comes on through its box. */
  mountBike(soundBox = false): void {
    this.riding = true;
    this.startLoops();
    if (soundBox) {
      this.boxRadio = true;
      this.tune(this.d.tuner.enterCar());
    }
  }

  dismountBike(): void {
    this.riding = false;
    this.bike.stop();
    if (this.boxRadio) {
      this.boxRadio = false;
      this.stopStatic();
      this.d.radio.tune(null);
      this.d.tuner.exitCar();
    }
  }

  /** On a bike, every frame: freewheel ticks while coasting. Speed in m/s. */
  ride(s: { speed: number; pedalling: boolean; grounded: boolean }, dt: number): void {
    this.bike.update(s, Math.min(dt, MAX_DT));
  }

  /** H on the bike. */
  bell(): void {
    this.bike.bell();
  }

  /** In a car, every frame: the horn sounds while H is held (a tap still gives a short toot). Works without the engine. */
  horn(held: boolean, dt: number): void {
    const on = this.inCar && this.hornState.update(this.inCar && held, Math.min(dt, MAX_DT));
    if (on && !this.hornVoice && this.loaded && this.unlocked) {
      this.hornVoice = this.d.mixer.loop('carHorn', 'sfx');
      this.hornVoice.setGain(MIX.horn);
    } else if (!on) this.stopHorn();
  }

  /** Fell off the bike. */
  crashBike(): void {
    this.d.mixer.oneShot('impact2', { gain: MIX.impact * 0.7 });
  }

  /** Online, every frame: the other players' cars (engines, horns, radio) around `listener`. */
  remoteCars(listener: { x: number; z: number }, cars: readonly RemoteCarIn[], dt: number): void {
    if (this.loaded && this.unlocked) this.d.remote?.update(listener, cars, Math.min(dt, MAX_DT));
  }

  /** Another rider's bell at (x, z). */
  bellAt(x: number, z: number): void {
    this.d.mixer.oneShot('bikeBell', { gain: MIX.bikeBell, at: { x, z } });
  }

  /** A car hit someone at (x, z); strength: the car's speed (m/s). */
  impactAt(x: number, z: number, strength: number): void {
    const hit = Math.min(1, Math.max(0.35, strength / 20));
    const id: SoundId = hit >= 0.7 ? 'impact3' : hit >= 0.45 ? 'impact2' : 'impact1';
    this.d.mixer.oneShot(id, { gain: hit * MIX.impact, at: { x, z } });
  }

  /** Someone was knocked down at (x, z). */
  knockAt(x: number, z: number): void {
    this.d.mixer.oneShot('impact1', { gain: 0.5 * MIX.impact, at: { x, z } });
  }

  /** Every frame: listener pose (yaw: forward = (sin, cos)) and the tram bell near the nearest stop. */
  listener(x: number, z: number, yaw: number, nearestTramStop: { x: number; z: number; dist: number } | null, dt: number): void {
    this.d.mixer.setListener(x, z, yaw);
    if (nearestTramStop && this.tramBell.update(Math.min(dt, MAX_DT), nearestTramStop.dist)) {
      this.d.mixer.oneShot('tramBell', { gain: MIX.tramBell, at: { x: nearestTramStop.x, z: nearestTramStop.z } });
    }
  }

  /** The radio is on: engine running, or sitting on the sound Long John. */
  private get radioOn(): boolean {
    return this.engineOn || this.boxRadio;
  }

  private tune(id: StationId | null): void {
    this.stopStatic(); // Radio never reports 'playing' after a retune
    this.d.radio.tune(id);
    this.d.flash(stationLabel(id));
  }

  private stopHorn(): void {
    this.hornVoice?.stop();
    this.hornVoice = null;
    this.hornState.reset();
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
    if (this.riding) this.bike.start();
  }
}
