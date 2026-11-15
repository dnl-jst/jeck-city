/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { decodeCollision, type CollisionAsset } from '../assets/collision';
import { Character, type CharacterInput } from './character';
import { FixedStepper } from './step';
import { TUNING } from './tuning';
import { Vehicle, VEHICLE_REST_Y, type VehicleInput } from './vehicle';
import { createPhysicsWorld, EXPECTED_RAPIER, initRapier, staticWorldFilter, type PhysicsWorld } from './world';

const DT = 1 / 60;
const KMH = 3.6;

/** Mini scene: ground ±300 m at y = 0, a wall at x = 10 (10..10.5, 4 m high),
 *  a 0.12 m kerb slab from z = 5 to z = 40 (x −100..9), boundary square ±250. */
function miniScene(): CollisionAsset {
  const v: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const o = v.length / 3;
    v.push(...a, ...b, ...c, ...d);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // top
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +x
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]); // -z
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
  };
  quad([-300, 0, -300], [-300, 0, 300], [300, 0, 300], [300, 0, -300]);
  box(10, 0, -300, 10.5, 4, 300);
  box(-100, 0, 5, 9, 0.12, 40);
  return {
    vertices: new Float32Array(v),
    indices: new Uint32Array(idx),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}

const idle: CharacterInput = { forward: 0, right: 0, run: false, yaw: 0 };

function runChar(pw: PhysicsWorld, c: Character, input: CharacterInput, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    c.applyInput(input, DT);
    pw.step();
  }
}

function runCar(pw: PhysicsWorld, car: Vehicle, input: VehicleInput, seconds: number, each?: () => void) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    car.applyInput(input, DT);
    pw.step();
    each?.();
  }
}

describe('rapier', () => {
  test('the loaded Rapier is the expected version, which is the one @nn/shared depends on', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(EXPECTED_RAPIER).toBe(pkg.dependencies['@dimforge/rapier3d-compat']);
    await initRapier();
    const pw = await createPhysicsWorld(miniScene());
    expect(pw.rapier.version()).toBe(EXPECTED_RAPIER);
  });

  test('staticWorldFilter: a ray down from (0, 1, 0) hits the fixed ground, not a character standing there', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0, z: 0 });
    runChar(pw, c, idle, 0.2);
    const R = pw.rapier;
    const hit = pw.world.castRay(new R.Ray({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }), 2, true, undefined, undefined, undefined, undefined, staticWorldFilter());
    expect(hit).not.toBeNull();
    expect(hit!.timeOfImpact).toBeCloseTo(1, 3);
  });
});

