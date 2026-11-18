import { describe, expect, it } from 'vitest';
import { JOIN_PER_IP_PER_MIN, MAX_PLAYERS } from '@nn/shared';
import { loadConfig, PLAYER_LIMIT } from './config';

describe('loadConfig', () => {
  it('MAX_PLAYERS defaults to 40 and can be raised up to 100 by the environment', () => {
    expect(MAX_PLAYERS).toBe(40);
    expect(loadConfig({}).maxPlayers).toBe(40);
    expect(loadConfig({ MAX_PLAYERS: '100' }).maxPlayers).toBe(PLAYER_LIMIT);
    expect(() => loadConfig({ MAX_PLAYERS: '101' })).toThrow();
    expect(() => loadConfig({ MAX_PLAYERS: '0' })).toThrow();
  });

  it('NN_NPCS switches the NPCs off (default on)', () => {
    expect(loadConfig({}).npcs).toBe(true);
    expect(loadConfig({ NN_NPCS: 'off' }).npcs).toBe(false);
    expect(loadConfig({ NN_NPCS: 'on' }).npcs).toBe(true);
    expect(() => loadConfig({ NN_NPCS: 'maybe' })).toThrow();
  });

  it('PUBLIC_URL becomes a scheme-less public address (the client adds wss:// itself)', () => {
    expect(loadConfig({}).publicUrl).toBeNull();
    expect(loadConfig({ PUBLIC_URL: 'https://nippes.example.org/' }).publicUrl).toBe('nippes.example.org');
    expect(loadConfig({ PUBLIC_URL: 'nippes.example.org:8443/game' }).publicUrl).toBe('nippes.example.org:8443/game');
    expect(loadConfig({ PUBLIC_URL: 'https://' }).publicUrl).toBeNull();
  });

  it('NN_JOIN_PER_MIN raises the join limit in dev only', () => {
    expect(loadConfig({}).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(loadConfig({ NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(200);
    expect(loadConfig({ NODE_ENV: 'production', NN_JOIN_PER_MIN: '200' }).joinPerMin).toBe(JOIN_PER_IP_PER_MIN);
    expect(() => loadConfig({ NN_JOIN_PER_MIN: 'x' })).toThrow();
  });

  it('NN_WEATHER: live by default, off anywhere, presets in dev only, junk throws', () => {
    expect(loadConfig({}).weather).toBe('live');
    expect(loadConfig({ NN_WEATHER: 'off' }).weather).toBe('off');
    expect(loadConfig({ NN_WEATHER: 'off', NODE_ENV: 'production' }).weather).toBe('off');
    expect(loadConfig({ NN_WEATHER: 'rain' }).weather).toMatchObject({ fixed: { kind: 'rain', known: true } });
    expect(loadConfig({ NN_WEATHER: 'rain', NODE_ENV: 'production' }).weather).toBe('live');
    expect(() => loadConfig({ NN_WEATHER: 'banana' })).toThrow(/live.*off.*heavyrain/);
  });
});
