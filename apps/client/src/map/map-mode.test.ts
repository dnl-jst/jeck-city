import { describe, expect, it } from 'vitest';
import { MapMode } from './map-mode';

describe('MapMode', () => {
  it('toggle opens and closes', () => {
    const m = new MapMode();
    expect(m.open).toBe(false);
    m.toggle();
    expect(m.open).toBe(true);
    m.toggle();
    expect(m.open).toBe(false);
  });

  it('lock loss closes an open map', () => {
    const m = new MapMode();
    m.toggle();
    m.onLockChange(false);
    expect(m.open).toBe(false);
  });

  it('lock loss with closed map does nothing', () => {
    const m = new MapMode();
    m.onLockChange(false);
    expect(m.open).toBe(false);
    expect(m.takeClosed()).toBe(false);
  });

  it('lock gain never opens', () => {
    const m = new MapMode();
    m.onLockChange(true);
    expect(m.open).toBe(false);
  });

  it('gate neutralises everything while open', () => {
    const m = new MapMode();
    const s = { forward: 1, right: -1, brake: true, run: true };
    expect(m.gate(s)).toEqual(s);
    m.toggle();
    expect(m.gate(s)).toEqual({ forward: 0, right: 0, brake: false, run: false });
  });

  it('takeClosed reports a close once', () => {
    const m = new MapMode();
    m.toggle();
    m.toggle();
    expect(m.takeClosed()).toBe(true);
    expect(m.takeClosed()).toBe(false);
    m.toggle();
    m.onLockChange(false);
    expect(m.takeClosed()).toBe(true);
  });
});
