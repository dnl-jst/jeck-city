import { expect, test } from 'vitest';
import { OPEN_METEO_URL, UNKNOWN_WEATHER, WEATHER_PRESETS, parseOpenMeteo, weatherCode, weatherPreset } from './weather';

test('weatherCode maps WMO codes', () => {
  const table: [number, string, string][] = [
    [0, 'clear', 'klar'], [1, 'clear', 'überwiegend klar'], [2, 'cloudy', 'teils bewölkt'], [3, 'cloudy', 'bedeckt'],
    [45, 'fog', 'Nebel'], [48, 'fog', 'Reifnebel'],
    [51, 'drizzle', 'leichter Nieselregen'], [53, 'drizzle', 'Nieselregen'], [55, 'drizzle', 'starker Nieselregen'],
    [56, 'drizzle', 'gefrierender Nieselregen'], [57, 'drizzle', 'gefrierender Nieselregen'],
    [61, 'rain', 'leichter Regen'], [63, 'rain', 'Regen'], [65, 'rain', 'starker Regen'],
    [66, 'rain', 'gefrierender Regen'], [67, 'rain', 'gefrierender Regen'],
    [71, 'snow', 'leichter Schneefall'], [73, 'snow', 'Schneefall'], [75, 'snow', 'starker Schneefall'], [77, 'snow', 'Schneegriesel'],
    [80, 'rain', 'leichte Regenschauer'], [81, 'rain', 'Regenschauer'], [82, 'rain', 'heftige Regenschauer'],
    [85, 'snow', 'Schneeschauer'], [86, 'snow', 'starke Schneeschauer'],
    [95, 'rain', 'Gewitter'], [96, 'rain', 'Gewitter mit Hagel'], [99, 'rain', 'Gewitter mit Hagel'],
  ];
  for (const [code, kind, label] of table) expect(weatherCode(code), String(code)).toEqual({ kind, label });
  for (const bad of [4, -1, 1.5]) expect(weatherCode(bad)).toBeNull();
});

const current = {
  time: '2026-11-17T12:00', interval: 900, temperature_2m: 7.2, weather_code: 61, cloud_cover: 100,
  precipitation: 0.3, visibility: 12000, wind_speed_10m: 18, wind_direction_10m: 250,
};
const parse = (over: Record<string, unknown>) => parseOpenMeteo({ current: { ...current, ...over } }, 5);

test('parseOpenMeteo parses a sample', () => {
  const w = parseOpenMeteo({ current }, 1234)!;
  expect(w).toMatchObject({
    known: true, kind: 'rain', label: 'leichter Regen', cloud: 1, snow: false, updatedAt: 1234,
    visibility: 12000, windSpeed: 18, windDir: 250, temperature: 7.2,
  });
  expect(w.precip).toBeCloseTo(1.2);
});

test('kind floors on precip', () => {
  expect(parse({ weather_code: 61, precipitation: 0 })!.precip).toBeGreaterThanOrEqual(1);
  expect(parse({ weather_code: 51, precipitation: 0 })!.precip).toBeGreaterThanOrEqual(0.3);
  expect(parse({ weather_code: 71, precipitation: 0 })!.precip).toBeGreaterThanOrEqual(0.5);
});

test('dry kinds never rain, whatever precipitation says', () => {
  for (const code of [0, 1, 2, 3, 45, 48]) expect(parse({ weather_code: code, precipitation: 0.2 })!.precip, String(code)).toBe(0);
});

test('wind and visibility plausibility', () => {
  expect(parse({ wind_speed_10m: -0.1 })).toBeNull();
  expect(parse({ wind_speed_10m: 300.1 })).toBeNull();
  expect(parse({ wind_speed_10m: 0 })!.windSpeed).toBe(0);
  expect(parse({ wind_speed_10m: 300 })!.windSpeed).toBe(300);
  expect(parse({ wind_direction_10m: 360 })!.windDir).toBe(0);
  expect(parse({ wind_direction_10m: 370 })!.windDir).toBe(10);
  expect(parse({ wind_direction_10m: -90 })!.windDir).toBe(270);
  expect(parse({ wind_direction_10m: -0 })!.windDir).toBe(0);
  expect(parse({ visibility: -1 })).toBeNull();
  expect(parse({ visibility: 0 })!.visibility).toBe(0);
});

test('snow flag', () => {
  expect(parse({ weather_code: 73 })!.snow).toBe(true);
});

test('rejects bad input', () => {
  for (const bad of [null, 'x', 5, [], {}, { current: null }, { current: 'x' }]) expect(parseOpenMeteo(bad, 0)).toBeNull();
  for (const f of ['temperature_2m', 'weather_code', 'cloud_cover', 'precipitation', 'visibility', 'wind_speed_10m', 'wind_direction_10m']) {
    const c: Record<string, unknown> = { ...current };
    delete c[f];
    expect(parseOpenMeteo({ current: c }, 0), `missing ${f}`).toBeNull();
    expect(parse({ [f]: null }), `null ${f}`).toBeNull();
    expect(parse({ [f]: NaN }), `NaN ${f}`).toBeNull();
    expect(parse({ [f]: Infinity }), `Inf ${f}`).toBeNull();
    expect(parse({ [f]: '1' }), `string ${f}`).toBeNull();
  }
  expect(parse({ weather_code: 4 })).toBeNull();
  expect(parse({ temperature_2m: -50.1 })).toBeNull();
  expect(parse({ temperature_2m: 60.1 })).toBeNull();
  expect(parse({ cloud_cover: -1 })).toBeNull();
  expect(parse({ cloud_cover: 101 })).toBeNull();
  expect(parse({ precipitation: -0.1 })).toBeNull();
  expect(parse({ interval: 0 })).toBeNull();
  expect(parse({ interval: -900 })).toBeNull();
});

test('missing interval defaults to 900, visibility clamps', () => {
  const { interval: _i, ...noInterval } = current;
  expect(parseOpenMeteo({ current: noInterval }, 0)!.precip).toBeCloseTo(1.2);
  expect(parse({ visibility: 90000 })!.visibility).toBe(50000);
});

test('presets', () => {
  const r = weatherPreset('rain', 99)!;
  expect(r).toMatchObject({ known: true, kind: 'rain', updatedAt: 99 });
  expect(r.precip).toBeGreaterThan(0);
  expect(weatherPreset('nope')).toBeNull();
  expect(weatherPreset(null)).toBeNull();
  expect(weatherPreset(undefined)).toBeNull();
  for (const n of WEATHER_PRESETS) expect(weatherPreset(n), n).not.toBeNull();
  expect(weatherPreset('mist')).toMatchObject({ kind: 'fog', cloud: 1, precip: 0, visibility: 700 });
  expect(UNKNOWN_WEATHER).toMatchObject({ known: false, kind: 'clear', cloud: 0, precip: 0, visibility: 50000, label: '' });
});

test('OPEN_METEO_URL', () => {
  expect(OPEN_METEO_URL).toContain('latitude=50.9375');
  expect(OPEN_METEO_URL).toContain('longitude=6.9603');
  expect(OPEN_METEO_URL).toContain('timezone=Europe%2FBerlin');
  for (const f of ['temperature_2m', 'weather_code', 'cloud_cover', 'precipitation', 'rain', 'showers', 'snowfall', 'visibility', 'wind_speed_10m', 'wind_direction_10m'])
    expect(OPEN_METEO_URL).toContain(f);
  expect(OPEN_METEO_URL).toContain('temperature_2m,weather_code,cloud_cover,precipitation,visibility,wind_speed_10m,wind_direction_10m');
});