describe('character', () => {
  test('spawned at y = 1 stands on the ground after 1 s', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 1, z: -20 });
    runChar(pw, c, idle, 1);
    expect(c.position().y).toBeGreaterThan(-0.05);
    expect(c.position().y).toBeLessThan(0.05);
  });

  test('walking into the wall for 5 s stays in front of it', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 5, y: 0, z: -20 });
    runChar(pw, c, { forward: 1, right: 0, run: false, yaw: Math.PI / 2 }, 5);
    expect(c.position().x).toBeLessThan(10 - 0.3);
    expect(c.position().x).toBeGreaterThan(9); // it did actually walk there
  });

  test('walking speed is 1.6 m/s, running reaches 5.5 ± 0.3 m/s', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: -50, y: 0, z: -20 });
    runChar(pw, c, { forward: 1, right: 0, run: false, yaw: Math.PI }, 1);
    expect(Math.hypot(c.velocity().x, c.velocity().z)).toBeCloseTo(1.6, 1);
    runChar(pw, c, { forward: 1, right: 0, run: true, yaw: Math.PI }, 1);
    const v = c.velocity();
    expect(Math.abs(Math.hypot(v.x, v.z) - 5.5)).toBeLessThanOrEqual(0.3);
    expect(v.z).toBeLessThan(0); // yaw π → forward = −z
  });

  test('right strafes to the right of the facing direction', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: -50, y: 0, z: -20 });
    runChar(pw, c, { forward: 0, right: 1, run: false, yaw: 0 }, 1);
    expect(c.position().x).toBeLessThan(-51); // facing south (+z), right is west (−x)
  });

  test('steps up the 0.12 m kerb', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0, z: 3 });
    runChar(pw, c, { forward: 1, right: 0, run: false, yaw: 0 }, 3);
    expect(c.position().z).toBeGreaterThan(7);
    expect(c.position().y).toBeGreaterThan(0.12 - 0.05);
    expect(c.position().y).toBeLessThan(0.12 + 0.05);
  });

  test('cannot walk through the boundary wall', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: -245, y: 0, z: -20 });
    runChar(pw, c, { forward: 1, right: 0, run: true, yaw: -Math.PI / 2 }, 3);
    expect(c.position().x).toBeGreaterThan(-250 + 0.25);
    expect(c.position().x).toBeLessThan(-248);
  });

  test('does not sink into a huge ground triangle (like the real 2.5 km ground rectangle)', async () => {
    const S = 1300;
    const pw = await createPhysicsWorld({
      vertices: new Float32Array([-S, 0, -S, -S, 0, S, S, 0, S, S, 0, -S]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      boundary: new Float32Array([-1200, -1200, 1200, -1200, 1200, 1200]),
    });
    const c = new Character(pw, { x: 132, y: 0.12, z: -17 });
    let minY = Infinity;
    for (let i = 0; i < 60; i++) {
      c.applyInput(idle, DT);
      pw.step();
      minY = Math.min(minY, c.position().y);
    }
    expect(minY).toBeGreaterThan(-0.05);
  });

  test('teleport moves the feet there at once; the character then stands and collides from there', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0, z: -20 });
    runChar(pw, c, { forward: 1, right: 0, run: true, yaw: 0 }, 0.5);
    c.teleport({ x: 0, y: 0.12, z: 20 }); // onto the kerb slab
    expect(c.position()).toEqual({ x: 0, y: expect.closeTo(0.12, 5), z: 20 });
    expect(c.velocity()).toEqual({ x: 0, y: 0, z: 0 });
    runChar(pw, c, idle, 1);
    expect(c.position().y).toBeCloseTo(0.12, 1);
    expect(c.position().z).toBeCloseTo(20, 3);
    c.teleport({ x: 8, y: 0, z: -20 }); // 2 m in front of the wall, then walk into it
    runChar(pw, c, { forward: 1, right: 0, run: false, yaw: Math.PI / 2 }, 3);
    expect(c.position().x).toBeLessThan(10 - 0.3);
    expect(c.position().x).toBeGreaterThan(9);
  });

  test('jump: rises about 0.75 m, lands again, no second jump in the air', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0, z: -20 });
    runChar(pw, c, idle, 0.5);
    c.applyInput({ ...idle, jump: true }, DT);
    pw.step();
    let top = 0;
    for (let i = 0; i < 90; i++) {
      c.applyInput({ ...idle, jump: i === 20 }, DT); // pressing again mid-air does nothing
      pw.step();
      top = Math.max(top, c.position().y);
    }
    expect(top).toBeGreaterThan(0.6);
    expect(top).toBeLessThan(0.95);
    expect(c.position().y).toBeCloseTo(0, 1); // landed after 1.5 s
  });

  test('setEnabled(false) removes it from collision queries', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const a = new Character(pw, { x: 0, y: 0, z: -20 });
    const b = new Character(pw, { x: 2, y: 0, z: -20 });
    runChar(pw, b, idle, 0.2);
    b.setEnabled(false);
    runChar(pw, a, { forward: 1, right: 0, run: false, yaw: Math.PI / 2 }, 2);
    expect(a.position().x).toBeGreaterThan(2.5); // walked straight through b's old spot
  });
});

describe('vehicle', () => {
  const full: VehicleInput = { throttle: 1, steer: 0, brake: false };

  test('an occupied car on flat ground rests on all 4 wheels after 30 steps', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: 0, heading: 0 });
    car.setOccupied(true);
    for (let i = 0; i < 30; i++) {
      car.applyInput({ throttle: 0, steer: 0, brake: false }, DT);
      pw.step();
    }
    expect(car.wheelsInContact()).toBe(4);
    expect(car.pose().y).toBeGreaterThan(VEHICLE_REST_Y - 0.05);
  });

  test('brake alone wakes a sleeping occupied car', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: 0, heading: 0 });
    car.setOccupied(true);
    car.chassis.sleep();
    expect(car.chassis.isSleeping()).toBe(true);
    car.applyInput({ throttle: 0, steer: 0, brake: true }, DT);
    expect(car.chassis.isSleeping()).toBe(false);
  });

  test('full throttle for 10 s: 50 km/h < speed ≤ 61 km/h', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: 0, heading: Math.PI }); // heading north (−z)
    car.setOccupied(true);
    runCar(pw, car, full, 10);
    expect(car.speed() * KMH).toBeGreaterThan(50);
    expect(car.speed() * KMH).toBeLessThanOrEqual(61);
    expect(car.pose().z).toBeLessThan(-50); // drove forward along its heading
  });

  test('full reverse is capped at 20 km/h', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: 0, heading: 0 });
    car.setOccupied(true);
    runCar(pw, car, { throttle: -1, steer: 0, brake: false }, 8);
    expect(car.speed() * KMH).toBeLessThan(-15);
    expect(car.speed() * KMH).toBeGreaterThanOrEqual(-21);
    expect(car.pose().z).toBeLessThan(-10);
  });

  test('steer > 0 turns right', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: -100, heading: 0 }); // facing south, right = west
    car.setOccupied(true);
    runCar(pw, car, { throttle: 0.6, steer: 1, brake: false }, 3);
    expect(car.pose().x).toBeLessThan(-152);
  });

  test('hitting the wall at 50 km/h does not pass through it', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -15, z: -100, heading: Math.PI / 2 }); // facing east, wall at x = 10
    car.setOccupied(true);
    runCar(pw, car, full, 0.1);
    car.chassis.setLinvel({ x: 50 / KMH, y: 0, z: 0 }, true);
    let maxX = -Infinity;
    runCar(pw, car, full, 4, () => (maxX = Math.max(maxX, car.pose().x)));
    expect(maxX).toBeLessThan(10);
    expect(car.pose().x).toBeLessThan(10 - 1.5); // nose against the wall, not inside it
  });

  test('drives over the 0.12 m kerb without getting stuck', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -30, z: -10, heading: 0 }); // facing south toward the kerb at z = 5
    car.setOccupied(true);
    runCar(pw, car, { throttle: 0.5, steer: 0, brake: false }, 6);
    expect(car.pose().z).toBeGreaterThan(15);
    expect(car.speed()).toBeGreaterThan(2);
  });

  test('stays upright through a full-lock turn at speed', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: -150, z: 0, heading: Math.PI });
    car.setOccupied(true);
    runCar(pw, car, full, 6);
    runCar(pw, car, { throttle: 1, steer: 1, brake: false }, 4);
    const p = car.pose();
    const upY = 1 - 2 * (p.qx * p.qx + p.qz * p.qz); // y component of the chassis' local up
    expect(upY).toBeGreaterThan(0.9);
  });

  test('a parked car starts asleep and, when hit, is pushed on its wheels', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const parked = new Vehicle(pw, { x: -100, z: -100, heading: Math.PI / 2 });
    runCar(pw, parked, { throttle: 0, steer: 0, brake: false }, 0.5);
    expect(parked.chassis.isSleeping()).toBe(true);
    const y0 = parked.pose().y;
    const car = new Vehicle(pw, { x: -100, z: -112, heading: 0 }); // 12 m north, driving south into it
    car.setOccupied(true);
    runCar(pw, car, full, 3);
    expect(parked.pose().z).toBeGreaterThan(-99.5); // pushed
    expect(Math.abs(parked.pose().y - y0)).toBeLessThan(0.3); // still on its wheels
    parked.dispose();
    car.dispose();
    pw.step();
  });
});

