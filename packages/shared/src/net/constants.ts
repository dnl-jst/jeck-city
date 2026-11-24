export const PROTOCOL_VERSION = 6;
export const TICK_HZ = 60;
export const SNAPSHOT_EVERY = 3;
export const MAX_INPUTS_PER_PACKET = 3;
/** Default player cap per server: what 2 vCPU carry (load test 2026-11-16); MAX_PLAYERS (env) can raise it up to 100 on a faster core. */
export const MAX_PLAYERS = 60;
export const INTEREST_RADIUS = 250;
export const INTEREST_RELEASE = 270;
export const RECONNECT_S = 15;
export const JOIN_PER_IP_PER_MIN = 5;
export const MAX_INPUTS_PER_S = 90;
export const MAX_MESSAGE_BYTES = 512;
export const KNOCKDOWN_KMH = 8;
export const KNOCKDOWN_S = 3.6;
export const ENTER_MAX_DIST = 3;
export const RESET_AFTER_S = 600;
export const RESET_CLEAR_RADIUS = 100;
export const SPAWN_STEP = 1.5;
export const SPAWN_MAX_DIST = 60;
export const INTERP_DELAY_S = 0.1;
export const EXTRAPOLATE_MAX_S = 0.15;
export const HARD_SNAP_M = 2;
export const MAX_REPLAY_STEPS = 60;
export const CORRECTION_BLEND_S = 0.1;
export const REMOTE_ENGINE_VOICES = 6;
export const REMOTE_RADIO_RADIUS = 25;
export const REMOTE_RADIO_LOWPASS_HZ = 800;
export const REMOTE_RADIO_GAIN_DB = -18;
export const RETRY_CONNECT_S = 10;

export const STATION_IDS = ['koellefornia', 'radiokoeln', 'einslive'] as const;
export type StationId = (typeof STATION_IDS)[number];

/** Validates an untrusted radio message payload: a known station id, or null (radio off / unknown). */
export const parseStationId = (v: unknown): StationId | null =>
  typeof v === 'string' && (STATION_IDS as readonly string[]).includes(v) ? (v as StationId) : null;
