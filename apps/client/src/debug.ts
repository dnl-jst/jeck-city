/** Debug overlay (`?debug=1`): position, view direction, shareable view link (key P). */
import { isTypingTarget } from './input';

export type DebugView = {
  x: number; y: number; z: number; yawDeg: number; pitchDeg: number;
  /** HH:MM game time */
  time: string;
  /** YYYY-MM-DD */
  date: string;
};

const r1 = (n: number): number => Number(n.toFixed(1)) + 0;

/** `baseUrl` with `cam/time/date/debug` set to the view (other query params kept). Yaw convention = `?cam`. */
export function buildViewLink(baseUrl: string, v: DebugView): string {
  const u = new URL(baseUrl);
  const yaw = ((Math.round(v.yawDeg) % 360) + 360) % 360;
  u.searchParams.delete('cam');
  u.searchParams.delete('time');
  u.searchParams.delete('date');
  u.searchParams.delete('debug');
  u.searchParams.set('cam', [r1(v.x), r1(v.y), r1(v.z), yaw, Math.round(v.pitchDeg) + 0].join(','));
  u.searchParams.set('time', v.time);
  u.searchParams.set('date', v.date);
  u.searchParams.set('debug', '1');
  return u.toString();
}

/** Online only: round trip, age of the newest snapshot, own-pose prediction error, players in the room. */
export type NetDebug = { rttMs: number; snapshotAgeMs: number; predErrorM: number; players: number };

export function formatDebugLines(
  v: DebugView, lat: number, lon: number, fps: number, drawCalls: number, chunks: number, net: NetDebug | null = null,
): string[] {
  const yaw = ((Math.round(v.yawDeg) % 360) + 360) % 360;
  return [
    `Pos ${r1(v.x)} / ${r1(v.y)} / ${r1(v.z)}`,
    `Lat/Lon ${lat.toFixed(6)} / ${lon.toFixed(6)}`,
    `Blick ${yaw}° / ${Math.round(v.pitchDeg) + 0}°`,
    `Zeit ${v.time} (${v.date})`,
    `${Math.round(fps)} fps · ${drawCalls} Draw Calls · ${chunks} Chunks`,
    ...(net ? [
      `RTT ${Number.isFinite(net.rttMs) ? Math.round(net.rttMs) : '–'} ms`,
      `Snapshot-Alter ${Number.isFinite(net.snapshotAgeMs) ? Math.round(net.snapshotAgeMs) : '–'} ms`,
      `Vorhersagefehler ${net.predErrorM.toFixed(2)} m`,
      `Spieler ${net.players}`,
    ] : []),
  ];
}

/** DOM overlay, top left. `getView` etc. are polled 4x/s; key P copies the view link. */
export class DebugOverlay {
  private readonly box: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly note: HTMLDivElement;
  private readonly field: HTMLInputElement;
  private noteTimer = 0;

  constructor(root: HTMLElement, private readonly getView: () => DebugView, private readonly getStats: () => { lat: number; lon: number; fps: number; drawCalls: number; chunks: number; net?: NetDebug | null }) {
    const style = document.createElement('style');
    style.textContent = `
      .nn-debug { position: fixed; left: 8px; top: 8px; z-index: 5; padding: 6px 8px; border-radius: 4px;
        background: rgba(10,12,20,0.6); color: #e8ecf8; font: 12px/1.4 ui-monospace, Menlo, monospace; pointer-events: none; }
      .nn-debug pre { margin: 0; font: inherit; }
      .nn-debug-note { color: #f2c46b; }
      .nn-debug input { pointer-events: auto; width: 320px; margin-top: 4px; font: inherit; }`;
    document.head.append(style);
    this.box = document.createElement('div');
    this.box.className = 'nn-debug';
    this.text = document.createElement('pre');
    this.note = document.createElement('div');
    this.note.className = 'nn-debug-note';
    this.field = document.createElement('input');
    this.field.readOnly = true;
    this.field.hidden = true;
    this.box.append(this.text, this.note, this.field);
    root.append(this.box);
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyP' && !e.repeat && !isTypingTarget(e.target)) void this.copyLink(); });
    setInterval(() => this.refresh(), 250);
    this.refresh();
  }

  private refresh(): void {
    const s = this.getStats();
    this.text.textContent = formatDebugLines(this.getView(), s.lat, s.lon, s.fps, s.drawCalls, s.chunks, s.net ?? null).join('\n');
  }

  private flash(msg: string): void {
    this.note.textContent = msg;
    clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => { this.note.textContent = ''; }, 1500);
  }

  private async copyLink(): Promise<void> {
    const link = buildViewLink(location.href, this.getView());
    try {
      await navigator.clipboard.writeText(link);
      this.field.hidden = true;
      this.flash('Link kopiert');
    } catch {
      // no secure context (e.g. http via LAN IP): show the link selected so it can be copied by hand
      this.field.hidden = false;
      this.field.value = link;
      this.field.focus();
      this.field.select();
      this.flash('Kopieren nicht möglich – Link markiert (Strg/Cmd+C)');
    }
  }
}
