import { describe, expect, test } from 'vitest';
import { bubbleSeconds, SpeechBubbles, wrapBubble, type Bubble } from './speech-bubble';

class FakeBubble implements Bubble {
  placed: { x: number; y: number; z: number }[] = [];
  opacity = -1;
  disposed = false;
  constructor(readonly lines: string[]) {}
  place(x: number, y: number, z: number): void { this.placed.push({ x, y, z }); }
  setOpacity(o: number): void { this.opacity = o; }
  attach(): void {}
  dispose(): void { this.disposed = true; }
}

const cam = { x: 0, y: 0, z: 0 };
const origin = () => ({ x: 0, y: 0, z: 0 });
function setup() {
  const made: FakeBubble[] = [];
  const sb = new SpeechBubbles({ add: () => {}, remove: () => {} }, (l) => { const b = new FakeBubble(l); made.push(b); return b; });
  return { sb, made };
}

describe('bubbleSeconds / wrapBubble', () => {
  test('duration grows with length, capped at 10 s', () => {
    expect(bubbleSeconds('hi')).toBeCloseTo(6.1);
    expect(bubbleSeconds('x'.repeat(120))).toBe(10);
  });
  test('wraps to three lines, last ends on an ellipsis', () => {
    const l = wrapBubble('treffen wir uns gleich am Dom oder lieber am Bahnhof Ehrenfeld wenn es regnet und kalt ist');
    expect(l).toHaveLength(3);
    expect(l[2]!.endsWith('…')).toBe(true);
    for (const x of l) expect([...x].length).toBeLessThanOrEqual(28);
  });
  test('splits overlong words', () => {
    expect(wrapBubble('a'.repeat(30))).toEqual(['a'.repeat(28), 'aa']);
  });
});

describe('SpeechBubbles', () => {
  test('places above the anchor, then disposes when expired', () => {
    const { sb, made } = setup();
    sb.say(3, 'hi', 0);
    sb.update(1000, origin, cam);
    expect(made[0]!.placed.at(-1)!.y).toBeCloseTo(0.65);
    expect(made[0]!.opacity).toBe(1);
    sb.update(7000, origin, cam);
    expect(made[0]!.disposed).toBe(true);
  });
  test('a second say replaces the first', () => {
    const { sb, made } = setup();
    sb.say(3, 'eins', 0);
    sb.say(3, 'zwei', 100);
    expect(made[0]!.disposed).toBe(true);
    expect(made[1]!.disposed).toBe(false);
  });
  test('fades out at the end of its life', () => {
    const { sb, made } = setup();
    sb.say(1, 'hi', 0);
    sb.update(6100 + 250, origin, cam);
    expect(made[0]!.opacity).toBeCloseTo(0.5);
  });
  test('without anchor it is hidden but still expires', () => {
    const { sb, made } = setup();
    sb.say(3, 'hi', 0);
    expect(() => sb.update(1000, () => null, cam)).not.toThrow();
    expect(made[0]!.opacity).toBe(0);
    sb.update(7000, () => null, cam);
    expect(made[0]!.disposed).toBe(true);
  });
});
