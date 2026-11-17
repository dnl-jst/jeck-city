import { Client, type Room } from '@colyseus/sdk';
import {
  decodeSnapshot, encodeInputs, NAME_ERRORS, PROTOCOL_VERSION, RECONNECT_S, RETRY_CONNECT_S,
  type InputPacket, type Snapshot, type StationId, type Weather,
} from '@nn/shared';
import { ServerClock } from './clock';

export const CONNECT_TEXTS = {
  unreachable: 'Jeck City ist gerade nicht erreichbar – versuch es später nochmal.',
  full: 'Jeck City ist gerade voll – versuch es gleich nochmal.',
  version: 'Neue Version – bitte Seite neu laden.',
  rate: 'Zu viele Versuche – warte kurz.',
} as const;

export const STATUS_TEXTS = { connecting: 'Verbinde …', reconnecting: 'Verbindung unterbrochen …' } as const;

/** What the server answers in `welcome` (again after every reconnect). */
export type Welcome = { slot: number; name: string; devMode: boolean; tick: number };

/** online → (connection drops) reconnecting → online again, or lost for good (window over, kicked, closed). */
export type NetStatus = 'online' | 'reconnecting' | 'lost';

type StateMap<T> = { get(key: string): T | undefined; forEach(cb: (v: T, key: string) => void): void };
type StatePose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };

/**
 * Read-only mirror of the slow Colyseus state (names, modes, character variants, car and bike occupancy and resting
 * poses, lying lamps); entries are keyed by slot / car index / bike index / lamp index. Car driver, bike rider −1: none.
 */
export type NetState = {
  players: StateMap<{ slot: number; name: string; mode: number; carId: number; bikeId: number; variant: number }>;
  cars: StateMap<{ driver: number; engine: number; lights: boolean; radio: string } & StatePose>;
  bikes: StateMap<{ rider: number; x: number; y: number; z: number; heading: number }>;
  lamps: StateMap<StatePose>;
  weather: Weather;
};

/** Why a join did not work, from the error the SDK throws. */
export type JoinFailure =
  | { kind: 'name'; code: 'length' | 'chars' | 'bad' }
  | { kind: 'version' }
  | { kind: 'full' }
  | { kind: 'rate' }
  | { kind: 'unreachable' };

/**
 * Server answers arrive as `{ code, message }` (ServerError / MatchMakeError): 409 version, 400 + length|chars|bad,
 * 429 rate, 521 room full (raised by Colyseus before onAuth). Everything else - a rejected fetch, a dead proxy
 * (502/504), a socket that fails to open - means the server cannot be reached.
 */
export function classifyJoinError(e: unknown): JoinFailure {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  if (code === 409) return { kind: 'version' };
  if (code === 400 && (message === 'length' || message === 'chars' || message === 'bad')) return { kind: 'name', code: message };
  if (code === 429) return { kind: 'rate' };
  if (code === 521) return { kind: 'full' };
  return { kind: 'unreachable' };
}

/** connectRoom gave up: the player must change the name ('name') or reload the page ('version'). */
export class JoinRejected extends Error {
  constructor(readonly failure: Extract<JoinFailure, { kind: 'name' | 'version' }>) {
    super(failure.kind);
    this.name = 'JoinRejected';
  }
}

/** Where connectRoom reports progress; the Lobby implements it. */
export interface ConnectUi {
  showStatus(text: string): void;
  showError(text: string, retryInS?: number): void;
}

const WELCOME_TIMEOUT_MS = 5000;
const PING_EVERY_MS = 2000;
const MAX_PENDING_SNAPSHOTS = 8;

/**
 * One joined room.
 *
 * Input sequence numbers: the server's queue drops every packet with seq <= the last one it saw, and a reconnect keeps
 * that queue. The caller must therefore number inputs with one counter that keeps increasing for the whole page
 * session; Connection never touches seq, and a reconnect must not restart it.
 *
 * Reconnecting: when the socket breaks the SDK re-opens it on this same room object (the equivalent of
 * `client.reconnect(token)` with the room's token, so slot, car and the handlers below survive). `status` shows
 * 'reconnecting' meanwhile; after RECONNECT_S without success the room is left and the status becomes 'lost'.
 * Inputs are not sent while the socket is closed (nothing is queued up for later).
 */
export class Connection {
  readonly clock = new ServerClock();
  /** The latest welcome (replaced after a reconnect). */
  welcome!: Welcome;
  /** Round trip in ms, measured every 2 s; 0 until the first answer. */
  rttMs = 0;
  status: NetStatus = 'online';

  private readonly snapshotListeners = new Set<(s: Snapshot) => void>();
  private pending: Snapshot[] = [];
  private readonly statusListeners = new Set<(s: NetStatus) => void>();
  private readonly welcomeListeners = new Set<(w: Welcome) => void>();
  private resolveWelcome!: (w: Welcome) => void;
  private readonly firstWelcome = new Promise<Welcome>((r) => { this.resolveWelcome = r; });
  private deadline = 0;
  private readonly pinger: number;

