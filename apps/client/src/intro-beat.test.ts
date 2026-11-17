import { describe, expect, it } from 'vitest';
import { BeatDetector } from './intro-beat';

describe('BeatDetector', () => {
  it('finds a kick every 400 ms (150 bpm) and nothing in steady sound', () => {
    const d = new BeatDetector();
    const beats: number[] = [];
    for (let f = 0; f < 600; f++) {
      const now = (f * 1000) / 60;
      // steady background, a kick that jumps up and decays every 24 frames (from the 2nd second on)
      const since = f % 24;
      const kick = f >= 60 && since < 8 ? 120 * (1 - since / 8) : 0;
      const spectrum = Array.from({ length: 64 }, (_, i) => 90 + (i >= 1 && i <= 4 ? kick : 0) + ((f * 7 + i) % 3));
      if (d.update(spectrum, now)) beats.push(now);
    }
    expect(beats.length).toBeGreaterThanOrEqual(20);
    expect(beats[0]).toBeGreaterThanOrEqual(1000);
    const gaps = beats.slice(1).map((t, i) => t - beats[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(400, -1);
  });
});
