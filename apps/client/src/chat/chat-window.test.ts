import { describe, expect, it } from 'vitest';
import { windowVisible } from './chat-window';

describe('windowVisible', () => {
  it('stays visible for 15 s after the last activity', () => {
    expect(windowVisible(0, 14_999, false)).toBe(true);
    expect(windowVisible(0, 15_000, false)).toBe(false);
  });
  it('is always visible while open', () => {
    expect(windowVisible(0, 99_999, true)).toBe(true);
  });
});
