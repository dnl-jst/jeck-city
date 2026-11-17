import { describe, expect, it } from 'vitest';
import { UNKNOWN_WEATHER, weatherPreset } from '@nn/shared';
import { BLEND_S, CLEAR_LOOK, WeatherBlend, weatherLook } from './look';

const p = (n: string) => weatherPreset(n, 1)!;

describe('weatherLook', () => {
  it('unknown weather is the clear look', () => {
    expect(weatherLook(UNKNOWN_WEATHER)).toEqual(CLEAR_LOOK);
    expect(CLEAR_LOOK).toEqual({ overcast: 0, visibility: 50000, rain: 0, snow: 0, windX: 0, windZ: 0 });
  });
  it('rain is overcast rain without snow', () => {
    const l = weatherLook(p('rain'));
    expect(l.rain).toBeGreaterThan(0);
    expect(l.snow).toBe(0);
    expect(l.overcast).toBeGreaterThanOrEqual(0.85);
  });
  it('snow is snow without rain', () => {
    const l = weatherLook(p('snow'));
    expect(l.snow).toBeGreaterThan(0);
    expect(l.rain).toBe(0);
  });
  it('heavy rain saturates', () => {
    expect(weatherLook(p('heavyrain')).rain).toBe(1);
  });
  it('wind from west blows east, from north blows south', () => {
    const w = { ...UNKNOWN_WEATHER, windSpeed: 36, windDir: 270 };
    const l = weatherLook(w);
    expect(l.windX).toBeCloseTo(10, 5);
    expect(l.windZ).toBeCloseTo(0, 5);
    expect(weatherLook({ ...w, windDir: 0 }).windZ).toBeGreaterThan(0);
  });
});

describe('WeatherBlend', () => {
  it('first set is instant, later sets fade', () => {
    const b = new WeatherBlend();
    const rain = p('rain');
    b.set(rain);
    expect(b.update(0.016)).toEqual(weatherLook(rain));
    b.set(p('clear'));
    const mid = b.update(4);
    expect(mid.rain).toBeGreaterThan(0);
    expect(mid.rain).toBeLessThan(weatherLook(rain).rain);
    expect(b.update(BLEND_S - 4 + 0.1)).toEqual(weatherLook(p('clear')));
  });
  it('a new set mid-fade starts from the current look', () => {
    const b = new WeatherBlend();
    b.set(p('rain'));
    b.update(0.016);
    b.set(p('clear'));
    const mid = b.update(4);
    b.set(p('snow'));
    const after = b.update(0);
    expect(after.rain).toBeCloseTo(mid.rain, 9);
  });
  it('offer reacts to in-place mutation of the same object', () => {
    const b = new WeatherBlend();
    const w = { ...p('rain') };
    b.offer(w);
    b.update(0.016);
    w.kind = 'clear'; w.precip = 0; w.updatedAt = 2;
    b.offer(w);
    const mid = b.update(4);
    expect(mid.rain).toBeGreaterThan(0);
    expect(mid.rain).toBeLessThan(weatherLook(p('rain')).rain);
  });
  it('offer of an unchanged weather does not restart a fade', () => {
    const b = new WeatherBlend();
    const w = { ...p('rain') };
    b.offer(w);
    b.update(0.016);
    b.offer({ ...p('clear'), updatedAt: 5 });
    b.update(4);
    b.offer({ ...p('clear'), updatedAt: 5 });
    expect(b.update(4.1)).toEqual(weatherLook(p('clear')));
  });
});
