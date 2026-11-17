/** What an NPC is: a passer-by, a cyclist, a car driver or someone sitting in a park. */
export type NpcKind = 'walker' | 'cyclist' | 'driver' | 'sitter';
export const NPC_KINDS: readonly NpcKind[] = ['walker', 'cyclist', 'driver', 'sitter'];

/**
 * What the NPC does along its plan: move along the path, wait or sit at its first point (facing along the first
 * segment), lie after a hit (the path is the short throw, then it lies at the end) or get up (stands at the first point).
 */
export type NpcAction = 'move' | 'wait' | 'sit' | 'down' | 'getup';
export const NPC_ACTIONS: readonly NpcAction[] = ['move', 'wait', 'sit', 'down', 'getup'];

/**
 * How an NPC looks, fixed for its life. variant: index into CHARACTER_VARIANTS; tint: clothing colour (0xRRGGBB);
 * scale: figure size factor (0.95–1.05); vehicleType: index into CAR_TYPES (driver) or BIKE_TYPES (cyclist), -1 none;
 * vehicleColor: paint colour.
 */
export type NpcLook = { variant: number; tint: number; scale: number; vehicleType: number; vehicleColor: number };

export type PathPt = { x: number; y: number; z: number };

/** Speed ramp: from path distance s0 to s1 (m) the speed goes linearly (in distance-time terms: constant acceleration) from v0 to v1 (m/s). */
export type SpeedRamp = { s0: number; s1: number; v0: number; v1: number };

/**
 * Where an NPC is from startTick on, as a pure function of the tick (planAt). seq counts the plan replacements of
 * this NPC (a client drops a plan older than the one it has).
 */
export type Plan = {
  id: number; kind: NpcKind; look: NpcLook; startTick: number; path: PathPt[]; ramps: SpeedRamp[]; action: NpcAction; seq: number;
};

/** A plan evaluated at a tick. heading: forward = (sin h, cos h); s: distance travelled along the path; done: past its end. */
export type NpcPose = { x: number; y: number; z: number; heading: number; pitch: number; speed: number; s: number; done: boolean };
