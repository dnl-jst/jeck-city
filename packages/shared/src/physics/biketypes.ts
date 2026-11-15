/** Bike types; the index is the `type` number in the manifest. */
export const BIKE_TYPES = ['dutch', 'road', 'mtb', 'longjohn', 'trike'] as const;
export type BikeType = (typeof BIKE_TYPES)[number];

export type BikeSpec = {
  /** Top speed pedalling normally / sprinting (km/h). */
  cruiseKmh: number;
  sprintKmh: number;
  /** Acceleration (m/s²) pedalling / sprinting, and braking deceleration. */
  accel: number;
  sprintAccel: number;
  brake: number;
  /** Wheelbase and overall width (m): collider size and steering geometry. */
  wheelbase: number;
  width: number;
  /** Front wheel angle (rad) at full steer: lowLock below 5 km/h, tapering to highLock at 35 km/h. */
  steerLowLock: number;
  steerHighLock: number;
  /** Visual lean limit (degrees); 0 = does not lean (trike). */
  maxLeanDeg: number;
  /** Take-off speed of a hop (m/s); apex = hopSpeed² / (2·|TUNING.bike.gravity|). */
  hopSpeed: number;
  /** E-assist: full acceleration up to this speed (km/h), fading to zero at the top speed. */
  assistKmh?: number;
  /** Mass of the unridden bike (kg). */
  massParked: number;
};

/** Starting values (spec table); tune in the browser. */
export const BIKE_SPECS: Record<BikeType, BikeSpec> = {
  dutch: { cruiseKmh: 20, sprintKmh: 30, accel: 2.2, sprintAccel: 3.2, brake: 6, wheelbase: 1.12, width: 0.62, steerLowLock: 0.55, steerHighLock: 0.1, maxLeanDeg: 35, hopSpeed: 3.6, massParked: 18 },
  road: { cruiseKmh: 30, sprintKmh: 45, accel: 3.2, sprintAccel: 4.6, brake: 7, wheelbase: 1.0, width: 0.45, steerLowLock: 0.5, steerHighLock: 0.08, maxLeanDeg: 35, hopSpeed: 4.0, massParked: 9 },
  mtb: { cruiseKmh: 25, sprintKmh: 38, accel: 2.9, sprintAccel: 4.2, brake: 7, wheelbase: 1.15, width: 0.72, steerLowLock: 0.6, steerHighLock: 0.1, maxLeanDeg: 35, hopSpeed: 4.5, massParked: 14 },
  longjohn: { cruiseKmh: 22, sprintKmh: 28, accel: 3.0, sprintAccel: 3.8, brake: 5.5, wheelbase: 1.95, width: 0.66, steerLowLock: 0.45, steerHighLock: 0.07, maxLeanDeg: 30, hopSpeed: 3.0, assistKmh: 25, massParked: 45 },
  trike: { cruiseKmh: 18, sprintKmh: 25, accel: 2.8, sprintAccel: 3.5, brake: 5, wheelbase: 1.6, width: 0.9, steerLowLock: 0.5, steerHighLock: 0.1, maxLeanDeg: 0, hopSpeed: 2.6, assistKmh: 22, massParked: 55 },
};
