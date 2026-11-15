import { schema, t, type SchemaType } from '@colyseus/schema';

/**
 * Slow, reliable room state (Colyseus schema). Fast-changing poses travel in the binary snapshot (@nn/shared/net)
 * instead; this holds who is here and what changes rarely. No StateView: at most a few hundred small entries.
 */

/** A player, keyed by slot. mode: 0 walk, 1 drive, 2 down (as OwnMode). carId: the driven car, −1 on foot. */
export const PlayerState = schema({
  slot: t.uint8(),
  name: t.string(),
  mode: t.uint8(),
  carId: t.int16().default(-1),
}, 'PlayerState');
export type PlayerState = SchemaType<typeof PlayerState>;

/**
 * A car away from its manifest spot or with a driver, keyed by car index. driver: slot, −1 without one.
 * engine: 0 off, 1 starting, 2 running (as EngineState). radio: station id, '' while off.
 * The pose is updated whenever the car rests (while it moves, snapshots carry it).
 */
export const CarState = schema({
  driver: t.int16().default(-1),
  engine: t.uint8(),
  lights: t.boolean(),
  radio: t.string(),
  x: t.float32(), y: t.float32(), z: t.float32(),
  qx: t.float32(), qy: t.float32(), qz: t.float32(), qw: t.float32(),
}, 'CarState');
export type CarState = SchemaType<typeof CarState>;

/** A knocked-over lamp lying still, keyed by lamp index (origin at the foot of the post). */
export const LampState = schema({
  x: t.float32(), y: t.float32(), z: t.float32(),
  qx: t.float32(), qy: t.float32(), qz: t.float32(), qw: t.float32(),
}, 'LampState');
export type LampState = SchemaType<typeof LampState>;

export const NippesState = schema({
  players: t.map(PlayerState),
  cars: t.map(CarState),
  lamps: t.map(LampState),
}, 'NippesState');
export type NippesState = SchemaType<typeof NippesState>;
