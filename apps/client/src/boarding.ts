import { BOARD_WALK_SPEED, DOOR_OPEN_S, LEAVE_S, SIT_S, type CarPoint } from '@nn/shared';
import { Vector3 } from 'three';

/**
 * What getting into and out of a car looks like over time (the simulation seats the player at once; see boarding in
 * @nn/shared): the walk to the door, the door, the slide between the door and the seat.
 */

/** The door shuts this long after the figure sits (s); the ignition's door sound follows right after. */
export const DOOR_SHUT_S = 0.3;
/** How far the seated figure leans back (rad). */
export const SEAT_RECLINE = 0.36;

/**
 * walk: where the figure walks (car frame) and which way, or null once it stands at the door; door: 0 shut … 1 open;
 * slide: 0 standing at the door … 1 in the seat; done: the sequence is over.
 */
export type BoardStage = { walk: CarPoint | null; heading: CarPoint | null; door: number; slide: number; done: boolean };

const smooth = (k: number): number => { const t = Math.max(0, Math.min(1, k)); return t * t * (3 - 2 * t); };

/** Getting in, t seconds after pressing E, along `path` (boardingPath). */
export function enterStage(path: readonly CarPoint[], t: number): BoardStage {
  let left = t * BOARD_WALK_SPEED;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, n = Math.hypot(b.x - a.x, b.u - a.u);
    if (left < n) {
      const k = left / n;
      return { walk: { x: a.x + (b.x - a.x) * k, u: a.u + (b.u - a.u) * k }, heading: { x: (b.x - a.x) / n, u: (b.u - a.u) / n }, door: 0, slide: 0, done: false };
    }
    left -= n;
  }
  const s = left / BOARD_WALK_SPEED; // seconds at the door
  if (s < DOOR_OPEN_S) return { walk: null, heading: null, door: s / DOOR_OPEN_S, slide: 0, done: false };
  if (s < DOOR_OPEN_S + SIT_S) return { walk: null, heading: null, door: 1, slide: smooth((s - DOOR_OPEN_S) / SIT_S), done: false };
  const shut = (s - DOOR_OPEN_S - SIT_S) / DOOR_SHUT_S;
  return { walk: null, heading: null, door: Math.max(0, 1 - shut), slide: 1, done: shut >= 1 };
}

/** Getting out, t seconds after it began: the reverse, without the walk. */
export function leaveStage(t: number): BoardStage {
  if (t < DOOR_OPEN_S) return { walk: null, heading: null, door: t / DOOR_OPEN_S, slide: 1, done: false };
  if (t < DOOR_OPEN_S + SIT_S) return { walk: null, heading: null, door: 1, slide: 1 - smooth((t - DOOR_OPEN_S) / SIT_S), done: false };
  const shut = (t - DOOR_OPEN_S - SIT_S) / (LEAVE_S - DOOR_OPEN_S - SIT_S);
  return { walk: null, heading: null, door: Math.max(0, 1 - shut), slide: 0, done: shut >= 1 };
}

/**
 * Where a seated figure's feet rest, in the car model's frame (x left, y up, z forward): on the floor ahead of the
 * seat – further ahead under a low seat (legs stretched), closer under a high one (legs down).
 */
export function footTargets(seat: { x: number; u: number; h: number }, floor: number): [Vector3, Vector3] {
  const ahead = Math.max(0.45, Math.min(0.75, 0.82 - 0.6 * (seat.h - floor)));
  return [1, -1].map((s) => new Vector3(seat.x + s * 0.1, floor + 0.08, seat.u + ahead)) as [Vector3, Vector3];
}

/** A whole-body pose in the car model's frame: hips, facing (0 = ahead, about the vertical), forward lean, ankles. */
export type BodyPose = {
  hip: Vector3; yaw: number; pitch: number; feet: [Vector3, Vector3];
  /** Where the hands hang beside the body (left, right), and how far (0..1) they have settled on wheel or thighs. */
  hands: [Vector3, Vector3]; settle: number;
};

