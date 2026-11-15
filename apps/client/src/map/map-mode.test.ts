import { describe, expect, it } from 'vitest';
import { MapMode } from './map-mode';

const make = (): MapMode => Object.assign(new MapMode(), { enabled: true });

describe('MapMode', () => {
  it('toggle does nothing while disabled', () => {
    const m = new MapMode();
    m.toggle();
    expect(m.open).toBe(false);
    expect(m.takeClosed()).toBe(false);
  });

  it('toggle opens and closes', () => {
    const m = make();
    expect(m.open).toBe(false);
    m.toggle();
    expect(m.open).toBe(true);
    m.toggle();
    expect(m.open).toBe(false);
  });

  it('lock loss closes an open map', () => {
    const m = make();
    m.toggle();
    m.onLockChange(false);
    expect(m.open).toBe(false);
  });

  it('lock loss with closed map does nothing', () => {
    const m = make();
    m.onLockChange(false);
    expect(m.open).toBe(false);
    expect(m.takeClosed()).toBe(false);
  });

  it('lock gain never opens', () => {
    const m = make();
    m.onLockChange(true);
    expect(m.open).toBe(false);
  });

  it('gate neutralises everything while open', () => {
    const m = make();
    const s = { forward: 1, right: -1, brake: true, run: true };
    expect(m.gate(s)).toEqual(s);
    m.toggle();
    expect(m.gate(s)).toEqual({ forward: 0, right: 0, brake: false, run: false });
  });

  it('takeClosed reports a close once', () => {
    const m = make();
    m.toggle();
    m.toggle();
    expect(m.takeClosed()).toBe(true);
    expect(m.takeClosed()).toBe(false);
    m.toggle();
    m.onLockChange(false);
    expect(m.takeClosed()).toBe(true);
  });
});
