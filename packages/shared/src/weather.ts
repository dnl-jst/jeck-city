/** Köln (Dom). One weather for the whole city. */
export const WEATHER_LAT = 50.9375;
export const WEATHER_LNG = 6.9603;

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow';

export type Weather = {
  /** False until real (or preset) data arrived. */
  known: boolean;
  kind: WeatherKind;
  /** Cloud cover 0..1. */
  cloud: number;
  /** Precipitation, mm/h. */
  precip: number;
  snow: boolean;
  /** Visibility, metres. */
  visibility: number;
  /** Wind speed, km/h. */
  windSpeed: number;
  /** Direction the wind comes from, degrees. */
  windDir: number;
  /** °C. */
  temperature: number;
  /** German description, e.g. "leichter Regen". */
  label: string;
  /** ms epoch of the observation (client/server clock at parse time). */
  updatedAt: number;
};

const MAX_VISIBILITY = 50_000;
/** Wind speeds above this (km/h) are implausible for Cologne: the sample is rejected. */
const MAX_WIND_KMH = 300;

export const UNKNOWN_WEATHER: Weather = {
  known: false, kind: 'clear', cloud: 0, precip: 0, snow: false, visibility: MAX_VISIBILITY,
  windSpeed: 0, windDir: 0, temperature: 10, label: '', updatedAt: 0,
};

const CODES: Record<number, { kind: WeatherKind; label: string }> = {
  0: { kind: 'clear', label: 'klar' },
  1: { kind: 'clear', label: 'überwiegend klar' },
  2: { kind: 'cloudy', label: 'teils bewölkt' },
  3: { kind: 'cloudy', label: 'bedeckt' },
  45: { kind: 'fog', label: 'Nebel' },
  48: { kind: 'fog', label: 'Reifnebel' },
  51: { kind: 'drizzle', label: 'leichter Nieselregen' },
  53: { kind: 'drizzle', label: 'Nieselregen' },
  55: { kind: 'drizzle', label: 'starker Nieselregen' },
  56: { kind: 'drizzle', label: 'gefrierender Nieselregen' },
  57: { kind: 'drizzle', label: 'gefrierender Nieselregen' },
  61: { kind: 'rain', label: 'leichter Regen' },
  63: { kind: 'rain', label: 'Regen' },
  65: { kind: 'rain', label: 'starker Regen' },
  66: { kind: 'rain', label: 'gefrierender Regen' },
  67: { kind: 'rain', label: 'gefrierender Regen' },
  71: { kind: 'snow', label: 'leichter Schneefall' },
  73: { kind: 'snow', label: 'Schneefall' },
  75: { kind: 'snow', label: 'starker Schneefall' },
  77: { kind: 'snow', label: 'Schneegriesel' },
  80: { kind: 'rain', label: 'leichte Regenschauer' },
  81: { kind: 'rain', label: 'Regenschauer' },
  82: { kind: 'rain', label: 'heftige Regenschauer' },
  85: { kind: 'snow', label: 'Schneeschauer' },
  86: { kind: 'snow', label: 'starke Schneeschauer' },
  95: { kind: 'rain', label: 'Gewitter' },
  96: { kind: 'rain', label: 'Gewitter mit Hagel' },
  99: { kind: 'rain', label: 'Gewitter mit Hagel' },
};

/** Maps a WMO weather code to kind and German label; null for unknown codes. */
export function weatherCode(code: number): { kind: WeatherKind; label: string } | null {
  const e = Object.hasOwn(CODES, code) ? CODES[code] : undefined;
  return e ? { ...e } : null;
}

