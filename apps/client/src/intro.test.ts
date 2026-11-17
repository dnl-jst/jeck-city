import { describe, expect, it } from 'vitest';
import { formatSize, sizeText, skipIntro } from './intro';

describe('formatSize', () => {
  it('rounds up, MB below a gigabyte, GB above', () => {
    expect(formatSize(42_100_000)).toBe('43 MB');
    expect(formatSize(183_000_000)).toBe('190 MB');
    expect(formatSize(1_240_000_000)).toBe('1,3 GB');
  });
});

describe('sizeText', () => {
  it('names the start and the total size', () => {
    expect(sizeText({ start: 183e6, total: 1.24e9 })).toContain('ca. 190 MB');
    expect(sizeText({ start: 183e6, total: 1.24e9 })).toContain('bis zu 1,3 GB');
  });
  it('still warns without a measured world', () => {
    expect(sizeText(null)).toContain('Megabyte');
  });
});

describe('skipIntro', () => {
  it('skips for the dev hooks and ?intro=0, ?intro=1 forces it', () => {
    expect(skipIntro(new URLSearchParams('offline=1'))).toBe(true);
    expect(skipIntro(new URLSearchParams('debug=1'))).toBe(true);
    expect(skipIntro(new URLSearchParams('intro=0'))).toBe(true);
    expect(skipIntro(new URLSearchParams('time=12:00'))).toBe(false);
    expect(skipIntro(new URLSearchParams('offline=1&intro=1'))).toBe(false);
  });
});
