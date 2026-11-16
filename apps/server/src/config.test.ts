import { describe, expect, it } from 'vitest';
import { JOIN_PER_IP_PER_MIN } from '@nn/shared';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('NN_JOIN_PER_MIN raises the join limit in dev only', () => {
    expect(loadConfig({}).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(loadConfig({ NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(200);
    expect(loadConfig({ NODE_ENV: 'production', NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(() => loadConfig({ NN_JOIN_PER_MIN: 'x' })).toThrow();
  });
});
