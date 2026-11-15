import type { WorldManifest } from '../assets/manifest';
import { heightAt, type TerrainGrid } from '../assets/terrain';
import { surfaceY } from '../physics/surface';
import { TUNING } from '../physics/tuning';
import { staticWorldFilter, type PhysicsWorld } from '../physics/world';
import { SPAWN_MAX_DIST, SPAWN_STEP } from '../net/constants';

type Vec3 = { x: number; y: number; z: number };

/** Everything solid a spawning person must not stand in: city, cars, fallen lamps, trees and lamp posts. */
const SOLID = staticWorldFilter(true, undefined, true);
/** Spawn-test capsule bottom above the surface (m): clear of the ground it stands on, low enough to touch a kerb-high obstacle. */
const CLEARANCE = 0.1;
/**
 * A candidate must stand as high above the terrain as the manifest spawn (the sidewalk) within this (m, half a kerb):
 * the street axis crosses side streets and driveways at road level and, further out, leaves the sidewalk of a curving
 * street; nobody should spawn on the road there.
 */
const SIDEWALK_TOL = 0.06;

/** Height of the first surface below 3 m above the terrain at (x, z) (sidewalk, kerb or the ground itself). */
export function standY(pw: PhysicsWorld, terrain: TerrainGrid, x: number, z: number): number {
  const ground = heightAt(terrain, x, z);
  return surfaceY(pw, x, z, ground + 3) ?? ground;
}

/**
 * Spawn candidates in order: the manifest spawn, then alternately ±k·SPAWN_STEP along the street (the spawn's
 * heading axis, forward = (sin h, cos h)) up to SPAWN_MAX_DIST.
 */
export function spawnCandidates(spawn: WorldManifest['spawn']): { x: number; z: number }[] {
  const s = Math.sin(spawn.heading), c = Math.cos(spawn.heading);
  const out = [{ x: spawn.x, z: spawn.z }];
  for (let k = 1; k * SPAWN_STEP <= SPAWN_MAX_DIST + 1e-9; k++) {
    for (const sign of [1, -1]) out.push({ x: spawn.x + sign * k * SPAWN_STEP * s, z: spawn.z + sign * k * SPAWN_STEP * c });
  }
  return out;
}

/**
 * Feet position for a new player: the first candidate (see spawnCandidates) on the sidewalk (as high above the terrain
 * as the manifest spawn) where a standing capsule overlaps nothing in the world and `occupied` (other people and
 * things the physics queries cannot see yet) is false; the manifest spawn if all are taken. y is the surface the feet
 * stand on.
 */
export function findSpawn(pw: PhysicsWorld, manifest: WorldManifest, terrain: TerrainGrid, occupied: (x: number, z: number) => boolean): Vec3 {
  const { rapier: R, world } = pw;
  const T = TUNING.character;
  const capsule = new R.Capsule(T.height / 2 - T.radius, T.radius);
  const kerb = manifest.spawn.y - heightAt(terrain, manifest.spawn.x, manifest.spawn.z);
  for (const p of spawnCandidates(manifest.spawn)) {
    if (occupied(p.x, p.z)) continue;
    const y = standY(pw, terrain, p.x, p.z);
    if (Math.abs(y - heightAt(terrain, p.x, p.z) - kerb) > SIDEWALK_TOL) continue;
    const centre = { x: p.x, y: y + CLEARANCE + T.height / 2, z: p.z };
    if (world.intersectionWithShape(centre, { x: 0, y: 0, z: 0, w: 1 }, capsule, undefined, undefined, undefined, undefined, SOLID) === null) {
      return { x: p.x, y, z: p.z };
    }
  }
  const { x, z } = manifest.spawn;
  return { x, y: standY(pw, terrain, x, z), z };
}
