import { expect, test } from 'vitest';
import { CAR_SPECS, CAR_TYPE_WEIGHTS, CAR_TYPES, carTypeFor, carTypeOf } from './cartypes';
import { chassisLayout, SUSPENSION_REST_LENGTH, VEHICLE_REST_Y } from './vehicle';

test('carTypeFor splits [0, 1) by the weights; carTypeOf defaults to kleinwagen', () => {
  expect(CAR_TYPE_WEIGHTS.reduce((a: number, b) => a + b, 0)).toBeCloseTo(1);
  expect(carTypeFor(0)).toBe(0);
  expect(CAR_TYPES[carTypeFor(0.999)]).toBe('smart'); // never the helicopter (weight 0)
  expect(CAR_TYPES[carTypeFor(1)]).toBe('smart');
  expect(carTypeOf(undefined)).toBe('kleinwagen');
  expect(carTypeOf(2)).toBe('transporter');
});

test('chassisLayout: every type rests at VEHICLE_REST_Y, collider from 0.22 m to the roof', () => {
  for (const t of CAR_TYPES) {
    const s = CAR_SPECS[t];
    const l = chassisLayout(s);
    // wheel centre at rest = mount − loaded suspension length; its bottom touches the ground
    expect(VEHICLE_REST_Y + l.wheels[0]!.y - SUSPENSION_REST_LENGTH - s.wheelRadius).toBeCloseTo(0, 6);
    expect(VEHICLE_REST_Y + l.centre.y - l.half.y).toBeCloseTo(0.22);
    expect(VEHICLE_REST_Y + l.centre.y + l.half.y).toBeCloseTo(s.height);
    expect(l.wheels.map((w) => Math.sign(w.x))).toEqual([-1, 1, -1, 1]);
  }
});
