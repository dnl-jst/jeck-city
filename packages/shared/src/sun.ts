import { getPosition } from 'suncalc';

/** Köln-Nippes (Wilhelmplatz). */
export const SUN_LAT = 50.9631;
export const SUN_LNG = 6.9522;

export type SunState = {
  /** Apparent sun altitude above the horizon, radians. */
  altitude: number;
  /** Heading of the direction towards the sun, radians: direction = (sin az, cos az) in world x/z (x east, z south). */
  azimuth: number;
  /** 0 day … 1 night, linear between sun altitude +6° and −6°. */
  nightFactor: number;
};

const DEG = Math.PI / 180;
const MIN = 60_000;

/** Parses `HH:MM` (00:00–23:59); null when malformed. */
export function parseTimeOverride(s: string | undefined | null): { h: number; m: number } | null {
  const r = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!r) return null;
  const h = Number(r[1]), m = Number(r[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

const berlinFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Offset of Europe/Berlin wall time from UTC at instant `ms`, in milliseconds (+1 h or +2 h). */
function berlinOffset(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of berlinFmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return Math.round((wall - Math.floor(ms / MIN) * MIN) / MIN) * MIN;
}

/**
 * The instant at which Europe/Berlin shows the browser's local date and wall-clock time of `now`
 * (or `override` HH:MM on that date). Reads only the local getters, so a visitor at 21:00 in any time
 * zone sees Köln at 21:00. Non-existent wall times (spring-forward gap) resolve to an instant nearby.
 */
export function cologneInstantFromLocal(now: Date, override?: string): Date {
  const t = parseTimeOverride(override) ?? { h: now.getHours(), m: now.getMinutes() };
  const wall = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m, override ? 0 : now.getSeconds());
  // offset at the guessed instant, then once more at the corrected one (handles DST transitions)
  let ms = wall - berlinOffset(wall);
  ms = wall - berlinOffset(ms);
  return new Date(ms);
}

/** Sun over Köln-Nippes for the browser's local wall-clock time `now` (optionally overridden by `HH:MM`). */
export function sunState(now: Date, override?: string): SunState {
  const p = getPosition(cologneInstantFromLocal(now, override), SUN_LAT, SUN_LNG);
  const altitude = p.altitude * DEG;
  const nightFactor = Math.min(1, Math.max(0, (6 - p.altitude) / 12));
  // suncalc: azimuth clockwise from north; north is −z, east +x → direction (sin A, −cos A) = (sin(π−A), cos(π−A))
  return { altitude, azimuth: Math.PI - p.azimuth * DEG, nightFactor };
}
