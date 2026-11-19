import {
  BOARD_WALK_SPEED, CAR_SEATS, CAR_SPECS, fromCarPoint, headingOf, standPoint, VEHICLE_REST_Y, type CarPose, type CarType, type DoorName,
} from '@nn/shared';
import { Vector3, type Object3D } from 'three';
import { boardPose, footTargets, SEAT_RECLINE, type BoardStage } from './boarding';
import { thighRest, type PlayerFigure } from './player';

/** What seating a figure needs of a drawn car (DrivenCar). */
export interface SeatedIn {
  /** The model's root (its frame: x left, y up, z forward, origin on the ground), or null without a model. */
  readonly root: Object3D | null;
  seat(i: number): Vector3 | null;
  grips(): [Vector3, Vector3] | null;
  setDoor(name: DoorName, k: number): void;
}

/**
 * Poses the figure of whoever has seat `seat` of a car of `type` for this frame: sitting (st null), or on its way in
 * or out (st: the stage of getting in or out; the seat's door follows it). `pose`: the car as drawn; `scene`: where
 * the figure stands while it is still on foot. The driver's hands hold the wheel.
 */
export function poseOccupant(
  fig: PlayerFigure, scene: Object3D, view: SeatedIn, type: CarType, seat: number, pose: CarPose, st: BoardStage | null, dt: number,
): void {
  const layout = CAR_SEATS[type], at = layout.seats[seat];
  if (!at) return;
  const frame = { x: pose.x, z: pose.z, heading: headingOf(pose) }, ground = pose.y - VEHICLE_REST_Y;
  if (st) view.setDoor(at.door, st.door);
  if (st && (st.walk || st.slide === 0)) {
    // on foot: walking the path, or standing at the open door, turned to the car
    if (fig.group.parent !== scene) scene.add(fig.group);
    const p = st.walk ?? standPoint(layout, seat), w = fromCarPoint(frame, p);
    const dir = st.heading ?? { x: -Math.sign(p.x), u: 0 };
    const ahead = fromCarPoint({ x: 0, z: 0, heading: frame.heading }, dir);
    const speed = st.walk ? BOARD_WALK_SPEED : 0;
    fig.update(w.x, ground, w.z, { x: ahead.x * speed, y: 0, z: ahead.z * speed }, dt, false, Math.atan2(ahead.x, ahead.z));
    return;
  }
  const root = view.root;
  if (!root) return;
  if (fig.group.parent !== root) root.add(fig.group);
  const hip = view.seat(seat) ?? new Vector3(at.x, at.h, at.u);
  const feet = footTargets(at, layout.floor), grips = seat === 0 ? view.grips() : null;
  if (!st || st.slide >= 1) {
    fig.sit(hip, feet, grips, SEAT_RECLINE);
    return;
  }
  // between the door and the seat: stepping in, sitting down, the trailing leg (boardPose); the hands leave the
  // body's sides for the wheel (or the thighs) as the back settles
  const b = boardPose(st.slide, at, layout.floor, standPoint(layout, seat), fig.hipHeight, SEAT_RECLINE, CAR_SPECS[type].height);
  const rest = grips ?? thighRest(hip);
  const hands = b.hands.map((h, i) => h.lerp(rest[i]!, b.settle)) as [Vector3, Vector3];
  fig.pose(b.hip, b.yaw, b.pitch, b.feet, hands, 0, 0.2 + 0.8 * b.settle * (grips ? 1 : 0));
}

/** Shuts every door of a car of `type` on `view`. */
export function shutDoors(view: SeatedIn, type: CarType): void {
  for (const name of Object.keys(CAR_SEATS[type].doors)) view.setDoor(name as DoorName, 0);
}
