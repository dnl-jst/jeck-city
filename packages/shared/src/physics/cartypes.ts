/** Car types; the index is the `type` number of a parked car in the manifest. Models: data/models/cars/<type>. */
export const CAR_TYPES = ['kleinwagen', 'mittelklasse', 'transporter', 'smart', 'heli'] as const;
export type CarType = (typeof CAR_TYPES)[number];

export type CarSpec = {
  /** Body length, width (without mirrors) and height (m). */
  length: number;
  width: number;
  height: number;
  /** Body centre ahead of the axle midpoint (m): (front overhang − rear overhang) / 2. */
  bodyZ: number;
  /** Axle distance and track width (m); wheel radius (m). */
  wheelbase: number;
  track: number;
  wheelRadius: number;
  mass: number;
  /** Centre of mass above the ground (m). */
  comY: number;
  /**
   * A helicopter: it stands on its skids (the four ray-cast "wheels", always braked) and flies once its pilot lifts it
   * off (TUNING.heli, Vehicle.applyInput). tail: a second collider box for the tail boom (centre `z` behind the axle
   * midpoint and `y` above the ground, half sizes).
   */
  fly?: { tail: { z: number; y: number; halfX: number; halfY: number; halfZ: number } };
};

/** Measured off the Blender models (data/models/cars/<type>/build.py). */
export const CAR_SPECS: Record<CarType, CarSpec> = {
  kleinwagen: { length: 4.05, width: 1.75, height: 1.47, bodyZ: 0.05, wheelbase: 2.55, track: 1.5, wheelRadius: 0.305, mass: 1150, comY: 0.36 },
  mittelklasse: { length: 4.76, width: 1.83, height: 1.44, bodyZ: -0.07, wheelbase: 2.82, track: 1.58, wheelRadius: 0.33, mass: 1450, comY: 0.36 },
  transporter: { length: 4.9, width: 1.9, height: 1.97, bodyZ: 0.03, wheelbase: 3.0, track: 1.62, wheelRadius: 0.343, mass: 1900, comY: 0.45 },
  smart: { length: 2.7, width: 1.56, height: 1.55, bodyZ: 0.055, wheelbase: 1.87, track: 1.36, wheelRadius: 0.29, mass: 880, comY: 0.36 },
  // the cabin (the collider box); wheelbase / track: where the skids touch the ground
  heli: {
    length: 4.2, width: 1.7, height: 2.1, bodyZ: 0.3, wheelbase: 2.2, track: 2.0, wheelRadius: 0.12, mass: 1100, comY: 0.7,
    fly: { tail: { z: -4.3, y: 1.45, halfX: 0.2, halfY: 0.3, halfZ: 2.5 } },
  },
};

/** Share of each type among the parked cars (same order as CAR_TYPES). */
/** (the helicopter is never dealt out: it is placed by hand, see the pipeline's HELI_SPOT) */
export const CAR_TYPE_WEIGHTS = [0.36, 0.32, 0.16, 0.16, 0] as const;

/** Type index for a uniform random number u in [0, 1). */
export function carTypeFor(u: number): number {
  let acc = 0, last = 0;
  for (let i = 0; i < CAR_TYPE_WEIGHTS.length; i++) {
    if (CAR_TYPE_WEIGHTS[i]! <= 0) continue;
    acc += CAR_TYPE_WEIGHTS[i]!;
    last = i;
    if (u < acc) return i;
  }
  return last;
}

export const carTypeOf = (index: number | undefined): CarType => CAR_TYPES[index ?? 0] ?? 'kleinwagen';
