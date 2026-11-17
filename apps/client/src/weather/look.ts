import type { Weather } from '@nn/shared';

/** What the renderer needs of the weather, already reduced to numbers it can blend. */
export type WeatherLook = {
  /** 0..1 cloud cover (fog and precipitation imply at least 0.85). */
  overcast: number;
  /** Metres (50000 when clear). */
  visibility: number;
  /** 0..1 rain intensity, 0 when snowing. */
  rain: number;
  /** 0..1 snow intensity, 0 when raining. */
  snow: number;
  /** Drift velocity in m/s: x east, z south, towards where the wind blows. */
  windX: number;
  windZ: number;
};

export const CLEAR_LOOK: WeatherLook = Object.freeze({ overcast: 0, visibility: 50_000, rain: 0, snow: 0, windX: 0, windZ: 0 });

/** Seconds a change of weather takes to fade. */
export const BLEND_S = 8;

export function weatherLook(w: Weather): WeatherLook {
  const intensity = Math.min(1, Math.sqrt(Math.max(0, w.precip) / 8));
  const wet = w.precip > 0;
  let overcast = w.cloud;
  if (w.kind === 'fog' || wet) overcast = Math.max(overcast, 0.85);
  // meteorological "from" degrees: from north (0) blows towards +z (south), from west (270) towards +x (east)
  const rad = (w.windDir * Math.PI) / 180;
  const speed = w.windSpeed / 3.6;
  return {
    overcast: Math.min(1, Math.max(0, overcast)),
    visibility: w.visibility,
    rain: w.snow ? 0 : intensity,
    snow: w.snow ? intensity : 0,
    windX: -Math.sin(rad) * speed + 0,
    windZ: Math.cos(rad) * speed + 0,
  };
}

const KEYS = Object.keys(CLEAR_LOOK) as (keyof WeatherLook)[];

/** Fades from the current look to the look of the latest weather over BLEND_S. The first set is instant. */
export class WeatherBlend {
  private cur: WeatherLook = { ...CLEAR_LOOK };
  private from: WeatherLook = { ...CLEAR_LOOK };
  private to: WeatherLook = { ...CLEAR_LOOK };
  private t = 1;
  private first = true;
  // primitives, not the object: the room state mutates its weather in place
  private offered: { known: boolean; kind: string; updatedAt: number } | null = null;

  /** Calls set() only if known, kind or updatedAt differ from the last offered values (the first offer always sets). */
  offer(w: Weather): void {
    const o = this.offered;
    if (o && o.known === w.known && o.kind === w.kind && o.updatedAt === w.updatedAt) return;
    this.offered = { known: w.known, kind: w.kind, updatedAt: w.updatedAt };
    this.set(w);
  }

  set(w: Weather): void {
    const target = weatherLook(w);
    if (this.first) {
      this.first = false;
      this.cur = { ...target };
      this.to = target;
      this.t = 1;
      return;
    }
    this.from = { ...this.cur };
    this.to = target;
    this.t = 0;
  }

  update(dt: number): WeatherLook {
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / BLEND_S);
      const out = { ...this.cur };
      for (const k of KEYS) out[k] = this.t >= 1 ? this.to[k] : this.from[k] + (this.to[k] - this.from[k]) * this.t;
      this.cur = out;
    }
    return { ...this.cur };
  }
}
