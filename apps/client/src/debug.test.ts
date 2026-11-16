import { describe, expect, it } from 'vitest';
import { buildViewLink, formatDebugLines, type DebugView } from './debug';
import { parseCamParam } from './devparams';

const v: DebugView = { x: 132.46, y: 1.74, z: -17.04, yawDeg: 179.6, pitchDeg: -44.4, time: '21:05', date: '2026-11-15' };

describe('buildViewLink', () => {
  it('writes cam/time/date/debug with rounded values', () => {
    const u = new URL(buildViewLink('http://localhost:5173/', v));
    expect(u.search).toBe('?cam=132.5%2C1.7%2C-17%2C180%2C-44&time=21%3A05&date=2026-11-15&debug=1');
    expect(u.searchParams.get('cam')).toBe('132.5,1.7,-17,180,-44');
  });
  it('keeps foreign params and replaces existing cam/time/date/debug', () => {
    const u = new URL(buildViewLink('http://x/?foo=bar&cam=1,2,3&time=03:00&date=2020-01-01&debug=0#h', v));
    expect(u.searchParams.get('foo')).toBe('bar');
    expect(u.searchParams.getAll('cam')).toEqual(['132.5,1.7,-17,180,-44']);
    expect(u.searchParams.getAll('time')).toEqual(['21:05']);
    expect(u.searchParams.getAll('date')).toEqual(['2026-11-15']);
    expect(u.searchParams.getAll('debug')).toEqual(['1']);
  });
  it('round-trips through parseCamParam', () => {
    const cam = parseCamParam(new URL(buildViewLink('http://x/', v)).searchParams.get('cam'));
    expect(cam).toEqual({ x: 132.5, y: 1.7, z: -17, yawDeg: 180, pitchDeg: -44 });
  });
});

describe('formatDebugLines', () => {
  it('shows lat/lon with 6 decimals and all fields', () => {
    const lines = formatDebugLines(v, 50.9630937, 6.952182, 60, 123, 7);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('50.963094');
    expect(lines[1]).toContain('6.952182');
    expect(lines[0]).toContain('132.5');
    expect(lines[2]).toContain('180');
    expect(lines[3]).toContain('21:05');
    expect(lines[3]).toContain('2026-11-15');
    expect(lines[4]).toContain('60 fps');
    expect(lines[4]).toContain('123');
  });
  it('adds the net lines online only', () => {
    expect(formatDebugLines(v, 50, 6, 60, 1, 1, null)).toHaveLength(5);
    const lines = formatDebugLines(v, 50, 6, 60, 1, 1, { rttMs: 23.4, snapshotAgeMs: 41.6, predErrorM: 0.0312, players: 7 });
    expect(lines).toHaveLength(9);
    expect(lines[5]).toBe('RTT 23 ms');
    expect(lines[6]).toBe('Snapshot-Alter 42 ms');
    expect(lines[7]).toBe('Vorhersagefehler 0.03 m');
    expect(lines[8]).toBe('Spieler 7');
  });
  it('shows a dash while no snapshot or round trip is known', () => {
    const lines = formatDebugLines(v, 50, 6, 60, 1, 1, { rttMs: Infinity, snapshotAgeMs: Infinity, predErrorM: 0, players: 1 });
    expect(lines[5]).toBe('RTT – ms');
    expect(lines[6]).toBe('Snapshot-Alter – ms');
  });
});
