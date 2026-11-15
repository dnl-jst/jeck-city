import { staticWorldFilter, type PhysicsWorld } from './world';

const STATIC_ONLY = staticWorldFilter();

/** Ray length of surfaceY (m): any terrain height lies within it (heights may be negative, below the datum). */
const SURFACE_RAY = 200;

/** Height of the first static surface below (x, fromY, z), or null. */
export function surfaceY(pw: PhysicsWorld, x: number, z: number, fromY: number): number | null {
  const { rapier: R, world: w } = pw;
  const hit = w.castRay(new R.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }), SURFACE_RAY, true, undefined, undefined, undefined, undefined, STATIC_ONLY);
  return hit ? fromY - hit.timeOfImpact : null;
}
