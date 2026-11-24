import { schema, t, type SchemaType } from '@colyseus/schema';
import { UNKNOWN_WEATHER } from '@nn/shared';

/**
 * Slow, reliable room state (Colyseus schema). Fast-changing poses travel in the binary snapshot (@nn/shared/net)
 * instead; this holds who is here and what changes rarely. No StateView: at most a few hundred small entries.
 */

/**
 * A player, keyed by slot. mode: 0 walk, 1 drive, 2 down, 3 ride, 4 riding along in a car (as OwnMode). carId: the car
 * driven or ridden along in, −1 otherwise; seat: the seat in it (0 driving), −1 otherwise.
 * bikeId: the ridden bike, −1 otherwise. variant: the character model (index into CHARACTER_VARIANTS).
 * mapX/mapZ: coarse position (whole metres, only rewritten after MAP_POS_STEP m) for the maps, which show every player,
 * also those outside a client's snapshot interest.
 */
export const PlayerState = schema({
  slot: t.uint8(),
  name: t.string(),
  mode: t.uint8(),
  carId: t.int16().default(-1),
  seat: t.int8().default(-1),
  bikeId: t.int16().default(-1),
  variant: t.uint8(),
  mapX: t.int16(),
  mapZ: t.int16(),
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

/**
 * A bike away from its manifest spot or with a rider, keyed by bike index. rider: slot, −1 without one. The pose (ground
 * under it, heading, fall as BikePose.fall) is updated whenever the bike rests (while it moves or is ridden, snapshots
 * carry it).
 */
export const BikeSlowState = schema({
  rider: t.int16().default(-1),
  x: t.float32(), y: t.float32(), z: t.float32(), heading: t.float32(),
  fall: t.int8().default(0),
}, 'BikeSlowState');
export type BikeSlowState = SchemaType<typeof BikeSlowState>;

/** The one weather for all of Cologne (fields as @nn/shared Weather). kind: WeatherKind. */
export const WeatherState = schema({
  known: t.boolean(),
  kind: t.string(),
  cloud: t.float32(),
  precip: t.float32(),
  snow: t.boolean(),
  visibility: t.float32(),
  windSpeed: t.float32(),
  windDir: t.float32(),
  temperature: t.float32(),
  label: t.string(),
  updatedAt: t.float64(),
}, 'WeatherState');
export type WeatherState = SchemaType<typeof WeatherState>;

/** A fresh WeatherState holding the UNKNOWN_WEATHER values (the shared object is never handed out). */
function unknownWeatherState(): WeatherState {
  const w = new WeatherState();
  Object.assign(w, UNKNOWN_WEATHER);
  return w;
}

/** restartTick: the sim tick at which the server restarts (announced on SIGTERM/SIGINT), 0 while none is announced. */
export const NippesState = schema({
  players: t.map(PlayerState),
  cars: t.map(CarState),
  bikes: t.map(BikeSlowState),
  lamps: t.map(LampState),
  weather: t.ref(WeatherState).default(unknownWeatherState),
  restartTick: t.float64().default(0),
}, 'NippesState');
export type NippesState = SchemaType<typeof NippesState>;