test('FixedStepper.advance(2.0) runs exactly 5 steps', () => {
  const s = new FixedStepper();
  let n = 0;
  expect(s.advance(2.0, () => n++)).toBe(5);
  expect(n).toBe(5);
  expect(s.advance(1 / 60, () => n++)).toBe(1); // backlog was dropped, not carried
});

test('FixedStepper.alpha is the leftover fraction of a step (render interpolation)', () => {
  const s = new FixedStepper(1 / 60, 5);
  expect(s.alpha).toBe(0);
  s.advance(1 / 120, () => {});
  expect(s.alpha).toBeCloseTo(0.5);
  s.advance(1 / 60, () => {});
  expect(s.alpha).toBeCloseTo(0.5);
  s.advance(1, () => {}); // backlog dropped
  expect(s.alpha).toBe(0);
});

test('FixedStepper accumulates partial frames', () => {
  const s = new FixedStepper(1 / 60, 5);
  let n = 0;
  for (let i = 0; i < 120; i++) s.advance(1 / 120, () => n++);
  expect(n).toBe(60);
});

test('same inputs give bit-identical results in two worlds', async () => {
  const run = async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0.5, z: 0 });
    const car = new Vehicle(pw, { x: -60, z: -60, heading: 0.3 });
    car.setOccupied(true);
    for (let i = 0; i < 240; i++) {
      c.applyInput({ forward: 1, right: 0.3, run: i > 60, yaw: i * 0.01 }, DT);
      car.applyInput({ throttle: 1, steer: Math.sin(i * 0.05), brake: i > 200 }, DT);
      pw.step();
    }
    return [c.position(), car.pose()];
  };
  expect(await run()).toEqual(await run());
});

test('tuning holds the brief values', () => {
  expect(TUNING.character).toMatchObject({ radius: 0.3, height: 1.8, walkSpeed: 1.6, runSpeed: 5.5, gravity: -20, jumpSpeed: 5.5 });
  expect(TUNING.vehicle).toMatchObject({ mass: 1200, maxForwardKmh: 60, maxReverseKmh: 20 });
});

const COLLISION_BIN = fileURLToPath(new URL('../../../../apps/client/public/world/collision.bin', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../../../apps/client/public/world/manifest.json', import.meta.url));
const haveReal = existsSync(COLLISION_BIN) && existsSync(MANIFEST);

test.skipIf(!haveReal)(
  haveReal ? 'real collision.bin: world < 3 s, character at spawn stands on the sidewalk (y ≈ 0.12)' : 'real collision.bin smoke test [SKIPPED: apps/client/public/world/collision.bin not found — run the pipeline]',
  async () => {
    const file = readFileSync(COLLISION_BIN);
    const asset = decodeCollision(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const spawn = JSON.parse(readFileSync(MANIFEST, 'utf8')).spawn as { x: number; y: number; z: number };
    const t0 = performance.now();
    const pw = await createPhysicsWorld(asset);
    expect(performance.now() - t0).toBeLessThan(3000);
    const c = new Character(pw, spawn);
    runChar(pw, c, idle, 1);
    expect(Math.abs(c.position().y - 0.12)).toBeLessThanOrEqual(0.03);
  },
  15_000,
);
