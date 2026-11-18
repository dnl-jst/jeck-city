export const PROTOCOL_VERSION = 3;
export const TICK_HZ = 60;
export const SNAPSHOT_EVERY = 3;
export const MAX_INPUTS_PER_PACKET = 3;
/** Default player cap per server: leaves tick time for the NPCs on 2 vCPU (user decision 2026-11-17; the live server runs 40); MAX_PLAYERS (env) can raise it up to 100 on a faster core. */
export const MAX_PLAYERS = 40;
export const INTEREST_RADIUS = 250;
export const INTEREST_RELEASE = 270;
export const RECONNECT_S = 15;
export const JOIN_PER_IP_PER_MIN = 5;
export const MAX_INPUTS_PER_S = 90;
export const MAX_MESSAGE_BYTES = 512;
export const KNOCKDOWN_KMH = 8;
export const KNOCKDOWN_S = 1.0;
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

// NPCs (docs/superpowers/specs/2026-11-17-npcs-design.md)
/** NPCs are sent to clients within the same radius as players (and dropped beyond INTEREST_RELEASE). */
export const NPC_INTEREST_RADIUS = INTEREST_RADIUS;
/** New NPCs appear this far (m) from the nearest player... */
export const NPC_SPAWN_MIN = 180;
export const NPC_SPAWN_MAX = 250;
/** ...or, in an area no player has been in before, no closer than this. */
export const NPC_SPAWN_FIRST_MIN = 40;
/** NPCs farther than this (m) from every player are dissolved. */
export const NPC_DESPAWN = 300;
/** Most NPCs on the server at once. */
export const NPC_MAX = 400;
/** NPCs this close (m) to a player get kinematic bodies in the physics world. */
export const NPC_BODY_RADIUS = 60;
/** People (walkers, cyclists, sitters) get bodies only this close (m) to a player; cars within NPC_BODY_RADIUS. */
export const NPC_PERSON_BODY_RADIUS = 25;
/** NPCs this close (m) to a player check every tick whether the player is in their way. */
export const NPC_REACT_RADIUS = 30;
/** An NPC says something at most once per this many seconds. */
export const NPC_SAY_COOLDOWN_S = 8;
/** A blocked NPC speaks up after standing this long (s). */
export const NPC_SAY_AFTER_S = 0.7;
/** A blocked NPC gives up and takes another way after this long (s). */
export const NPC_GIVE_UP_S = 20;
/** The next plan is sent at least this long (s) before the current one ends. */
export const NPC_PLAN_LEAD_S = 1;
/** A new NPC fades in over this long (s) on the client. */
export const NPC_FADE_IN_S = 1;
/** A replaced plan is blended into over this long (s) on the client. */
export const NPC_BLEND_S = 0.15;
