/** Car types; the index is the `type` number of a parked car in the manifest. Models: data/models/cars/<type>. */
export const CAR_TYPES = ['kleinwagen', 'mittelklasse', 'transporter', 'smart'] as const;
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
};

/** Measured off the Blender models (data/models/cars/<type>/build.py). */
export const CAR_SPECS: Record<CarType, CarSpec> = {
  kleinwagen: { length: 4.05, width: 1.75, height: 1.47, bodyZ: 0.05, wheelbase: 2.55, track: 1.5, wheelRadius: 0.305, mass: 1150, comY: 0.36 },
  mittelklasse: { length: 4.76, width: 1.83, height: 1.44, bodyZ: -0.07, wheelbase: 2.82, track: 1.58, wheelRadius: 0.33, mass: 1450, comY: 0.36 },
  transporter: { length: 4.9, width: 1.9, height: 1.97, bodyZ: 0.03, wheelbase: 3.0, track: 1.62, wheelRadius: 0.343, mass: 1900, comY: 0.45 },
  smart: { length: 2.7, width: 1.66, height: 1.55, bodyZ: 0.055, wheelbase: 1.87, track: 1.46, wheelRadius: 0.29, mass: 880, comY: 0.36 },
};

/** Share of each type among the parked cars (same order as CAR_TYPES). */
export const CAR_TYPE_WEIGHTS = [0.36, 0.32, 0.16, 0.16] as const;

/** Type index for a uniform random number u in [0, 1). */
export function carTypeFor(u: number): number {
  let acc = 0;
  for (let i = 0; i < CAR_TYPE_WEIGHTS.length; i++) {
    acc += CAR_TYPE_WEIGHTS[i]!;
    if (u < acc) return i;
  }
  return CAR_TYPE_WEIGHTS.length - 1;
}

export const carTypeOf = (index: number | undefined): CarType => CAR_TYPES[index ?? 0] ?? 'kleinwagen';
