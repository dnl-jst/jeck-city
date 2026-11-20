import type { CarType } from './cartypes';

export type DoorName = 'door_fl' | 'door_fr' | 'door_rl' | 'door_rr';
/** Car frame as the models': x to the left, u ahead of the axle midpoint, h above the ground (m). The hip point. */
export type CarSeat = { x: number; u: number; h: number; door: DoorName };
/** A front-hinged door: its hinge axis (vertical, at hingeX / hingeU), its rear edge and how far it swings open (rad). */
export type CarDoor = { hingeX: number; hingeU: number; rearU: number; openAngle: number; /** Height of the outside handle above the ground. */ handleH: number };
/** floor: height of the cabin floor above the ground (where the feet rest). */
export type SeatLayout = { seats: CarSeat[]; doors: Partial<Record<DoorName, CarDoor>>; floor: number };

/**
 * Seats and doors per car type; the models carry the same points as nodes (seat_<n>, door_*; data/models/cars).
 * Seat 0 is the driver.
 */
export const CAR_SEATS: Record<CarType, SeatLayout> = {
  kleinwagen: {
    floor: 0.22,
    seats: [
      { x: 0.37, u: 0.05, h: 0.5, door: 'door_fl' },
      { x: -0.37, u: 0.05, h: 0.5, door: 'door_fr' },
      { x: 0.36, u: -0.78, h: 0.53, door: 'door_rl' },
      { x: -0.36, u: -0.78, h: 0.53, door: 'door_rr' },
    ],
    doors: {
      door_fl: { hingeX: 0.86, hingeU: 0.9, rearU: -0.2, openAngle: 1.13, handleH: 0.89 },
      door_fr: { hingeX: -0.86, hingeU: 0.9, rearU: -0.2, openAngle: 1.13, handleH: 0.89 },
      door_rl: { hingeX: 0.87, hingeU: -0.2, rearU: -1.08, openAngle: 1.13, handleH: 0.89 },
      door_rr: { hingeX: -0.87, hingeU: -0.2, rearU: -1.08, openAngle: 1.13, handleH: 0.89 },
    },
  },
  mittelklasse: {
    floor: 0.2,
    seats: [
      { x: 0.38, u: 0.09, h: 0.47, door: 'door_fl' },
      { x: -0.38, u: 0.09, h: 0.47, door: 'door_fr' },
      { x: 0.37, u: -0.74, h: 0.5, door: 'door_rl' },
      { x: -0.37, u: -0.74, h: 0.5, door: 'door_rr' },
    ],
    doors: {
      door_fl: { hingeX: 0.9, hingeU: 0.95, rearU: -0.15, openAngle: 1.13, handleH: 0.86 },
      door_fr: { hingeX: -0.9, hingeU: 0.95, rearU: -0.15, openAngle: 1.13, handleH: 0.86 },
      door_rl: { hingeX: 0.905, hingeU: -0.15, rearU: -1.03, openAngle: 1.13, handleH: 0.86 },
      door_rr: { hingeX: -0.905, hingeU: -0.15, rearU: -1.03, openAngle: 1.13, handleH: 0.86 },
    },
  },
  // driver and the outer place of the double bench; the load space is not entered
  transporter: {
    floor: 0.56,
    seats: [
      { x: 0.47, u: 0.55, h: 1, door: 'door_fl' },
      { x: -0.5, u: 0.55, h: 1, door: 'door_fr' },
    ],
    doors: {
      door_fl: { hingeX: 0.94, hingeU: 1.31, rearU: 0.03, openAngle: 1.13, handleH: 1.16 },
      door_fr: { hingeX: -0.94, hingeU: 1.31, rearU: 0.03, openAngle: 1.13, handleH: 1.16 },
    },
  },
  smart: {
    floor: 0.3,
    seats: [
      { x: 0.33, u: -0.2, h: 0.62, door: 'door_fl' },
      { x: -0.33, u: -0.2, h: 0.62, door: 'door_fr' },
    ],
    doors: {
      door_fl: { hingeX: 0.765, hingeU: 1, rearU: -0.4, openAngle: 1.13, handleH: 0.86 },
      door_fr: { hingeX: -0.765, hingeU: 1, rearU: -0.4, openAngle: 1.13, handleH: 0.86 },
    },
  },
  // pilot and the seat beside them
  heli: {
    floor: 0.5,
    seats: [
      { x: 0.4, u: 0.5, h: 0.85, door: 'door_fl' },
      { x: -0.4, u: 0.5, h: 0.85, door: 'door_fr' },
    ],
    doors: {
      door_fl: { hingeX: 0.84, hingeU: 1.3, rearU: 0.1, openAngle: 1.13, handleH: 1.15 },
      door_fr: { hingeX: -0.84, hingeU: 1.3, rearU: 0.1, openAngle: 1.13, handleH: 1.15 },
    },
  },
};
