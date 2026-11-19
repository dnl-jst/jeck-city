import type { CarType } from './cartypes';

export type DoorName = 'door_fl' | 'door_fr' | 'door_rl' | 'door_rr';
/** Car frame as the models': x to the left, u ahead of the axle midpoint, h above the ground (m). The hip point. */
export type CarSeat = { x: number; u: number; h: number; door: DoorName };
/** A front-hinged door: its hinge axis (vertical, at hingeX / hingeU), its rear edge and how far it swings open (rad). */
export type CarDoor = { hingeX: number; hingeU: number; rearU: number; openAngle: number };
export type SeatLayout = { seats: CarSeat[]; doors: Partial<Record<DoorName, CarDoor>> };

/**
 * Seats and doors per car type; the models carry the same points as nodes (seat_<n>, door_*; data/models/cars).
 * Seat 0 is the driver. Types without an entry still use the old one-driver model.
 */
export const CAR_SEATS: Partial<Record<CarType, SeatLayout>> = {
  kleinwagen: {
    seats: [
      { x: 0.37, u: 0.05, h: 0.5, door: 'door_fl' },
      { x: -0.37, u: 0.05, h: 0.5, door: 'door_fr' },
      { x: 0.36, u: -0.78, h: 0.53, door: 'door_rl' },
      { x: -0.36, u: -0.78, h: 0.53, door: 'door_rr' },
    ],
    doors: {
      door_fl: { hingeX: 0.86, hingeU: 1.05, rearU: -0.11, openAngle: 1.13 },
      door_fr: { hingeX: -0.86, hingeU: 1.05, rearU: -0.11, openAngle: 1.13 },
      door_rl: { hingeX: 0.87, hingeU: -0.11, rearU: -1.33, openAngle: 1.13 },
      door_rr: { hingeX: -0.87, hingeU: -0.11, rearU: -1.33, openAngle: 1.13 },
    },
  },
};
