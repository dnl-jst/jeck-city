import { expect, test } from 'vitest';
import { Input } from './input';

const key = (code: string, extra: Partial<{ repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

test('WASD and arrows give forward/right axes, Shift runs, Space brakes', () => {
  const i = new Input();
  i.keyDown(key('KeyW'));
  i.keyDown(key('ArrowRight'));
  i.keyDown(key('ShiftLeft'));
  i.keyDown(key('Space'));
  expect(i.axes()).toEqual({ forward: 1, right: 1 });
  expect(i.run()).toBe(true);
  expect(i.brake()).toBe(true);
  i.keyDown(key('KeyS'));
  expect(i.axes().forward).toBe(0);
  i.keyUp(key('KeyW'));
  i.keyUp(key('ArrowRight'));
  expect(i.axes()).toEqual({ forward: -1, right: 0 });
});

test('E toggles once per press: key repeat is ignored, the press is consumed', () => {
  const i = new Input();
  i.keyDown(key('KeyE'));
  i.keyDown(key('KeyE', { repeat: true }));
  expect(i.consume('KeyE')).toBe(true);
  expect(i.consume('KeyE')).toBe(false);
  i.keyDown(key('KeyE', { repeat: true }));
  expect(i.consume('KeyE')).toBe(false);
  i.keyUp(key('KeyE'));
  i.keyDown(key('KeyE'));
  expect(i.consume('KeyE')).toBe(true);
});

test('keys with ctrl/meta/alt are ignored (browser shortcuts)', () => {
  const i = new Input();
  i.keyDown(key('KeyW', { metaKey: true }));
  i.keyDown(key('KeyE', { ctrlKey: true }));
  i.keyDown(key('KeyD', { altKey: true }));
  expect(i.axes()).toEqual({ forward: 0, right: 0 });
  expect(i.consume('KeyE')).toBe(false);
});

test('releaseAll (window blur) lets go of every key and pending press', () => {
  const i = new Input();
  i.keyDown(key('KeyW'));
  i.keyDown(key('KeyE'));
  i.releaseAll();
  expect(i.axes().forward).toBe(0);
  expect(i.consume('KeyE')).toBe(false);
});

test('mouse movement accumulates until taken', () => {
  const i = new Input();
  i.mouseMove(10, -4);
  i.mouseMove(5, 2);
  expect(i.takeMouse()).toEqual({ dx: 15, dy: -2 });
  expect(i.takeMouse()).toEqual({ dx: 0, dy: 0 });
});
