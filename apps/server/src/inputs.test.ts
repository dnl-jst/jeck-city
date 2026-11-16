import { describe, expect, it } from 'vitest';
import { MAX_INPUTS_PER_S, NEUTRAL_INPUT, type InputPacket, type PlayerInput } from '@nn/shared';
import { INPUT_BURST, InputQueue, QUEUE_MAX, TRIM_TO, TRIM_WINDOW } from './inputs';

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({ ...NEUTRAL_INPUT(0.5), ...over });
const packet = (seq: number, inputs: PlayerInput[]): InputPacket => ({ seq, tick: 0, inputs });

describe('InputQueue', () => {
  it('missing input repeats continuous fields ≤ 6 ticks, then neutral', () => {
    const q = new InputQueue(0);
    q.push(packet(1, [input({ forward: 1, right: -1, brake: true, use: true, jump: true, bell: true, horn: true, yaw: 1.25 })]), 0);
    expect(q.next().forward).toBe(1);
    // up to 6 dry ticks: continuous fields repeated, pulses cleared
    for (let i = 0; i < 6; i++) {
      const r = q.next();
      expect(r).toMatchObject({ forward: 1, right: -1, brake: true, horn: true, yaw: 1.25, use: false, jump: false });
      expect(r.bell).toBeFalsy();
    }
    // from the 7th on: neutral with the last yaw
    for (let i = 0; i < 3; i++) expect(q.next()).toEqual(NEUTRAL_INPUT(1.25));
    // a new input restarts the repeat window
    q.push(packet(2, [input({ forward: 0.5, yaw: 2 })]), 100);
    q.next();
    expect(q.next().forward).toBe(0.5);
  });

  it('a driver that stopped sending gets neutral input after 100 ms: the car rolls out', () => {
    const q = new InputQueue(0);
    q.push(packet(1, [input({ forward: 1 })]), 0);
    q.next();
    const throttle = Array.from({ length: 60 }, () => q.next().forward);
    expect(throttle.filter((f) => f > 0)).toHaveLength(6);
    expect(throttle.slice(6).every((f) => f === 0)).toBe(true);
  });

  it('duplicate and old seqs are ignored', () => {
    const q = new InputQueue(0);
    q.push(packet(10, [input({ forward: 1 }), input({ forward: 0.5 })]), 0); // seqs 10, 11
    q.push(packet(10, [input({ forward: -1 }), input({ forward: -1 })]), 1); // duplicates
    q.push(packet(5, [input({ forward: -1 })]), 2); // old
    q.push(packet(11, [input({ forward: -1 }), input({ right: 1 })]), 3); // 11 duplicate, 12 new
    const got = [q.next(), q.next(), q.next(), q.next()]; // the 4th is a dry tick: repeats the last
    expect(got.map((i) => [i.forward, i.right])).toEqual([[1, 0], [0.5, 0], [0, 1], [0, 1]]);
    expect(q.ackSeq).toBe(12);
  });

  it('rate limit drops excess', () => {
    const q = new InputQueue(0);
    let accepted = 0;
    for (let n = 0; n < 300; n++) {
      // 300 single-input packets spread over one second; drain each time so the queue cap does not interfere
      q.push(packet(n + 1, [input({ forward: 1 })]), (n * 1000) / 300);
      while (q.size > 0) {
        q.next();
        accepted++;
      }
    }
    expect(accepted).toBeLessThanOrEqual(MAX_INPUTS_PER_S + INPUT_BURST);
    expect(accepted).toBeGreaterThanOrEqual(MAX_INPUTS_PER_S - 1);
  });

  it(`queue keeps newest ${QUEUE_MAX}`, () => {
    const q = new InputQueue(0);
    const n = QUEUE_MAX + 3;
    for (let k = 1; k <= n; k++) q.push(packet(k, [input({ forward: k / 100 })]), k * 20);
    expect(q.size).toBe(QUEUE_MAX);
    const got: number[] = [];
    while (q.size > 0) got.push(Math.round(q.next().forward * 100));
    expect(got).toEqual(Array.from({ length: QUEUE_MAX }, (_, k) => k + 4));
    expect(q.ackSeq).toBe(n);
  });

  it('a slow client\'s bunched frame (8 steps in packets of 3) is queued whole', () => {
    const q = new InputQueue(0);
    for (let frame = 0; frame < 20; frame++) {
      // 7.5 fps: 8 steps every 133 ms, 3 packets at once; the server ticks 8 times until the next frame
      const seq = frame * 8 + 1;
      const all = Array.from({ length: 8 }, (_, k) => input({ forward: (seq + k) / 1000 }));
      for (const at of [0, 3, 6]) q.push(packet(seq + at, all.slice(at, at + 3)), frame * 133);
      expect(q.size).toBe(8);
      for (let k = 0; k < 8; k++) {
        expect(q.next().forward).toBeCloseTo((seq + k) / 1000);
        expect(q.ackSeq).toBe(seq + k);
      }
    }
  });

  it('a standing backlog (late burst after a stall) is trimmed one input per tick; pulses survive', () => {
    const q = new InputQueue(0);
    let seq = 1;
    const send = (over: Partial<PlayerInput> = {}) => q.push(packet(seq++, [input({ forward: 1, ...over })]), seq * 16);
    // a 60 Hz client one input ahead: it arrives each tick before the server takes one
    for (let t = 0; t < 2 * TRIM_WINDOW; t++) {
      send();
      q.next();
    }
    expect(q.size).toBe(0);
    // a stall: 12 inputs arrive at once (the server ran dry meanwhile); one of the oldest is an E press
    for (let k = 0; k < 12; k++) send(k === 1 ? { use: true } : {});
    const sizes: number[] = [];
    let uses = 0;
    for (let t = 0; t < 3 * TRIM_WINDOW; t++) {
      send();
      sizes.push(q.size); // what the tick finds queued
      if (q.next().use) uses++;
    }
    // one window with the backlog standing, then trimmed down to TRIM_TO, and it stays there
    expect(sizes[TRIM_WINDOW - 2]).toBe(13);
    expect(sizes.at(-1)).toBe(TRIM_TO);
    expect(Math.max(...sizes.slice(2 * TRIM_WINDOW))).toBe(TRIM_TO);
    expect(uses).toBe(1);
  });

  it('a trim that started ends when the backlog is gone: a later bunched frame loses no input', () => {
    const q = new InputQueue(0);
    let seq = 1;
    const send = () => q.push(packet(seq++, [input({ forward: 1 })]), seq * 16);
    for (let k = 0; k < 13; k++) send();
    // one whole window with a standing backlog of 13, then the trim starts (11 to drop)
    for (let t = 0; t < TRIM_WINDOW; t++) {
      send();
      q.next();
    }
    // the client stops sending: the queue drains (trimming a few on the way) and runs dry
    for (let t = 0; t < 30; t++) q.next();
    expect(q.size).toBe(0);
    // much later a bunched frame of 8 arrives: all 8 are applied, in order
    const first = seq;
    const frame = Array.from({ length: 8 }, (_, k) => input({ forward: (first + k) / 1000 }));
    for (const at of [0, 3, 6]) q.push(packet(first + at, frame.slice(at, at + 3)), 10_000);
    seq += 8;
    const got = Array.from({ length: 8 }, () => Math.round(q.next().forward * 1000));
    expect(got).toEqual(Array.from({ length: 8 }, (_, k) => first + k));
  });

  it('a slow client\'s bunched frames are never trimmed (the queue runs empty each frame)', () => {
    const q = new InputQueue(0);
    const got: number[] = [];
    for (let frame = 0; frame < 30; frame++) {
      const seq = frame * 7 + 1;
      // 7 steps per frame (8.6 fps), at once; the server ticks 7 times in between
      q.push(packet(seq, Array.from({ length: 3 }, (_, k) => input({ forward: (seq + k) / 1000 }))), frame * 117);
      q.push(packet(seq + 3, Array.from({ length: 3 }, (_, k) => input({ forward: (seq + 3 + k) / 1000 }))), frame * 117);
      q.push(packet(seq + 6, [input({ forward: (seq + 6) / 1000 })]), frame * 117);
      for (let k = 0; k < 7; k++) got.push(Math.round(q.next().forward * 1000));
    }
    expect(got).toEqual(Array.from({ length: 210 }, (_, k) => k + 1));
  });
});
