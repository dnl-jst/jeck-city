import { describe, expect, it } from 'vitest';
import { MAX_INPUTS_PER_S, NEUTRAL_INPUT, type InputPacket, type PlayerInput } from '@nn/shared';
import { InputQueue } from './inputs';

const input = (over: Partial<PlayerInput> = {}): PlayerInput => ({ ...NEUTRAL_INPUT(0.5), ...over });
const packet = (seq: number, inputs: PlayerInput[]): InputPacket => ({ seq, tick: 0, inputs });

describe('InputQueue', () => {
  it('missing input is neutral, not repeated', () => {
    const q = new InputQueue(0);
    q.push(packet(1, [input({ forward: 1, yaw: 1.25 })]), 0);
    expect(q.next().forward).toBe(1);
    const second = q.next();
    expect(second).toEqual(NEUTRAL_INPUT(1.25));
    expect(second.forward).toBe(0);
    expect(second.yaw).toBe(1.25);
  });

  it('duplicate and old seqs are ignored', () => {
    const q = new InputQueue(0);
    q.push(packet(10, [input({ forward: 1 }), input({ forward: 0.5 })]), 0); // seqs 10, 11
    q.push(packet(10, [input({ forward: -1 }), input({ forward: -1 })]), 1); // duplicates
    q.push(packet(5, [input({ forward: -1 })]), 2); // old
    q.push(packet(11, [input({ forward: -1 }), input({ right: 1 })]), 3); // 11 duplicate, 12 new
    const got = [q.next(), q.next(), q.next(), q.next()];
    expect(got.map((i) => [i.forward, i.right])).toEqual([[1, 0], [0.5, 0], [0, 1], [0, 0]]);
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
