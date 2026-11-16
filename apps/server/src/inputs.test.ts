import { describe, expect, it } from 'vitest';
import { MAX_INPUTS_PER_S, NEUTRAL_INPUT, type InputPacket, type PlayerInput } from '@nn/shared';
import { InputQueue } from './inputs';

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({ ...NEUTRAL_INPUT(0.5), ...over });
const packet = (seq: number, inputs: PlayerInput[]): InputPacket => ({ seq, tick: 0, inputs });

describe('InputQueue', () => {
  it('missing input is neutral, not repeated', () => {
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
    expect(accepted).toBeLessThanOrEqual(MAX_INPUTS_PER_S + 6);
    expect(accepted).toBeGreaterThanOrEqual(MAX_INPUTS_PER_S - 1);
  });

  it('queue keeps newest 6', () => {
    const q = new InputQueue(0);
    for (let n = 1; n <= 9; n++) q.push(packet(n, [input({ forward: n / 10 })]), n * 20);
    expect(q.size).toBe(6);
    const got: number[] = [];
    while (q.size > 0) got.push(Math.round(q.next().forward * 10));
    expect(got).toEqual([4, 5, 6, 7, 8, 9]);
    expect(q.ackSeq).toBe(9);
  });
});
