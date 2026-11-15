import { expect, test } from 'vitest';
import { Radio, RADIO_VOLUME, type StreamElement } from './radio';
import { STATIONS } from './stations';

const url = (id: string) => STATIONS.find((s) => s.id === id)!.url;

class FakeEl {
  src = '';
  muted = false;
  volume = 1;
  playCalls = 0;
  pauses = 0;
  listeners = new Map<string, (() => void)[]>();
  rejectPlay = false;
  resolvers: (() => void)[] = [];
  play(): Promise<void> {
    this.playCalls++;
    if (this.rejectPlay) {
      const e = new Error('blocked');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    }
    return new Promise<void>((res) => this.resolvers.push(res));
  }
  pause(): void {
    this.pauses++;
  }
  load(): void {}
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, fn: () => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function setup(rejectPlay = false) {
  const els: FakeEl[] = [];
  const calls = { connecting: 0, playing: 0, unreachable: 0 };
  const radio = new Radio(
    () => {
      const e = new FakeEl();
      e.rejectPlay = rejectPlay;
      els.push(e);
      return e as unknown as StreamElement;
    },
    {
      onConnecting: () => calls.connecting++,
      onPlaying: () => calls.playing++,
      onUnreachable: () => calls.unreachable++,
    },
  );
  return { els, calls, radio };
}

test('tuning sets the station url and plays', () => {
  const { els, calls, radio } = setup();
  radio.tune('koellefornia');
  expect(els).toHaveLength(1);
  expect(els[0]!.src).toBe(url('koellefornia'));
  expect(els[0]!.volume).toBe(RADIO_VOLUME);
  expect(els[0]!.playCalls).toBe(1);
  expect(calls.connecting).toBe(1);
  els[0]!.fire('playing');
  expect(calls.playing).toBe(1);
  expect(radio.playing).toBe('koellefornia');
});

test('switching stops the previous stream', () => {
  const { els, radio } = setup();
  radio.tune('koellefornia');
  radio.tune('einslive');
  expect(els[0]!.pauses).toBeGreaterThan(0);
  expect(els[0]!.src).toBe('');
  expect(els.filter((e) => e.src !== '')).toHaveLength(1);
  expect(els[1]!.src).toBe(url('einslive'));
});

test('stale events of a previous station are ignored', () => {
  const { els, calls, radio } = setup();
  radio.tune('koellefornia');
  radio.tune('einslive');
  els[0]!.fire('error');
  els[0]!.fire('playing');
  expect(calls.playing).toBe(0);
  expect(calls.unreachable).toBe(0);
  expect(els).toHaveLength(2);
});

test('stop during connect leaves nothing playing', async () => {
  const { els, calls, radio } = setup();
  radio.tune('radiokoeln');
  radio.tune(null);
  els[0]!.resolvers[0]!();
  await Promise.resolve();
  expect(radio.playing).toBeNull();
  expect(calls.playing).toBe(0);
});

test('one retry, then unreachable', () => {
  const { els, calls, radio } = setup();
  radio.tune('radiokoeln');
  els[0]!.fire('error');
  expect(els).toHaveLength(2);
  expect(els[1]!.src).toBe(url('radiokoeln'));
  expect(calls.unreachable).toBe(0);
  els[1]!.fire('error');
  expect(calls.unreachable).toBe(1);
  expect(radio.playing).toBeNull();
  expect(els).toHaveLength(2);
});

test('retries play after unlock', async () => {
  const { els, radio } = setup(true);
  radio.tune('einslive');
  await Promise.resolve();
  await Promise.resolve();
  expect(els[0]!.playCalls).toBe(1);
  els[0]!.rejectPlay = false;
  radio.unlocked();
  expect(els[0]!.playCalls).toBe(2);
  expect(els).toHaveLength(1);
});

test('muted carries over to a new station', () => {
  const { els, radio } = setup();
  radio.setMuted(true);
  radio.tune('einslive');
  expect(els[0]!.muted).toBe(true);
  radio.setMuted(false);
  expect(els[0]!.muted).toBe(false);
});

test('suspend/resume', () => {
  const { els, radio } = setup();
  radio.tune('einslive');
  radio.suspend();
  expect(els[0]!.src).toBe('');
  expect(els[0]!.pauses).toBeGreaterThan(0);
  radio.resume();
  expect(els).toHaveLength(2);
  expect(els[1]!.src).toBe(url('einslive'));
});

test('resume without prior playback creates nothing', () => {
  const { els, radio } = setup();
  radio.resume();
  expect(els).toHaveLength(0);
});
