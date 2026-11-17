import { expect, test } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type { NpcDraw } from './npc-feed';
import { bubbleOpacity, type Bubble } from './speech-bubble';
import { NpcView } from './npc-view';

test('bubbleOpacity: fades in over 0.2 s, out over the last 0.4 s, gone after 3 s and beyond 30 m', () => {
  expect(bubbleOpacity(10, 0)).toBe(0);
  expect(bubbleOpacity(10, 0.1)).toBeCloseTo(0.5, 6);
  expect(bubbleOpacity(10, 1.5)).toBe(1);
  expect(bubbleOpacity(10, 2.8)).toBeCloseTo(0.5, 6);
  expect(bubbleOpacity(10, 3)).toBe(0);
  expect(bubbleOpacity(25, 1.5)).toBeCloseTo(0.5, 6);
  expect(bubbleOpacity(30, 1.5)).toBe(0);
});

class FakeBubble implements Bubble {
  places: number[] = [];
  disposed = false;
  constructor(readonly text: string, readonly all: FakeBubble[]) { all.push(this); }
  place(_x: number, _y: number, _z: number, dist: number, age: number): void { this.places.push(bubbleOpacity(dist, age)); }
  attach(): void {}
  dispose(): void { this.disposed = true; }
}

test('npc view shows a bubble with the line for a say and drops it afterwards', () => {
  const bubbles: FakeBubble[] = [];
  const view = new NpcView(new Scene(), { occluded: () => false, figureFor: () => null, makeBubble: (t) => new FakeBubble(t, bubbles) });
  const camera = new PerspectiveCamera();
  const d = (say: NpcDraw['say']): NpcDraw => ({
    id: 1, kind: 'walker', look: { variant: 0, tint: 0, scale: 1, vehicleType: -1, vehicleColor: 0 },
    pose: { x: 5, y: 0, z: 0, heading: 0, pitch: 0, speed: 0, s: 0, done: false }, action: 'wait', alpha: 1, say, honk: false, planAgeMs: 0,
  });
  view.update([d({ line: 0, age: 0.5 })], camera, 0, 0.016);
  expect(bubbles.length).toBe(1);
  expect(bubbles[0]!.text).toBe('Jank mer us de Föß!');
  expect(bubbles[0]!.places.at(-1)).toBe(1);
  view.update([d(null)], camera, 0, 0.016);
  expect(bubbles[0]!.disposed).toBe(true);
});
