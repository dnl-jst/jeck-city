import type RAPIER from '@dimforge/rapier3d-compat';
import { heightAt, terrainNormal, type TerrainGrid } from '../assets/terrain';
import { TUNING } from '../physics/tuning';
import { VEHICLE_REST_Y } from '../physics/vehicle';
import { staticWorldFilter, type PhysicsWorld } from '../physics/world';
import { ENTER_MAX_DIST } from '../net/constants';

type XZ = { x: number; z: number };
export type CarPose = { x: number; y: number; z: number; qx: number; qy: number; qz: number; qw: number };

/**
 * Pose of a parked car at (x, z) facing heading: the chassis centre rests VEHICLE_REST_Y above the terrain,
 * tilted from upright onto the terrain normal (yaw first, then the tilt, so the heading is kept).
 * q = tilt · yaw, tilt = shortest rotation from (0, 1, 0) onto the normal n, yaw = rotation about +y by heading.
 */
export function parkedPose(x: number, z: number, heading: number, t: TerrainGrid): CarPose {
  const n = terrainNormal(t, x, z);
  // shortest arc (0,1,0) → n: axis (0,1,0) × n = (n.z, 0, −n.x), w = 1 + n.y, normalised (n.y > 0, never opposite)
  let ax = n.z, az = -n.x, aw = 1 + n.y;
  const l = Math.hypot(ax, az, aw);
  ax /= l; az /= l; aw /= l;
  const by = Math.sin(heading / 2), bw = Math.cos(heading / 2);
  // Hamilton product tilt · yaw with tilt = (ax, 0, az, aw), yaw = (0, by, 0, bw)
  return {
    x, y: heightAt(t, x, z) + VEHICLE_REST_Y, z,
    qx: ax * bw - az * by,
    qy: aw * by,
    qz: az * bw + ax * by,
    qw: aw * bw,
  };
}

/** Free car (not occupied) nearest to the player within maxDist, by id; null if none. */
export function nearestEnterableCar(player: XZ, cars: { id: number; x: number; z: number; occupied: boolean }[], maxDist = ENTER_MAX_DIST): number | null {
  let best: number | null = null;
  let bestD = maxDist;
  for (const c of cars) {
    if (c.occupied) continue;
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    if (d <= bestD) [best, bestD] = [c.id, d];
  }
  return best;
}

/** Getting out is only possible below this speed (m/s). */
export const EXIT_MAX_SPEED = 2;
export const canGetOut = (speed: number): boolean => Math.abs(speed) < EXIT_MAX_SPEED;

/** Lateral distance of the exit spot from the car's centre line (m): 0.6 m clear of the 1.8 m wide body. */
export const EXIT_SIDE = 1.5;
/** Distance of the fallback exit spot behind the car's centre (m): 0.9 m clear of the 4.2 m long body. */
export const EXIT_BEHIND = TUNING.vehicle.length / 2 + 0.9;

/**
 * Where the driver gets out: 1.5 m to the left of the car; if that spot is blocked, to the right;
 * else behind the car. null when all three are blocked. Heading h: forward = (sin h, cos h), left = (cos h, −sin h).
 */
export function exitSpot(car: { x: number; z: number; heading: number }, isFree: (x: number, z: number) => boolean): XZ | null {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  const spots = [
    { x: car.x + c * EXIT_SIDE, z: car.z - s * EXIT_SIDE },
    { x: car.x - c * EXIT_SIDE, z: car.z + s * EXIT_SIDE },
    { x: car.x - s * EXIT_BEHIND, z: car.z - c * EXIT_BEHIND },
  ];
  return spots.find((p) => isFree(p.x, p.z)) ?? null;
}

/** Heading (forward = (sin h, cos h)) of a chassis rotation. */
export function headingOf(q: { qx: number; qy: number; qz: number; qw: number }): number {
  // local +z rotated by q, projected onto x/z
  const fx = 2 * (q.qx * q.qz + q.qw * q.qy);
  const fz = 1 - 2 * (q.qx * q.qx + q.qy * q.qy);
  return Math.atan2(fx, fz);
}

/**
 * Exit spot test: nothing static or dynamic between the car's centre and the spot (ray at 1 m, so no
 * stepping out through a wall into a building), and a standing capsule at the spot touches nothing.
 * `chassis` is the car being left (ignored by both tests).
 */
export function exitFree(pw: PhysicsWorld, terrain: TerrainGrid, chassis: RAPIER.RigidBody, car: CarPose, x: number, z: number): boolean {
  const { rapier: R, world: w } = pw;
  const solid = staticWorldFilter(true, chassis, true); // city, other cars, trees and lamps; not this car or the player
  const dx = x - car.x, dz = z - car.z, d = Math.hypot(dx, dz);
  const y = car.y + 0.1;
  const reach = d + TUNING.character.radius;
  if (w.castRay(new R.Ray({ x: car.x, y, z: car.z }, { x: dx / d, y: 0, z: dz / d }), reach, true, undefined, undefined, undefined, undefined, solid)) return false;
  const T = TUNING.character;
  const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
  // bottom 0.3 m above the road: clears kerbs, touches walls, posts and other cars
  // (from the higher of the car's ground and the terrain at the spot, so cross-slopes don't block it)
  const bottom = Math.max(car.y - VEHICLE_REST_Y, heightAt(terrain, x, z) + 0.12) + 0.3;
  const centre = { x, y: bottom + T.height / 2, z };
  return w.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, solid) === null;
}
