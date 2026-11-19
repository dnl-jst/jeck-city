import type { SeatLayout } from '../physics/carseats';
import type { CarSpec } from '../physics/cartypes';

/**
 * Getting into a car on foot: where the figure stands at a door, the way round the car to it and how long that takes.
 * The simulation seats the player at once; this is what the ignition waits for and what the clients show.
 */

/** A point in a car's frame on the ground: x to the left, u ahead of the axle midpoint (m). */
export type CarPoint = { x: number; u: number };

/**
 * How fast the figure walks to its door (m/s), and how long the rest takes (s): reaching for the handle and pulling
 * the door open, stepping round the open door into the opening, getting into the seat, pulling the door shut.
 */
export const BOARD_WALK_SPEED = 2.2, DOOR_OPEN_S = 0.7, STEP_S = 0.45, SIT_S = 1.3, DOOR_SHUT_S = 0.7;
/** Getting out is the same backwards, without the walk (s). */
export const LEAVE_S = DOOR_OPEN_S + STEP_S + SIT_S + DOOR_SHUT_S;
/** Where the figure waits to open a door: this far from the car's centre line, and behind the door's rear edge. */
const APPROACH_SIDE = 1.5, APPROACH_BEHIND = 0.25;
/** The figure stands this far outside the door's hinge line. */
const STAND_OUT = 0.55;
/** The way round keeps this clear of the body; its corners lie CORNER out. */
const CLEAR = 0.3, CORNER = 0.5;

/** Where the figure stands to get into (or after getting out of) seat `seat`: beside the seat, outside its door. */
export function standPoint(layout: SeatLayout, seat: number): CarPoint {
  const s = layout.seats[seat]!, d = layout.doors[s.door]!;
  return { x: d.hingeX + Math.sign(d.hingeX) * STAND_OUT, u: s.u };
}

/**
 * Where the figure stands to open the door of seat `seat` (and to shut it after getting out): beside the car, just
 * behind the door's rear edge – outside the arc the door swings through.
 */
export function approachPoint(layout: SeatLayout, seat: number): CarPoint {
  const d = layout.doors[layout.seats[seat]!.door]!;
  return { x: Math.sign(d.hingeX) * APPROACH_SIDE, u: d.rearU - APPROACH_BEHIND };
}

/** Whether the segment a–b passes through the box |x| < w, u0 < u < u1. */
function crosses(a: CarPoint, b: CarPoint, w: number, u0: number, u1: number): boolean {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, du = b.u - a.u;
  for (const [p, q] of [[-dx, a.x + w], [dx, w - a.x], [-du, a.u - u0], [du, u1 - a.u]] as const) {
    if (Math.abs(p) < 1e-9) {
      if (q <= 1e-6) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  return t1 - t0 > 1e-6;
}

export function pathLength(path: readonly CarPoint[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.u - path[i - 1]!.u);
  return n;
}

/**
 * The way on foot from `from` (car frame) to where the door of `seat` is opened from (approachPoint).
 */
export function boardingPath(spec: CarSpec, layout: SeatLayout, seat: number, from: CarPoint): CarPoint[] {
  return pathTo(spec, approachPoint(layout, seat), from);
}

/**
 * The way on foot from `from` to `to` beside a car (car frame): straight if nothing is in the way, else round the front
 * or the rear of the car, whichever is shorter. Other obstacles are not considered.
 */
export function pathTo(spec: CarSpec, to: CarPoint, from: CarPoint): CarPoint[] {
  const w = spec.width / 2 + CLEAR, u0 = spec.bodyZ - spec.length / 2 - CLEAR, u1 = spec.bodyZ + spec.length / 2 + CLEAR;
  const hits = (a: CarPoint, b: CarPoint) => crosses(a, b, w, u0, u1);
  const head: CarPoint[] = [from];
  let p = from;
  if (Math.abs(p.x) < w && p.u > u0 && p.u < u1) {
    // standing closer to the body than the way round keeps: first step clear of it, the nearest way out
    const out = [{ x: w, u: p.u }, { x: -w, u: p.u }, { x: p.x, u: u0 }, { x: p.x, u: u1 }]
      .sort((a, b) => Math.hypot(a.x - p.x, a.u - p.u) - Math.hypot(b.x - p.x, b.u - p.u))[0]!;
    head.push(out);
    p = out;
  }
  if (!hits(p, to)) return [...head, to];
  const wc = spec.width / 2 + CORNER;
  const side = Math.abs(p.x) < 0.05 ? Math.sign(to.x) : Math.sign(p.x);
  const routes = [spec.bodyZ + spec.length / 2 + CORNER, spec.bodyZ - spec.length / 2 - CORNER].map((u) => {
    const pts = [p, { x: side * wc, u }, { x: Math.sign(to.x) * wc, u }, to];
    for (let i = pts.length - 2; i >= 1; i--) {
      const same = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.u - pts[i - 1]!.u) < 1e-6;
      if (same || !hits(pts[i - 1]!, pts[i + 1]!)) pts.splice(i, 1);
    }
    return pts;
  });
  const best = pathLength(routes[0]!) <= pathLength(routes[1]!) ? routes[0]! : routes[1]!;
  return [...head, ...best.slice(1)];
}

/** Seconds from pressing E until the figure sits: the walk along `path`, the door, the step into the opening, sitting down. */
export function boardSeconds(path: readonly CarPoint[]): number {
  return pathLength(path) / BOARD_WALK_SPEED + DOOR_OPEN_S + STEP_S + SIT_S;
}

/** A world point (x, z) in the frame of a car at (x, z) facing heading (forward = (sin h, cos h), left = (cos h, −sin h)). */
export function toCarPoint(car: { x: number; z: number; heading: number }, x: number, z: number): CarPoint {
  const s = Math.sin(car.heading), c = Math.cos(car.heading), dx = x - car.x, dz = z - car.z;
  return { x: dx * c - dz * s, u: dx * s + dz * c };
}

/** The world (x, z) of a point in a car's frame. */
export function fromCarPoint(car: { x: number; z: number; heading: number }, p: CarPoint): { x: number; z: number } {
  const s = Math.sin(car.heading), c = Math.cos(car.heading);
  return { x: car.x + p.x * c + p.u * s, z: car.z - p.x * s + p.u * c };
}

/** The driver's seat. */
export const DRIVER_SEAT = 0;

/**
 * The seat someone standing at `from` (car frame) gets: of the free seats (taken[i] false) the one with the shortest
 * walk to its door (to beside the seat) – the seat behind the door they stand at, if it is free. null when the car is full.
 */
export function pickSeat(spec: CarSpec, layout: SeatLayout, taken: readonly boolean[], from: CarPoint): number | null {
  let best: number | null = null, bestLen = Infinity;
  for (let i = 0; i < layout.seats.length; i++) {
    if (taken[i]) continue;
    const n = pathLength(pathTo(spec, standPoint(layout, i), from));
    if (n < bestLen - 1e-9) [best, bestLen] = [i, n];
  }
  return best;
}
