import { STATION_IDS, type StationId } from '@nn/shared';

export { STATION_IDS, type StationId };

export const STATIONS: readonly { id: StationId; name: string; url: string }[] = [
  { id: 'koellefornia', name: 'Radio Köllefornia', url: 'https://stream.radio-koellefornia.de/listen/radio_koellefornia/radio.mp3' },
  { id: 'radiokoeln', name: 'Radio Köln', url: 'https://stream.lokalradio.nrw/444z7j4' },
  { id: 'einslive', name: '1LIVE', url: 'https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3' },
];

export const stationLabel = (s: StationId | null): string =>
  s === null ? 'Radio aus' : (STATIONS.find((st) => st.id === s)?.name ?? 'Radio aus');

/** Remembers the chosen station (or off); changes only while seated at a radio (car, or the sound Long John). */
export class RadioTuner {
  current: StationId | null = 'koellefornia';
  inCar = false;

  enterCar(): StationId | null {
    this.inCar = true;
    return this.current;
  }

  exitCar(): void {
    this.inCar = false;
  }

  next(): StationId | null {
    return this.step(1);
  }

  prev(): StationId | null {
    return this.step(-1);
  }

  /** Jumps straight to a station (or off); only in a car. */
  select(id: StationId | null): StationId | null {
    if (this.inCar) this.current = id;
    return this.current;
  }

  /** Cycle order: every station, then off (index STATIONS.length), then wrap. */
  private step(dir: 1 | -1): StationId | null {
    if (!this.inCar) return this.current;
    const n = STATIONS.length + 1;
    const i = this.current === null ? STATIONS.length : STATIONS.findIndex((s) => s.id === this.current);
    const j = (i + dir + n) % n;
    this.current = STATIONS[j]?.id ?? null;
    return this.current;
  }
}
