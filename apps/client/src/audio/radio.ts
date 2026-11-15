import { STATIONS, type StationId } from './stations';

export type StreamElement = Pick<
  HTMLAudioElement,
  'src' | 'muted' | 'volume' | 'play' | 'pause' | 'load' | 'removeAttribute' | 'addEventListener'
>;

export const RADIO_VOLUME = 0.8;

interface RadioEvents {
  onConnecting(): void;
  onPlaying(): void;
  onUnreachable(): void;
}

/**
 * Live radio streams via a plain HTMLAudioElement only (the streams send no CORS
 * headers, so never route through Web Audio and never set crossOrigin).
 */
export class Radio {
  playing: StationId | null = null;
  private station: StationId | null = null;
  private el: StreamElement | null = null;
  private gen = 0;
  private retried = false;
  private awaitingUnlock = false;
  private muted = false;
  private suspended: StationId | null = null;

  constructor(
    private readonly make: () => StreamElement,
    private readonly events: RadioEvents,
  ) {}

  tune(id: StationId | null): void {
    this.suspended = null;
    this.retried = false;
    this.stop();
    this.station = id;
    if (id !== null) this.start(true);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.el) this.el.muted = m;
  }

  unlocked(): void {
    if (this.station === null || !this.awaitingUnlock || !this.el) return;
    this.awaitingUnlock = false;
    this.play(this.el, this.gen);
  }

  suspend(): void {
    if (this.station === null) return;
    this.suspended = this.station;
    this.stop();
    this.station = null;
  }

  resume(): void {
    const s = this.suspended;
    this.suspended = null;
    if (s !== null) this.tune(s);
  }

  private stop(): void {
    this.gen++;
    this.playing = null;
    this.awaitingUnlock = false;
    const el = this.el;
    this.el = null;
    this.station = null;
    if (el) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  private start(announce: boolean): void {
    const station = STATIONS.find((s) => s.id === this.station);
    if (!station) return;
    const gen = ++this.gen;
    const el = this.make();
    this.el = el;
    el.src = station.url;
    el.volume = RADIO_VOLUME;
    el.muted = this.muted;
    let hasPlayed = false;
    el.addEventListener('playing', () => {
      if (gen !== this.gen) return;
      hasPlayed = true;
      this.retried = false;
      this.playing = station.id;
      this.events.onPlaying();
    });
    const failed = () => {
      if (gen !== this.gen) return;
      this.onFailure(station.id);
    };
    el.addEventListener('error', failed);
    el.addEventListener('ended', failed);
    // Browsers fire 'stalled' on live streams during normal hiccups: only a failure while connecting.
    el.addEventListener('stalled', () => {
      if (!hasPlayed) failed();
    });
    if (announce) this.events.onConnecting();
    this.play(el, gen);
  }

  private play(el: StreamElement, gen: number): void {
    el.play().catch(() => {
      if (gen === this.gen) this.awaitingUnlock = true;
    });
  }

  private onFailure(id: StationId): void {
    const old = this.el;
    this.gen++;
    this.playing = null;
    this.el = null;
    if (old) {
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
    if (!this.retried) {
      this.retried = true;
      this.station = id;
      this.start(false);
      return;
    }
    this.station = null;
    this.events.onUnreachable();
  }
}