/** Open-Meteo "current" request for Cologne. */
export const OPEN_METEO_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LNG}&timezone=Europe%2FBerlin`
  + '&current=temperature_2m,weather_code,cloud_cover,precipitation,visibility,wind_speed_10m,wind_direction_10m,rain,showers,snowfall';

/** Minimum plausible precipitation (mm/h) for a kind, so rain codes never render dry. */
const KIND_FLOOR: Partial<Record<WeatherKind, number>> = { drizzle: 0.3, rain: 1, snow: 0.5 };

function num(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parses an Open-Meteo response; null when anything required is missing or implausible. */
export function parseOpenMeteo(json: unknown, now: number): Weather | null {
  if (typeof json !== 'object' || json === null) return null;
  const cur = (json as Record<string, unknown>).current;
  if (typeof cur !== 'object' || cur === null) return null;
  const c = cur as Record<string, unknown>;

  const temperature = num(c, 'temperature_2m');
  const code = num(c, 'weather_code');
  const cloudPct = num(c, 'cloud_cover');
  const precipitation = num(c, 'precipitation');
  const visibility = num(c, 'visibility');
  const windSpeed = num(c, 'wind_speed_10m');
  const windDir = num(c, 'wind_direction_10m');
  if (temperature === null || code === null || cloudPct === null || precipitation === null
    || visibility === null || windSpeed === null || windDir === null) return null;

  const interval = c.interval === undefined ? 900 : num(c, 'interval');
  if (interval === null || interval <= 0) return null;
  if (temperature < -50 || temperature > 60) return null;
  if (cloudPct < 0 || cloudPct > 100) return null;
  if (precipitation < 0) return null;
  if (visibility < 0) return null;
  if (windSpeed < 0 || windSpeed > MAX_WIND_KMH) return null;
  const wc = weatherCode(code);
  if (!wc) return null;

  // a dry code (clear/cloudy/fog) never rains, whatever the precipitation field says: the badge must match the sky
  const floor = KIND_FLOOR[wc.kind];
  const precip = floor === undefined ? 0 : Math.max(precipitation * 3600 / interval, floor);
  return {
    known: true, kind: wc.kind, label: wc.label, cloud: cloudPct / 100, precip, snow: wc.kind === 'snow',
    visibility: Math.min(visibility, MAX_VISIBILITY), windSpeed, windDir: ((windDir % 360) + 360) % 360 + 0,
    temperature, updatedAt: now,
  };
}

const PRESETS: Record<string, Omit<Weather, 'known' | 'updatedAt'>> = {
  clear: { kind: 'clear', label: 'klar', cloud: 0.1, precip: 0, snow: false, visibility: MAX_VISIBILITY, windSpeed: 8, windDir: 250, temperature: 18 },
  cloudy: { kind: 'cloudy', label: 'bedeckt', cloud: 1, precip: 0, snow: false, visibility: 20000, windSpeed: 15, windDir: 250, temperature: 12 },
  mist: { kind: 'fog', label: 'Nebel', cloud: 1, precip: 0, snow: false, visibility: 700, windSpeed: 4, windDir: 90, temperature: 6 },
  fog: { kind: 'fog', label: 'Nebel', cloud: 1, precip: 0, snow: false, visibility: 150, windSpeed: 3, windDir: 90, temperature: 5 },
  drizzle: { kind: 'drizzle', label: 'Nieselregen', cloud: 1, precip: 0.4, snow: false, visibility: 8000, windSpeed: 10, windDir: 250, temperature: 9 },
  rain: { kind: 'rain', label: 'Regen', cloud: 1, precip: 2.5, snow: false, visibility: 6000, windSpeed: 18, windDir: 250, temperature: 8 },
  heavyrain: { kind: 'rain', label: 'starker Regen', cloud: 1, precip: 8, snow: false, visibility: 2500, windSpeed: 30, windDir: 250, temperature: 8 },
  snow: { kind: 'snow', label: 'Schneefall', cloud: 1, precip: 1.5, snow: true, visibility: 3000, windSpeed: 10, windDir: 30, temperature: -2 },
};

/** Names accepted by {@link weatherPreset} (debug override). */
export const WEATHER_PRESETS: readonly string[] = Object.keys(PRESETS);

/** Hand-made weather for testing; null for unknown names. */
export function weatherPreset(name: string | null | undefined, now = 0): Weather | null {
  if (!name || !Object.hasOwn(PRESETS, name)) return null;
  return { ...PRESETS[name]!, known: true, updatedAt: now };
}
