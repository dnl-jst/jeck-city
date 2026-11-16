import { describe, expect, it } from 'vitest';
import { JOIN_PER_IP_PER_MIN, MAX_PLAYERS } from '@nn/shared';
import { loadConfig, PLAYER_LIMIT } from './config';

describe('loadConfig', () => {
  it('MAX_PLAYERS defaults to 60 and can be raised up to 100 by the environment', () => {
    expect(MAX_PLAYERS).toBe(60);
    expect(loadConfig({}).maxPlayers).toBe(60);
    expect(loadConfig({ MAX_PLAYERS: '100' }).maxPlayers).toBe(PLAYER_LIMIT);
    expect(() => loadConfig({ MAX_PLAYERS: '101' })).toThrow();
    expect(() => loadConfig({ MAX_PLAYERS: '0' })).toThrow();
  });

  it('NN_JOIN_PER_MIN raises the join limit in dev only', () => {
    expect(loadConfig({}).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(loadConfig({ NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(200);
    expect(loadConfig({ NODE_ENV: 'production', NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(() => loadConfig({ NN_JOIN_PER_MIN: 'x' })).toThrow();
  });
});