/** From the hips up the back to the middle of the head, and from there to its top (m; a figure of 1.78 m). */
export const BACK = 0.72, HEAD_R = 0.12;

/** The stations of getting in, as shares of the way: turned and stepping in, sitting down, the trailing leg in. */
const STEP_IN = 0.35, SIT_DOWN = 0.7;

/**
 * Getting into a seat, k = 0 (standing at the open door, turned to the car) … 1 (sitting): the body turns ahead and
 * the leg next to the car steps into the footwell; the hips come down onto the seat, the body ducked under the roof
 * edge; the trailing leg lifts over the sill; the back settles. Getting out is the same run backwards.
 * seat: hip point (car frame), stand: where the figure stands at the door, hipStand: its hip height standing, roof:
 * the car's height – passing the door frame the body bends low enough for the head to stay under it.
 */
export function boardPose(
  k: number, seat: { x: number; u: number; h: number }, floor: number, stand: { x: number; u: number }, hipStand: number, recline: number, roof: number,
): BodyPose {
  const s = Math.sign(stand.x - seat.x) || 1; // +1: the door is on the left
  const t = Math.max(0, Math.min(1, k));
  const [i, f] = t < STEP_IN ? [0, t / STEP_IN] : t < SIT_DOWN ? [1, (t - STEP_IN) / (SIT_DOWN - STEP_IN)] : [2, (t - SIT_DOWN) / (1 - SIT_DOWN)];
  const e = smooth(f);
  const mix = (a: number[], b = a) => a[i]! + (b[i + 1]! - a[i]!) * e;
  // in the door frame: bent well forward and turned into the car, the hips low enough that the head (its middle
  // ≈ 0.72 m up the bent back from the hips, its top 0.12 m above that) passes under the frame, 0.16 m below the roof
  const duck = 0.85, under = roof - 0.16 - HEAD_R - BACK * Math.cos(duck);
  const hips = [
    new Vector3(stand.x, hipStand, stand.u), new Vector3(seat.x + s * 0.42, Math.min(seat.h + (hipStand - seat.h) * 0.55, under), seat.u),
    new Vector3(seat.x + s * 0.05, seat.h + 0.02, seat.u), new Vector3(seat.x, seat.h, seat.u),
  ];
  const hip = hips[i]!.clone().lerp(hips[i + 1]!, e);
  const yaws = [-s * 1.45, -s * 1.0, -s * 0.25, 0], pitches = [0.05, duck, 0.25, -recline]; // (on the seat only a little forward: the windscreen is close)
  const yaw = mix(yaws, yaws), pitch = mix(pitches, pitches);
  // ankles: seated on the floor ahead; standing on the ground at the door, a little apart
  const sitting = footTargets(seat, floor);
  const inner = s > 0 ? 1 : 0; // turned ahead, the foot next to the car
  const feet = [0, 1].map((n) => {
    const side = n === 0 ? 1 : -1;
    const ground = new Vector3(stand.x, 0.08, stand.u + side * s * 0.1);
    if (n === inner) {
      // steps in first, lifted over the sill
      if (i > 0) return sitting[n]!.clone();
      const p = ground.lerp(sitting[n]!, e);
      p.y += 0.28 * Math.sin(Math.PI * f);
      return p;
    }
    // the trailing foot turns on the ground beside the seat, then follows over the sill
    const pivot = new Vector3(seat.x + s * 0.78, 0.08, seat.u + 0.22);
    if (i === 0) return ground.lerp(pivot, e);
    if (i === 1) return pivot;
    const p = pivot.lerp(sitting[n]!, e);
    p.y += 0.3 * Math.sin(Math.PI * f);
    return p;
  }) as [Vector3, Vector3];
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const hands = [1, -1].map((side) => {
    const x = side * 0.24, z = 0.1; // beside the hips, a little ahead; turned with the body
    return new Vector3(hip.x + x * c + z * sn, hip.y - 0.1, hip.z - x * sn + z * c);
  }) as [Vector3, Vector3];
  return { hip, yaw, pitch, feet, hands, settle: i === 2 ? e : 0 };
}
