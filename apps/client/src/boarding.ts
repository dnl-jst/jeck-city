import { BOARD_WALK_SPEED, DOOR_OPEN_S, DOOR_SHUT_S, LEAVE_S, SIT_S, STEP_S, type CarPoint } from '@nn/shared';
import { Vector3 } from 'three';

/**
 * What getting into and out of a car looks like over time (the simulation seats the player at once; see boarding in
 * @nn/shared): the walk to the door, then at the door
 *   'handle' – standing behind the door's rear edge, the hand goes to the handle and pulls the door open
 *   'step'   – round the open door into the opening, turning to the car
 *   'sit'    – into the seat (boardPose)
 *   'shut'   – seated, the hand pulls the door shut
 * Getting out is the same run backwards. The door only moves in 'handle' and 'shut', when nobody is in its way.
 */

/** How far the seated figure leans back (rad). */
export const SEAT_RECLINE = 0.36;
/** Of 'handle': the share spent reaching before the door moves. Of 'shut': the share in which the door closes. */
const REACH = 0.3, CLOSING = 0.75;

export type DoorPhase = 'handle' | 'step' | 'sit' | 'shut';
/**
 * walk: where the figure walks (car frame) and which way, while it is still on its way to the door (phase null);
 * phase / k: what it does at the door and how far through that it is (0..1); door: 0 shut … 1 open; done: over.
 */
export type BoardStage = { walk: CarPoint | null; heading: CarPoint | null; phase: DoorPhase | null; k: number; door: number; done: boolean };

const smooth = (k: number): number => { const t = Math.max(0, Math.min(1, k)); return t * t * (3 - 2 * t); };

/** At the door, s seconds after arriving there (s runs backwards when getting out). */
function atDoor(s: number): Omit<BoardStage, 'done'> {
  const none = { walk: null, heading: null };
  if (s < DOOR_OPEN_S) {
    const k = Math.max(0, s) / DOOR_OPEN_S;
    return { ...none, phase: 'handle', k, door: smooth((k - REACH) / (1 - REACH)) };
  }
  if (s < DOOR_OPEN_S + STEP_S) return { ...none, phase: 'step', k: (s - DOOR_OPEN_S) / STEP_S, door: 1 };
  if (s < DOOR_OPEN_S + STEP_S + SIT_S) return { ...none, phase: 'sit', k: (s - DOOR_OPEN_S - STEP_S) / SIT_S, door: 1 };
  const k = Math.min(1, (s - DOOR_OPEN_S - STEP_S - SIT_S) / DOOR_SHUT_S);
  return { ...none, phase: 'shut', k, door: 1 - smooth(k / CLOSING) };
}

/** Getting in, t seconds after pressing E, along `path` (boardingPath: to where the door is opened from). */
export function enterStage(path: readonly CarPoint[], t: number): BoardStage {
  let left = t * BOARD_WALK_SPEED;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!, n = Math.hypot(b.x - a.x, b.u - a.u);
    if (left < n) {
      const k = left / n;
      return { walk: { x: a.x + (b.x - a.x) * k, u: a.u + (b.u - a.u) * k }, heading: { x: (b.x - a.x) / n, u: (b.u - a.u) / n }, phase: null, k: 0, door: 0, done: false };
    }
    left -= n;
  }
  const s = left / BOARD_WALK_SPEED; // seconds at the door
  return { ...atDoor(s), done: s >= LEAVE_S };
}

