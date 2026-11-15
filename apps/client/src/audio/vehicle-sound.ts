import { engineMix, engineTarget, IDLE_RPM, smoothRpm } from './engine-model';
import { MIX, type LoopVoice } from './mixer';
import { ENGINE_LOOPS, SOUNDS, type SoundId } from './sounds';

const LOOP_RPMS = ENGINE_LOOPS.map((id) => ({ rpm: SOUNDS[id].rpm ?? IDLE_RPM }));

/**
 * One car's voice: engine loops crossfaded by rpm plus a tyre-skid loop.
 * Driven only by vehicle state (never keyboard input), so remote cars can reuse it.
 */
export class VehicleSound {
  private engine: LoopVoice[] = [];
  private skid: LoopVoice | null = null;
  private rpm = IDLE_RPM;

  constructor(private readonly out: { loop(id: SoundId): LoopVoice }) {}

  start(): void {
    if (this.skid) return;
    this.rpm = IDLE_RPM;
    this.engine = ENGINE_LOOPS.map((id) => this.out.loop(id));
    this.skid = this.out.loop('skid');
  }

  stop(): void {
    for (const v of this.engine) v.stop();
    this.skid?.stop();
    this.engine = [];
    this.skid = null;
  }

  /** speed in m/s (sign ignored), throttle -1..1, skid 0..1. */
  update(s: { speed: number; throttle: number; skid: number }, dt: number): void {
    if (!this.skid) return;
    const kmh = Math.abs(s.speed) * 3.6;
    this.rpm = smoothRpm(this.rpm, engineTarget(kmh, s.throttle).rpm, dt);
    const mix = engineMix(this.rpm, LOOP_RPMS);
    this.engine.forEach((v, i) => {
      const m = mix[i];
      if (!m) return;
      v.setGain(m.gain * MIX.engine);
      v.setRate(m.rate);
    });
    this.skid.setGain(s.skid * MIX.skid);
    this.skid.setRate(0.9 + 0.2 * s.skid);
  }
}
