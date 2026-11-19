import { describe, expect, it } from 'vitest';
import { DEAD_ZONE, lookDelta, RUN_AT, STICK_RADIUS, stickVector, touchPreferred } from './touch';
import { Input, quantizeAxis } from './input';

describe('stickVector', () => {
  it('is zero inside the dead zone', () => {
    expect(stickVector(STICK_RADIUS * DEAD_ZONE * 0.9, 0).mag).toBe(0);
  });
  it('points up for a finger above the centre and saturates at the rim', () => {
    const v = stickVector(0, -STICK_RADIUS * 3);
    expect(v.mag).toBe(1);
    expect(v.y).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(0);
  });
  it('reaches the run threshold before the rim', () => {
    expect(stickVector(STICK_RADIUS * 0.95, 0).mag).toBeGreaterThanOrEqual(RUN_AT);
  });
});

describe('lookDelta', () => {
  it('turns faster the further the stick is pushed (squared)', () => {
    const half = lookDelta(stickVector(STICK_RADIUS * 0.56, 0), 1 / 60).dx;
    const full = lookDelta(stickVector(STICK_RADIUS, 0), 1 / 60).dx;
    expect(full).toBeGreaterThan(half * 3);
  });
  it('pushing up looks up (negative mouse dy)', () => {
    expect(lookDelta(stickVector(0, -STICK_RADIUS), 1 / 60).dy).toBeLessThan(0);
  });
});

describe('touchPreferred', () => {
  it('follows the pointer unless ?touch= forces it', () => {
    expect(touchPreferred(null, true)).toBe(true);
    expect(touchPreferred(null, false)).toBe(false);
    expect(touchPreferred('1', false)).toBe(true);
    expect(touchPreferred('0', true)).toBe(false);
  });
});

describe('Input touch stick', () => {
  it('adds to the keys, clamps, and snaps to the packet grid', () => {
    const i = new Input();
    i.setStick(0.5, -0.3, false);
    expect(i.axes()).toEqual({ forward: quantizeAxis(0.5), right: quantizeAxis(-0.3) });
    expect(Math.round(i.axes().forward * 127)).toBe(i.axes().forward * 127);
    i.keyDown({ code: 'KeyW', repeat: false, ctrlKey: false, metaKey: false, altKey: false });
    expect(i.axes().forward).toBe(1);
  });
  it('runs when pushed far, and a window blur lets go', () => {
    const i = new Input();
    i.setStick(1, 0, true);
    expect(i.run()).toBe(true);
    i.releaseAll();
    expect(i.run()).toBe(false);
    expect(i.axes()).toEqual({ forward: 0, right: 0 });
  });
});
