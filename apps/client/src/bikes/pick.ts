type XZ = { x: number; z: number };

/** How many metres "facing away" (180°) costs when choosing between a car and a bike in reach. */
const FACING_WEIGHT = 1.5;

/**
 * E on foot with a car and/or a bike in reach: the one the player faces, else the nearer (score = distance +
 * FACING_WEIGHT · (1 − cos angle)). heading: forward = (sin h, cos h).
 */
export function pickVehicle(player: XZ, heading: number, car: XZ | null, bike: XZ | null): 'car' | 'bike' | null {
  const score = (v: XZ) => {
    const dx = v.x - player.x, dz = v.z - player.z;
    const d = Math.hypot(dx, dz);
    const cos = d > 1e-6 ? (dx * Math.sin(heading) + dz * Math.cos(heading)) / d : 1;
    return d + FACING_WEIGHT * (1 - cos);
  };
  if (!car) return bike ? 'bike' : null;
  if (!bike) return 'car';
  return score(bike) <= score(car) ? 'bike' : 'car';
}
