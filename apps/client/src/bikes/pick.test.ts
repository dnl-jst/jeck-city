import { expect, test } from 'vitest';
import { pickVehicle } from './pick';

// player at the origin facing +z (heading 0)
test('the vehicle the player faces wins over a slightly nearer one behind', () => {
  expect(pickVehicle({ x: 0, z: 0 }, 0, { x: 0.5, z: 2.3 }, { x: 0, z: -2.2 })).toBe('car');
  expect(pickVehicle({ x: 0, z: 0 }, Math.PI, { x: 0.5, z: 2.3 }, { x: 0, z: -2.2 })).toBe('bike');
});
test('same direction: the nearer one; only one: that one; none: null', () => {
  expect(pickVehicle({ x: 0, z: 0 }, 0, { x: 0, z: 2.5 }, { x: 0.2, z: 1.2 })).toBe('bike');
  expect(pickVehicle({ x: 0, z: 0 }, 0, null, { x: 0, z: -2 })).toBe('bike');
  expect(pickVehicle({ x: 0, z: 0 }, 0, { x: 0, z: -2 }, null)).toBe('car');
  expect(pickVehicle({ x: 0, z: 0 }, 0, null, null)).toBeNull();
});
