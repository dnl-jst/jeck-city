import {
  approachPoint, BOARD_WALK_SPEED, CAR_SEATS, CAR_SPECS, fromCarPoint, headingOf, standPoint, VEHICLE_REST_Y, type CarPose, type CarType, type DoorName,
} from '@nn/shared';
import { Vector3, type Object3D } from 'three';
import { boardPose, doorGrip, footTargets, SEAT_RECLINE, standPose, type BoardStage } from './boarding';
import { thighRest, type PlayerFigure } from './player';

/** What seating a figure needs of a drawn car (DrivenCar). */
export interface SeatedIn {
  /** The model's root (its frame: x left, y up, z forward, origin on the ground), or null without a model. */
  readonly root: Object3D | null;
  seat(i: number): Vector3 | null;
  grips(): [Vector3, Vector3] | null;
  setDoor(name: DoorName, k: number): void;
}

/** How far (0..1) a hand has gone to something at progress k: there from `on`, away again from `off`. */
const reach = (k: number, on: number, off: number): number => {
  const up = Math.max(0, Math.min(1, k / on)), down = Math.max(0, Math.min(1, (1 - k) / (1 - off)));
  const m = Math.min(up, down);
  return m * m * (3 - 2 * m);
};

/**
 * Poses the figure of whoever has seat `seat` of a car of `type` for this frame: sitting (st null), or on its way in
 * or out (st: the stage of getting in or out; the seat's door follows it). `pose`: the car as drawn; `scene`: where
 * the figure walks while it is still on its way to the door. The driver's hands hold the wheel.
 */
export function poseOccupant(
  fig: PlayerFigure, scene: Object3D, view: SeatedIn, type: CarType, seat: number, pose: CarPose, st: BoardStage | null, dt: number,
): void {
  const layout = CAR_SEATS[type], at = layout.seats[seat];
  if (!at) return;
  const door = layout.doors[at.door]!;
  if (st) view.setDoor(at.door, st.door);
  if (st?.walk) {
    // on foot, on the way to the door
    if (fig.group.parent !== scene) scene.add(fig.group);
    const frame = { x: pose.x, z: pose.z, heading: headingOf(pose) }, w = fromCarPoint(frame, st.walk);
    const ahead = fromCarPoint({ x: 0, z: 0, heading: frame.heading }, st.heading ?? { x: 0, u: 1 });
    fig.update(w.x, pose.y - VEHICLE_REST_Y, w.z, { x: ahead.x * BOARD_WALK_SPEED, y: 0, z: ahead.z * BOARD_WALK_SPEED }, dt, false, Math.atan2(ahead.x, ahead.z));
    return;
  }
  const root = view.root;
  if (!root) return;
  if (fig.group.parent !== root) root.add(fig.group);
  const hip = view.seat(seat) ?? new Vector3(at.x, at.h, at.u);
  const feet = footTargets(at, layout.floor), grips = seat === 0 ? view.grips() : null;
  if (!st || !st.phase) {
    fig.sit(hip, feet, grips, SEAT_RECLINE);
    return;
  }
  const s = Math.sign(door.hingeX), angle = st.door * door.openAngle;
  const from = approachPoint(layout, seat), stand = standPoint(layout, seat);
  // standing behind the door's rear edge, looking along the car; in the open door, turned to the car
  const yawAt = -s * 0.25, yawIn = -s * 1.45;
  const near = s > 0 ? 1 : 0; // standing there, the hand next to the car
  if (st.phase === 'handle') {
    // the hand next to the car takes the outside handle and goes with it as the door swings (letting go near the end)
    const b = standPose(from, yawAt, fig.hipHeight);
    b.hands[near]!.lerp(doorGrip(door, angle, false, door.handleH), reach(st.k, 0.25, 0.85));
    fig.pose(b.hip, b.yaw, b.pitch, b.feet, b.hands, 0, 0.6);
    return;
  }
  if (st.phase === 'step') {
    // round the open door into the opening
    const k = st.k * st.k * (3 - 2 * st.k);
    const b = standPose({ x: from.x + (stand.x - from.x) * k, u: from.u + (stand.u - from.u) * k }, yawAt + (yawIn - yawAt) * k, fig.hipHeight, st.k);
    fig.pose(b.hip, b.yaw, b.pitch, b.feet, b.hands, 0, 0.2);
    return;
  }
  const rest = grips ?? thighRest(hip);
  if (st.phase === 'sit') {
    // stepping in, sitting down, the trailing leg (boardPose); the hands leave the body's sides as the back settles
    const b = boardPose(st.k, at, layout.floor, stand, fig.hipHeight, SEAT_RECLINE, CAR_SPECS[type].height);
    const hands = b.hands.map((h, i) => h.lerp(rest[i]!, b.settle)) as [Vector3, Vector3];
    fig.pose(b.hip, b.yaw, b.pitch, b.feet, hands, 0, 0.2 + 0.8 * b.settle * (grips ? 1 : 0));
    return;
  }
  // 'shut': seated, the hand on the door's side takes the grip of its inner panel and pulls it shut
  const hands = [rest[0].clone(), rest[1].clone()] as [Vector3, Vector3];
  hands[1 - near]!.lerp(doorGrip(door, angle, true, at.h + 0.28), reach(st.k, 0.2, 0.75));
  const across = hands[0].clone().sub(hands[1]);
  fig.pose(hip, 0, -SEAT_RECLINE, feet, hands, grips ? Math.atan2(across.y, across.x) * (1 - reach(st.k, 0.2, 0.75)) : 0, grips ? 1 : 0.4);
}

/** Shuts every door of a car of `type` on `view`. */
export function shutDoors(view: SeatedIn, type: CarType): void {
  for (const name of Object.keys(CAR_SEATS[type].doors)) view.setDoor(name as DoorName, 0);
}
