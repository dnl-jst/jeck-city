/**
 * Beat detection for the intro animation: spectral flux of the kick-drum range (how much the low bins rose since the
 * last frame) against an adaptive threshold (mean + K standard deviations of the last ~¾ s). Tuned on the title song
 * with the analyser's settings (fftSize 1024 → ≈ 47 Hz per bin at 48 kHz, light smoothing): it finds its ≈ 150 bpm.
 */

/** Bins 1–4: ≈ 47–230 Hz, kick and bass. */
const LOW_FROM = 1;
const LOW_TO = 4;
const HISTORY = 45;
const MIN_HISTORY = 20;
const K = 1.2;
/** Flux below this is noise (bytes summed over the low bins). */
const MIN_FLUX = 8;
const COOLDOWN_MS = 200;

export class BeatDetector {
  private prev: number[] = [];
  private readonly history: number[] = [];
  private lastBeat = -Infinity;

  /** Feeds one analyser frame (bytes per bin) at `now` ms; true on a beat. */
  update(spectrum: ArrayLike<number>, now: number): boolean {
    let flux = 0;
    for (let i = LOW_FROM; i <= LOW_TO; i++) {
      const v = spectrum[i] ?? 0;
      flux += Math.max(0, v - (this.prev[i - LOW_FROM] ?? v));
      this.prev[i - LOW_FROM] = v;
    }
    let beat = false;
    if (this.history.length >= MIN_HISTORY) {
      const mean = this.history.reduce((a, b) => a + b, 0) / this.history.length;
      const sd = Math.sqrt(this.history.reduce((a, b) => a + (b - mean) ** 2, 0) / this.history.length);
      if (flux > mean + K * sd && flux > MIN_FLUX && now - this.lastBeat > COOLDOWN_MS) {
        this.lastBeat = now;
        beat = true;
      }
    }
    this.history.push(flux);
    if (this.history.length > HISTORY) this.history.shift();
    return beat;
  }
}
