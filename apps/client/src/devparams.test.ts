import { describe, expect, it } from 'vitest';
import { devAllowed, parseCamParam, withDateParam } from './devparams';

describe('parseCamParam', () => {
  it('parses x,y,z,yawDeg,pitchDeg', () => {
    expect(parseCamParam('132.5,121.7,-17,180,-45')).toEqual({ x: 132.5, y: 121.7, z: -17, yawDeg: 180, pitchDeg: -45 });
  });
  it('defaults yaw and pitch to 0', () => {
    expect(parseCamParam('1,2,3')).toEqual({ x: 1, y: 2, z: 3, yawDeg: 0, pitchDeg: 0 });
  });
  it('rejects missing or malformed values', () => {
    expect(parseCamParam(null)).toBeNull();
    expect(parseCamParam('1,2')).toBeNull();
    expect(parseCamParam('1,x,3')).toBeNull();
    expect(parseCamParam('1,2,3,4,5,6')).toBeNull();
  });
});

describe('withDateParam', () => {
  const now = new Date(2026, 10, 15, 21, 7, 30);
  it('replaces the local date and keeps the local wall-clock time', () => {
    const d = withDateParam(now, '2026-06-21');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 5, 21, 21, 7, 30]);
  });
  it('returns now unchanged when missing or malformed', () => {
    expect(withDateParam(now, null)).toBe(now);
    expect(withDateParam(now, '2026-13-01')).toBe(now);
    expect(withDateParam(now, '2026-02-30')).toBe(now);
    expect(withDateParam(now, '21.06.2026')).toBe(now);
  });
});

describe('devAllowed', () => {
  const on = { devMode: true }, off = { devMode: false };
  const all = { cam: true, fly: true, writeHooks: true }, none = { cam: false, fly: false, writeHooks: false };
  it('offline keeps today: cam always, fly and write hooks with debug', () => {
    expect(devAllowed('offline', null, false)).toEqual({ cam: true, fly: false, writeHooks: false });
    expect(devAllowed('offline', null, true)).toEqual(all);
    expect(devAllowed('offline', null, false, true)).toEqual({ cam: true, fly: false, writeHooks: true });
  });
  it('online everything needs devMode, debug does not matter', () => {
    expect(devAllowed('online', on, false)).toEqual(all);
    expect(devAllowed('online', on, true)).toEqual(all);
    expect(devAllowed('online', off, false)).toEqual(none);
    expect(devAllowed('online', off, true)).toEqual(none);
    expect(devAllowed('online', null, true)).toEqual(none);
    expect(devAllowed('online', off, false, true)).toEqual(none);
  });
});
