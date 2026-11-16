import { describe, expect, it } from 'vitest';
import { JOIN_PER_IP_PER_MIN } from '@nn/shared';
import { JoinLimiter } from './join-limit';

describe('JoinLimiter', () => {
  it('rejects the 6th join within 60 s and allows again after 60 s', () => {
    expect(JOIN_PER_IP_PER_MIN).toBe(5);
    const l = new JoinLimiter();
    for (let n = 0; n < 5; n++) expect(l.allow('aaaa1111', n * 1000)).toBe(true);
    expect(l.allow('aaaa1111', 30_000)).toBe(false);
    expect(l.allow('bbbb2222', 30_000)).toBe(true); // other address unaffected
    expect(l.allow('aaaa1111', 59_999)).toBe(false);
    // the first join (t = 0) has left the 60 s window
    expect(l.allow('aaaa1111', 60_000)).toBe(true);
    expect(l.allow('aaaa1111', 60_001)).toBe(false);
  });
});
