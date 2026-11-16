import { describe, expect, test } from 'vitest';
import type { SnapshotCar } from '@nn/shared';
import type { PositionalLoopVoice, StreamOut } from './mixer';
import { RemoteAudio, RemoteCarFeed, type RemoteCarIn, type RemoteMixer, type RemoteStreamEl } from './remote-audio';
import { STATIONS } from './stations';

interface FakeVoice extends PositionalLoopVoice { id: string; gain: number; stopped: boolean; x: number; z: number }
interface FakeEl {
  el: RemoteStreamEl; listeners: Map<string, () => void>; paused: boolean; src: string; crossOrigin: string | null; muted: boolean;
  out: { gain: number; x: number; z: number; closed: boolean };
}

function setup(attachOk = true) {
  const voices: FakeVoice[] = [];
  const els: FakeEl[] = [];
  const mixer: RemoteMixer = {
    loopAt: (id) => {
      const v: FakeVoice = {
        id, gain: 0, stopped: false, x: 0, z: 0,
        setGain(g) { v.gain = g; }, setRate() {}, setPosition(x, z) { v.x = x; v.z = z; }, stop() { v.stopped = true; },
      };
      voices.push(v);
      return v;
    },
    attachStream: (el) => {
      if (!attachOk) return null;
      const f = els.find((e) => e.el === el)!;
      const out: StreamOut = {
        setPosition(x, z) { f.out.x = x; f.out.z = z; }, setGain(g) { f.out.gain = g; }, close() { f.out.closed = true; },
      };
      return out;
    },
  };
  const make = (): RemoteStreamEl => {
    const listeners = new Map<string, () => void>();
    const f: FakeEl = {
      listeners, paused: false, src: '', crossOrigin: null, muted: false, out: { gain: 0, x: 0, z: 0, closed: false },
      el: null as unknown as RemoteStreamEl,
    };
    f.el = {
      get src() { return f.src; }, set src(v) { f.src = v; },
      get crossOrigin() { return f.crossOrigin; }, set crossOrigin(v) { f.crossOrigin = v; },
      get muted() { return f.muted; }, set muted(v) { f.muted = v; },
      volume: 1,
      play: () => Promise.resolve(), pause: () => { f.paused = true; }, load() {}, removeAttribute() { f.src = ''; },
      addEventListener: ((t: string, cb: () => void) => { listeners.set(t, cb); }) as RemoteStreamEl['addEventListener'],
    };
    els.push(f);
    return f.el;
  };
  return { audio: new RemoteAudio(mixer, make), voices, els };
}

const car = (id: number, x: number, o: Partial<RemoteCarIn> = {}): RemoteCarIn => ({
  id, x, z: 0, speed: 10, accel: 0.5, engine: 'running', radio: null, horn: false, ...o,
});
const L = { x: 0, z: 0 };

describe('RemoteAudio', () => {
  test('at most 6 engine voices, nearest first', () => {
    const { audio, voices } = setup();
    const cars = Array.from({ length: 9 }, (_, i) => car(i + 1, (9 - i) * 10)); // car 9 is nearest
    audio.update(L, cars, 0.6);
    expect(audio.stats.engines).toBe(6);
    expect([...audio.engineLevels().keys()].sort()).toEqual([4, 5, 6, 7, 8, 9]);
    expect(voices.length).toBe(6 * 3); // idle, mid, high per car, no skid
    // a farther car never displaces nearer ones; a car that moves in does
    audio.update(L, cars.map((c) => (c.id === 1 ? { ...c, x: 1 } : c)), 0.016);
    expect([...audio.engineLevels().keys()].sort()).toEqual([1, 4, 5, 6, 7, 8, 9]);
  });

  test('a car leaving the nearest 6 fades out, not cut', () => {
    const { audio, voices } = setup();
    const cars = Array.from({ length: 7 }, (_, i) => car(i + 1, 10 + i * 10));
    audio.update(L, cars, 0.6);
    expect(audio.engineLevels().get(1)).toBe(1);
    audio.update(L, cars.map((c) => (c.id === 7 ? { ...c, x: 1 } : c)), 0.2); // car 6 drops out
    const lvl = audio.engineLevels().get(6)!;
    expect(lvl).toBeGreaterThan(0);
    expect(lvl).toBeLessThan(1);
    expect(voices.filter((v) => v.stopped).length).toBe(0);
    for (let i = 0; i < 5; i++) audio.update(L, cars.map((c) => (c.id === 7 ? { ...c, x: 1 } : c)), 0.2);
    expect(audio.engineLevels().has(6)).toBe(false);
    expect(voices.filter((v) => v.stopped).length).toBe(3);
  });

  test('engines off or starting make no voice; voices sit at the car', () => {
    const { audio, voices } = setup();
    audio.update(L, [car(1, 10, { engine: 'off' }), car(2, 12, { engine: 'starting' }), car(3, 14, { z: 5 })], 0.016);
    expect(audio.stats.engines).toBe(1);
    expect(voices.every((v) => v.x === 14 && v.z === 5)).toBe(true);
  });

  test('horns: one loop per honking car, max 6, released after the minimum tap', () => {
    const { audio, voices } = setup();
    const cars = Array.from({ length: 8 }, (_, i) => car(i + 1, 5 + i, { engine: 'off', horn: true }));
    audio.update(L, cars, 0.016);
    expect(voices.filter((v) => v.id === 'carHorn').length).toBe(6);
    expect(audio.stats.horns).toBe(6);
    audio.update(L, cars.map((c) => ({ ...c, horn: false })), 0.05);
    expect(voices.some((v) => v.stopped)).toBe(false); // tap still sounds
    audio.update(L, cars.map((c) => ({ ...c, horn: false })), 0.5);
    expect(voices.filter((v) => v.stopped).length).toBe(6);
    expect(audio.stats.horns).toBe(0);
  });
});

