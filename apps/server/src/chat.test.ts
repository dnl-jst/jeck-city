import { describe, expect, it } from 'vitest';
import { ChatThrottle } from './chat.js';

describe('ChatThrottle', () => {
  it('allows a burst of 5, warns once, then drops', () => {
    const t = new ChatThrottle();
    for (let i = 0; i < 5; i++) expect(t.take(0)).toBe('ok');
    expect(t.take(0)).toBe('warn');
    expect(t.take(0)).toBe('drop');
  });

  it('starts a new throttle phase after an ok', () => {
    const t = new ChatThrottle();
    for (let i = 0; i < 5; i++) t.take(0);
    t.take(0);
    t.take(0);
    expect(t.take(2000)).toBe('ok');
    expect(t.take(2000)).toBe('warn');
  });

  it('caps the refilled supply at the burst size', () => {
    const t = new ChatThrottle();
    for (let i = 0; i < 5; i++) expect(t.take(0)).toBe('ok');
    for (let i = 0; i < 5; i++) expect(t.take(10_000)).toBe('ok');
    expect(t.take(10_000)).toBe('warn');
  });
});
