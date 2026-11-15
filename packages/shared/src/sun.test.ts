import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cologneInstantFromLocal, sunState } from './sun';

/**
 * A Date whose local getters (getFullYear … getMinutes) return the given wall-clock fields in browser
 * time zone `tz`. The zone is switched for real (process TZ), so an implementation reading the UTC
 * getters sees different values and fails; the guard below makes sure the switch took effect.
 */
function fakeLocalDate(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  vi.stubEnv('TZ', tz);
  const date = new Date(y, mo, d, h, mi);
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (resolved !== tz) throw new Error(`fakeLocalDate: process time zone is ${resolved}, not ${tz}`);
  return date;
}

// the ISO instants below are read back as wall-clock time of a browser in Köln, whatever the host's zone
beforeEach(() => {
  vi.stubEnv('TZ', 'Europe/Berlin');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const at = (iso: string, o?: string) => sunState(new Date(iso), o);

test('midsummer noon in Köln is high daylight', () => {
  const s = at('2026-06-21T13:30:00+02:00');
  expect(s.altitude * 180 / Math.PI).toBeGreaterThan(55);
  expect(s.nightFactor).toBe(0);
});
test('winter midnight is night', () => expect(at('2026-12-21T00:00:00+01:00').nightFactor).toBe(1));
test('wall-clock time is used regardless of browser timezone', () => {
  // gleicher Wanduhr-Wert 21:00 am 15.11. → Nacht in Köln, egal welche TZ der Browser hat
  const local = fakeLocalDate(2026, 10, 15, 21, 0, 'America/New_York');
  expect(local.getTimezoneOffset()).toBe(300); // really New York (EST), not Berlin or UTC
  expect(cologneInstantFromLocal(local).toISOString()).toBe('2026-11-15T20:00:00.000Z');
});
test('override HH:MM wins', () => expect(at('2026-06-21T13:30:00+02:00', '23:30').nightFactor).toBe(1));
test('invalid override is ignored', () => expect(at('2026-06-21T13:30:00+02:00', '99:xx').nightFactor).toBe(0));
test('DST switch night does not throw', () => expect(() => cologneInstantFromLocal(new Date(2026, 2, 29, 2, 30))).not.toThrow());

test('summer wall clock maps to CEST', () => {
  expect(cologneInstantFromLocal(new Date(2026, 5, 21, 12, 0)).toISOString()).toBe('2026-06-21T10:00:00.000Z');
});
test('nightFactor is linear between +6° and −6° sun altitude', () => {
  // scan an evening in 1-minute steps: wherever the sun is within ±6°, nightFactor = (6° − alt) / 12°
  let checked = 0;
  for (let m = 0; m < 180; m++) {
    const s = sunState(new Date(Date.UTC(2026, 10, 15, 15, m)));
    const deg = s.altitude * 180 / Math.PI;
    if (Math.abs(deg) < 6) {
      expect(s.nightFactor).toBeCloseTo((6 - deg) / 12, 6);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(30);
});
test('azimuth uses the heading convention (direction to sun = (sin az, cos az) in x/z, z south)', () => {
  // around solar noon the sun stands due south: +z
  const s = sunState(new Date('2026-06-21T13:30:00+02:00'));
  expect(Math.cos(s.azimuth)).toBeGreaterThan(0.95);
  // morning: east (+x)
  expect(Math.sin(sunState(new Date('2026-06-21T07:00:00+02:00')).azimuth)).toBeGreaterThan(0.7);
});