/** Getting out, t seconds after it began: getting in at the door, backwards. */
export function leaveStage(t: number): BoardStage {
  return { ...atDoor(LEAVE_S - t), done: t >= LEAVE_S };
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

/** The stations of getting into the seat, as shares of the way: ducked, in the door frame, on the seat. */
const STATIONS = [0, 0.22, 0.42, 0.72, 1];

/**
 * Getting into a seat, k = 0 (standing in the open door, turned to the car) … 1 (sitting): still outside, the body
 * bends forward and down until the head is below the door frame; the leg next to the car steps into the footwell and
 * the hips move in, bent like that; they come down onto the seat while the body straightens under the roof; the
 * trailing leg lifts over the sill and the back settles. Getting out is the same run backwards.
 * seat: hip point (car frame), stand: where the figure stands in the door, hipStand: its hip height standing, roof:
 * the car's height.
 */
export function boardPose(
  k: number, seat: { x: number; u: number; h: number }, floor: number, stand: { x: number; u: number }, hipStand: number, recline: number, roof: number,
): BodyPose {
  const s = Math.sign(stand.x - seat.x) || 1; // +1: the door is on the left
  const t = Math.max(0, Math.min(1, k));
  let i = 0;
  while (i < STATIONS.length - 2 && t >= STATIONS[i + 1]!) i++;
  const f = (t - STATIONS[i]!) / (STATIONS[i + 1]! - STATIONS[i]!), e = smooth(f);
  // ducked: bent well forward and turned into the car, the hips low enough that the head (its middle BACK up the bent
  // back from the hips, its top HEAD_R above that) is 0.16 m below the roof – under the door frame
  const duck = 0.85, under = roof - 0.16 - HEAD_R - BACK * Math.cos(duck);
  const low = Math.min(hipStand, under);
  const hips = [
    new Vector3(stand.x, hipStand, stand.u), new Vector3(stand.x - s * 0.08, low, stand.u),
    new Vector3(seat.x + s * 0.42, Math.min(seat.h + (hipStand - seat.h) * 0.55, low), seat.u),
    new Vector3(seat.x + s * 0.05, seat.h + 0.02, seat.u), new Vector3(seat.x, seat.h, seat.u),
  ];
  const hip = hips[i]!.clone().lerp(hips[i + 1]!, e);
  const yaws = [-s * 1.45, -s, -s, -s * 0.25, 0], pitches = [0.05, duck, duck, 0.25, -recline];
  const yaw = yaws[i]! + (yaws[i + 1]! - yaws[i]!) * e;
  // coming down onto the seat the body stays bent a little longer than the hips take (the roof is low there)
  const pe = i === 2 ? e * e : e;
  const pitch = pitches[i]! + (pitches[i + 1]! - pitches[i]!) * pe;
  // ankles: seated on the floor ahead; standing on the ground in the door, a little apart
  const sitting = footTargets(seat, floor);
  const inner = s > 0 ? 1 : 0; // turned ahead, the foot next to the car
  const feet = [0, 1].map((n) => {
    const side = n === 0 ? 1 : -1;
    const ground = new Vector3(stand.x, 0.08, stand.u + side * s * 0.1);
    if (n === inner) {
      // steps in while the hips move into the door frame, lifted over the sill
      if (i === 0) return ground;
      if (i > 1) return sitting[n]!.clone();
      const p = ground.lerp(sitting[n]!, e);
      p.y += 0.28 * Math.sin(Math.PI * f);
      return p;
    }
    // the trailing foot turns on the ground beside the seat, then follows over the sill
    const pivot = new Vector3(seat.x + s * 0.78, 0.08, seat.u + 0.22);
    if (i === 0) return ground;
    if (i === 1) return ground.lerp(pivot, e);
    if (i === 2) return pivot;
    const p = pivot.lerp(sitting[n]!, e);
    p.y += 0.3 * Math.sin(Math.PI * f);
    return p;
  }) as [Vector3, Vector3];
  return { hip, yaw, pitch, feet, hands: hangingHands(hip, yaw), settle: i === 3 ? e : 0 };
}

/** Where the hands hang beside the body (left, right) for hips at `hip`, turned by `yaw`. */
export function hangingHands(hip: Vector3, yaw: number): [Vector3, Vector3] {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  return [1, -1].map((side) => {
    const x = side * 0.24, z = 0.1; // beside the hips, a little ahead; turned with the body
    return new Vector3(hip.x + x * c + z * sn, hip.y - 0.1, hip.z - x * sn + z * c);
  }) as [Vector3, Vector3];
}

/**
 * Standing at (x, u) in the car's frame, turned by `yaw`: hips at standing height, feet on the ground under them
 * (lifted in turn by `stride` 0..1 while stepping), hands hanging.
 */
export function standPose(at: CarPoint, yaw: number, hipStand: number, stride = 0): BodyPose {
  const hip = new Vector3(at.x, hipStand, at.u), c = Math.cos(yaw), sn = Math.sin(yaw);
  const feet = [1, -1].map((side, n) => {
    const lift = stride > 0 ? 0.07 * Math.max(0, Math.sin(Math.PI * (stride * 2 - n))) : 0;
    return new Vector3(hip.x + side * 0.1 * c, 0.08 + lift, hip.z - side * 0.1 * sn);
  }) as [Vector3, Vector3];
  return { hip, yaw, pitch: 0.04, feet, hands: hangingHands(hip, yaw), settle: 0 };
}

/**
 * Where the hand holds a door that is open by `angle` (rad), in the car's frame: its outside handle near the rear
 * edge at `handleH`, or (inside) the grip of its inner panel. door: hinge axis and rear edge as in CAR_SEATS.
 */
export function doorGrip(door: { hingeX: number; hingeU: number; rearU: number }, angle: number, inside: boolean, height: number): Vector3 {
  const s = Math.sign(door.hingeX), len = door.hingeU - door.rearU;
  const r = inside ? len * 0.6 : len - 0.14, off = inside ? -0.1 : 0.05; // along the door from the hinge; in / out of its skin
  // the door runs back from the hinge; open, its rear edge swings outwards
  const ax = s * Math.sin(angle), au = -Math.cos(angle);
  return new Vector3(door.hingeX + ax * r + s * Math.cos(angle) * off, height, door.hingeU + au * r + Math.sin(angle) * off);
}