describe('RemoteRadio', () => {
  test('remote radio only nearest within 25 m', () => {
    const { audio, els } = setup();
    audio.update(L, [car(1, 30, { radio: 'einslive' })], 0.016);
    expect(els.length).toBe(0); // out of range
    audio.update(L, [car(1, 30, { radio: 'einslive' }), car(2, 12.5, { radio: 'radiokoeln' }), car(3, 20, { radio: 'koellefornia' })], 0.016);
    expect(els.length).toBe(1);
    expect(els[0]!.src).toBe(STATIONS.find((s) => s.id === 'radiokoeln')!.url);
    expect(els[0]!.crossOrigin).toBe('anonymous');
    expect(audio.stats.radio).toBe('radiokoeln');
    expect(els[0]!.out.gain).toBeGreaterThan(0);
    // linear to 0 at 25 m
    const half = els[0]!.out.gain;
    audio.update(L, [car(2, 24.9, { radio: 'radiokoeln' })], 0.016);
    expect(els[0]!.out.gain).toBeLessThan(half * 0.05);
    audio.update(L, [car(2, 26, { radio: 'radiokoeln' })], 0.016);
    expect(audio.stats.radio).toBeNull();
    expect(els[0]!.out.closed).toBe(true);
  });

  test('switching to another nearest car with another station swaps the element', () => {
    const { audio, els } = setup();
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    audio.update(L, [car(1, 10, { radio: 'einslive' }), car(2, 5, { radio: 'radiokoeln' })], 0.016);
    expect(els.length).toBe(2);
    expect(els[0]!.out.closed).toBe(true);
    expect(audio.stats.radio).toBe('radiokoeln');
  });

  test('cors failure marks station silent, never plays unfiltered', () => {
    const { audio, els } = setup();
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    els[0]!.listeners.get('error')!();
    expect(audio.stats.radio).toBeNull();
    expect(els[0]!.paused).toBe(true);
    for (let i = 0; i < 3; i++) audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    expect(els.length).toBe(1); // no retry for the session
    // other stations still work
    audio.update(L, [car(2, 10, { radio: 'radiokoeln' })], 0.016);
    expect(audio.stats.radio).toBe('radiokoeln');
    // the element is only ever started after it was routed through the filter graph
    const { audio: a2, els: e2 } = setup(false);
    a2.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    expect(e2[0]!.src).toBe('');
  });

  test('muted: remote radio silent', () => {
    const { audio, els } = setup();
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    audio.setMuted(true);
    expect(els[0]!.muted).toBe(true);
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    expect(audio.stats.radio).toBeNull();
    expect(els.length).toBe(1);
    audio.setMuted(false);
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    expect(audio.stats.radio).toBe('einslive');
    audio.setHidden(true);
    audio.update(L, [car(1, 10, { radio: 'einslive' })], 0.016);
    expect(audio.stats.radio).toBeNull();
  });
});

describe('RemoteCarFeed', () => {
  const snap = (id: number, vx: number, horn = false): SnapshotCar => ({
    id, x: 1, y: 0, z: 2, qx: 0, qy: 0, qz: 0, qw: 1, vx, vy: 0, vz: 0, steer: 0, brakeLight: false, hasDriver: true, horn,
  });

  test('skips own and driverless cars, estimates accel 0..1 from speed change', () => {
    const feed = new RemoteCarFeed();
    const info = new Map([
      [1, { driver: 2, level: 1 as const, engine: 'running' as const, radio: 'einslive' as const }],
      [2, { driver: 5, level: 1 as const }],
      [3, { driver: -1, level: 0 as const }],
    ]);
    const at = (v: number) => new Map([['c1', snap(1, v)], ['c2', snap(2, 0)], ['c3', snap(3, 0)]]);
    let out = feed.build(at(0), info, 5, 1 / 60);
    expect(out.map((c) => c.id)).toEqual([1]);
    expect(out[0]).toMatchObject({ engine: 'running', radio: 'einslive', speed: 0 });
    for (let i = 1; i <= 60; i++) out = feed.build(at(i * 0.5), info, 5, 1 / 60); // 30 m/s²
    expect(out[0]!.accel).toBeGreaterThan(0.9);
    expect(out[0]!.accel).toBeLessThanOrEqual(1);
    for (let i = 0; i < 120; i++) out = feed.build(at(30), info, 5, 1 / 60);
    expect(out[0]!.accel).toBeLessThan(0.05);
  });
});
