import { expect, test } from 'vitest';
import { RadioTuner, stationLabel } from './stations';

test('first entry plays Köllefornia', () => {
  expect(new RadioTuner().enterCar()).toBe('koellefornia');
});

test('R cycles through all stations and off', () => {
  const t = new RadioTuner();
  t.enterCar();
  expect([t.next(), t.next(), t.next(), t.next()]).toEqual(['radiokoeln', 'einslive', null, 'koellefornia']);
});

test('wheel back from Köllefornia is off', () => {
  const t = new RadioTuner();
  t.enterCar();
  expect(t.prev()).toBeNull();
  expect(t.prev()).toBe('einslive');
});

test('remembers last choice across cars, including off', () => {
  const a = new RadioTuner();
  a.enterCar();
  a.next();
  a.exitCar();
  expect(a.enterCar()).toBe('radiokoeln');
  const b = new RadioTuner();
  b.enterCar();
  b.prev();
  b.exitCar();
  expect(b.enterCar()).toBeNull();
});

test('input while walking changes nothing', () => {
  const t = new RadioTuner();
  expect(t.next()).toBe('koellefornia');
  expect(t.prev()).toBe('koellefornia');
  expect(t.current).toBe('koellefornia');
  t.enterCar();
  t.next();
  t.exitCar();
  expect(t.next()).toBe('radiokoeln');
  expect(t.current).toBe('radiokoeln');
});

test('labels', () => {
  expect(stationLabel('einslive')).toBe('1LIVE');
  expect(stationLabel(null)).toBe('Radio aus');
});