  /** Must be called in the same turn that join() resolved, so no message is missed (see connectRoom). */
  constructor(private readonly room: Room, private readonly now: () => number = () => performance.now()) {
    room.onMessage('welcome', (w: Welcome) => {
      this.welcome = w;
      this.clock.onSnapshot(w.tick, this.now());
      this.resolveWelcome(w);
      for (const cb of this.welcomeListeners) cb(w);
    });
    room.onMessage('s', (bytes: Uint8Array) => {
      const snap = decodeSnapshot(bytes);
      if (!snap) return;
      this.clock.onSnapshot(snap.serverTick, this.now());
      if (!this.snapshotListeners.size) {
        this.pending.push(snap);
        if (this.pending.length > MAX_PENDING_SNAPSHOTS) this.pending.shift();
        return;
      }
      for (const cb of this.snapshotListeners) cb(snap);
    });
    room.reconnection.minUptime = 0;
    room.reconnection.maxRetries = Math.ceil(RECONNECT_S / 0.5) + 2;
    room.reconnection.backoff = () => 500;
    room.onDrop(() => {
      this.setStatus('reconnecting');
      this.deadline = window.setTimeout(() => { void this.room.leave(); }, RECONNECT_S * 1000);
    });
    room.onReconnect(() => {
      clearTimeout(this.deadline);
      this.setStatus('online');
    });
    room.onLeave(() => {
      clearTimeout(this.deadline);
      clearInterval(this.pinger);
      this.setStatus('lost');
    });
    room.onError((code, message) => console.warn('room error', code, message));
    this.pinger = window.setInterval(() => room.ping((ms) => { this.rttMs = ms; }), PING_EVERY_MS);
  }

  /** The slow state mirror (Colyseus schema, decoded by the SDK). */
  get state(): NetState {
    return this.room.state as unknown as NetState;
  }

  /** Resolves once the first welcome has arrived. */
  whenWelcomed(timeoutMs = WELCOME_TIMEOUT_MS): Promise<Welcome> {
    return Promise.race([
      this.firstWelcome,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no welcome')), timeoutMs)),
    ]);
  }

  /** Dropped silently while the socket is down. */
  sendInputs(p: InputPacket): void {
    if (this.status !== 'online' || !this.room.connection.isOpen) return;
    this.room.sendBytes('i', encodeInputs(p));
  }

  /** The station to play in the own car; null switches the radio off. */
  sendRadio(s: StationId | null): void {
    if (this.status !== 'online' || !this.room.connection.isOpen) return;
    this.room.send('radio', s);
  }

  /** The character variant (index into CHARACTER_VARIANTS) the others see. */
  sendVariant(v: number): void {
    if (this.status === 'online' && this.room.connection.isOpen) this.room.send('variant', v);
  }

  /** Dev only (the server ignores it in production). */
  sendTeleport(x: number, z: number): void {
    if (this.status === 'online' && this.room.connection.isOpen) this.room.send('devTeleport', { x, z });
  }

  /** Snapshots that came in before the first listener are delivered to it at once (at most 8, oldest dropped). */
  onSnapshot(cb: (s: Snapshot) => void): () => void {
    this.snapshotListeners.add(cb);
    const early = this.pending;
    this.pending = [];
    for (const s of early) cb(s);
    return () => { this.snapshotListeners.delete(cb); };
  }

  /** Fires for every welcome after the first as well, i.e. after each reconnect. */
  onWelcome(cb: (w: Welcome) => void): () => void {
    this.welcomeListeners.add(cb);
    return () => { this.welcomeListeners.delete(cb); };
  }

  onStatus(cb: (s: NetStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => { this.statusListeners.delete(cb); };
  }

  /** Leaves for good (no reconnect window). */
  close(): void {
    clearTimeout(this.deadline);
    clearInterval(this.pinger);
    void this.room.leave();
  }

  private setStatus(s: NetStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Joins the one room 'nippes' (never joinOrCreate: the server creates it at startup) as `name` showing character
 * `variant` (index into CHARACTER_VARIANTS). Retries by itself every
 * RETRY_CONNECT_S seconds (with a countdown in `ui`) while the server is unreachable, the room is full or the join rate
 * limit is hit. Throws JoinRejected for a bad name (the error text is shown, the caller asks for a new name) and for a
 * version conflict (the text is shown, nothing more to try).
 *
 * The first `welcome` is sent while the join is still being acknowledged and is only delivered after join() resolved;
 * the handlers are registered in the very same turn (no await in between), so nothing can be missed.
 */
export async function connectRoom(name: string, worldHash: string, ui: ConnectUi, variant = 0, url?: string): Promise<Connection> {
  for (;;) {
    ui.showStatus(STATUS_TEXTS.connecting);
    let conn: Connection | null = null;
    try {
      const room = await new Client(url).join('nippes', { name, protocolVersion: PROTOCOL_VERSION, worldHash, variant });
      conn = new Connection(room);
      await conn.whenWelcomed();
      return conn;
    } catch (e) {
      conn?.close();
      const f = classifyJoinError(e);
      if (f.kind === 'name') {
        ui.showError(NAME_ERRORS[f.code]);
        throw new JoinRejected(f);
      }
      if (f.kind === 'version') {
        ui.showError(CONNECT_TEXTS.version);
        throw new JoinRejected(f);
      }
      ui.showError(CONNECT_TEXTS[f.kind], RETRY_CONNECT_S);
      await sleep(RETRY_CONNECT_S * 1000);
    }
  }
}
