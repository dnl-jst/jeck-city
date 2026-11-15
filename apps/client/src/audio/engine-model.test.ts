import { expect, test } from "vitest";
import { engineMix, engineTarget, smoothRpm } from "./engine-model";

test("idle at standstill", () => {
  expect(engineTarget(0, 0)).toEqual({ gear: 0, rpm: 800 });
});

test("revving in place", () => {
  expect(engineTarget(0, 1).rpm).toBe(1800);
});

test("city speed sounds relaxed", () => {
  const t = engineTarget(50, 1);
  expect(t.gear).toBe(3);
  expect(t.rpm).toBeGreaterThanOrEqual(1500);
  expect(t.rpm).toBeLessThan(2200);
  expect(engineTarget(45, 1).rpm).toBeGreaterThan(2500);
  expect(engineTarget(45, 1).rpm).toBeLessThan(3200);
});

test("top speed rpm", () => {
  expect(Math.abs(engineTarget(60, 1).rpm - 3200)).toBeLessThanOrEqual(1);
});

test("shift drop", () => {
  expect(engineTarget(19, 1).rpm).toBeGreaterThan(2700);
  const after = engineTarget(21, 1);
  expect(after.gear).toBe(1);
  expect(after.rpm).toBeLessThan(1700);
});

test("never above 3200 under 60 km/h", () => {
  for (let k = 0; k <= 60; k += 0.5)
    expect(engineTarget(k, 1).rpm).toBeLessThanOrEqual(3200);
});

test("smoothRpm converges", () => {
  let rpm = 800;
  for (let i = 0; i < 120; i++) {
    rpm = smoothRpm(rpm, 5000, 1 / 60);
    expect(rpm).toBeLessThanOrEqual(5000);
  }
  expect(rpm).toBeGreaterThan(4900);
});

test("single loop mix", () => {
  expect(engineMix(1600, [{ rpm: 800 }])).toEqual([{ gain: 1, rate: 2 }]);
});

test("crossfade halfway", () => {
  const m = engineMix(1900, [{ rpm: 800 }, { rpm: 3000 }]);
  expect(m[0]!.gain).toBeCloseTo(0.7071, 3);
  expect(m[1]!.gain).toBeCloseTo(0.7071, 3);
  expect(m[0]!.gain ** 2 + m[1]!.gain ** 2).toBeCloseTo(1, 6);
});

test("clamps rate", () => {
  expect(engineMix(6000, [{ rpm: 800 }])[0]!.rate).toBe(2);
});
