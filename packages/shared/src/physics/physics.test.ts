/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { decodeCollision, type CollisionAsset } from '../assets/collision';
import { decodeTerrain, heightAt, type TerrainGrid } from '../assets/terrain';
import { Character, type CharacterInput } from './character';
import { FixedStepper } from './step';
import { TUNING } from './tuning';
import { Vehicle, VEHICLE_REST_Y, type VehicleInput } from './vehicle';
import { createPhysicsWorld, EXPECTED_RAPIER, initRapier, staticWorldFilter, type PhysicsWorld } from './world';

const DT = 1 / 60;
const KMH = 3.6;

/** Mini scene: ground ±300 m at y = 0, a wall at x = 10 (10..10.5, 4 m high),
 *  a 0.12 m kerb slab from z = 5 to z = 40 (x −100..9), a 1.4 m block (x 196..200, z 196..199),
 *  boundary square ±250. */
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
  box(196, 0, 196, 200, 1.4, 199);
  return {
    vertices: new Float32Array(v),
    indices: new Uint32Array(idx),
    boundary: new Float32Array([-250, -250, 250, -250, 250, 250, -250, 250]),
  };
}

const idle: CharacterInput = { forward: 0, right: 0, run: false, yaw: 0 };

function runChar(pw: PhysicsWorld, c: Character, input: CharacterInput, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    c.applyInput(input);
    pw.step();
  }
}

function runCar(pw: PhysicsWorld, car: Vehicle, input: VehicleInput, seconds: number, each?: () => void) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    car.applyInput(input);
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

  test('a step does not rescan every body and collider handle (rapier.js soft-body remap), and the wrappers stay valid', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const R = pw.rapier, w = pw.world;
    const scans = vi.spyOn(w.colliders, 'unmapRemovedColliders');
    const box = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 2, 0));
    const c = w.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5), box);
    const free = w.createCollider(R.ColliderDesc.ball(0.2).setTranslation(3, 0.2, 3));
    for (let i = 0; i < 60; i++) pw.step();
    expect(scans).not.toHaveBeenCalled();
    expect(box.translation().y).toBeCloseTo(0.5, 1);
    expect(w.getCollider(c.handle)).toBe(c);
    expect(w.getRigidBody(box.handle)).toBe(box);
    w.removeCollider(free, false);
    pw.step();
    expect(w.getCollider(free.handle)).toBeFalsy();
    w.removeRigidBody(box);
    pw.step();
    expect(w.getRigidBody(box.handle)).toBeFalsy();
    expect(w.getCollider(c.handle)).toBeFalsy();
  });
});

/** Grid with heights f(x, z) at the sample points (x0 + c, z0 + r). */
function grid(x0: number, z0: number, cols: number, rows: number, f: (x: number, z: number) => number): TerrainGrid {
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = f(x0 + c, z0 + r);
  return { x0, z0, cols, rows, datum: 0, heights };
}

/** City asset with no trimesh at all (the heightfield is the only ground) and the given boundary ring. */
function noCity(boundary: number[] = []): CollisionAsset {
  return { vertices: new Float32Array(0), indices: new Uint32Array(0), boundary: new Float32Array(boundary) };
}

describe('terrain', () => {
  test('heightfield matches heightAt (pins TERRAIN_DIAGONAL)', async () => {
    // Off-centre origin so a wrong collider translation shows up, and a hill so both diagonals give different heights.
    const t = grid(-7.5, 13, 21, 17, (x, z) => 3 * Math.sin(x / 4) * Math.cos(z / 5)); // non-square: catches swapped rows/cols
    const pw = await createPhysicsWorld(noCity(), t);
    const R = pw.rapier;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pts: [number, number][] = [];
    for (let i = 0; i < 200; i++) {
      const c = Math.floor(rnd() * (t.cols - 1)), r = Math.floor(rnd() * (t.rows - 1));
      let fx = rnd(), fz = rnd();
      if (i % 4 === 1) fz = Math.min(1, Math.max(0, fx + (rnd() < 0.5 ? -0.02 : 0.02))); // near the x0z0-x1z1 diagonal
      if (i % 4 === 2) fz = Math.min(1, Math.max(0, 1 - fx + (rnd() < 0.5 ? -0.02 : 0.02))); // near the x1z0-x0z1 diagonal
      pts.push([t.x0 + c + fx, t.z0 + r + fz]);
    }
    const bad: string[] = [];
    for (const [x, z] of pts) {
      const hit = pw.world.castRay(new R.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
      const y = hit ? 50 - hit.timeOfImpact : NaN;
      if (!(Math.abs(y - heightAt(t, x, z)) <= 1e-3)) bad.push(`(${x.toFixed(3)}, ${z.toFixed(3)}): ray ${y}, heightAt ${heightAt(t, x, z)}`);
    }
    expect(bad).toEqual([]);
  });

  test('character stands still on a 5 % heightfield slope', async () => {
    const t = grid(0, 0, 200, 200, (x) => 0.05 * x);
    const pw = await createPhysicsWorld(noCity(), t);
    const c = new Character(pw, { x: 50, y: heightAt(t, 50, 50) + 1, z: 50 });
    runChar(pw, c, idle, 2); // 120 steps
    const p = c.position();
    expect(Math.abs(p.y - heightAt(t, p.x, p.z))).toBeLessThanOrEqual(0.03);
    expect(Math.hypot(p.x - 50, p.z - 50)).toBeLessThan(0.05);
  });

  test('car climbs a gentle ramp (3 m over 150 m) without sinking into it', async () => {
    const ramp = (x: number) => {
      const s = Math.min(1, Math.max(0, (x - 50) / 150));
      return 3 * s * s * (3 - 2 * s); // smoothstep: no kinks at either end
    };
    const t = grid(0, -20, 300, 41, (x) => ramp(x));
    const pw = await createPhysicsWorld(noCity(), t);
    const car = new Vehicle(pw, { x: 50, z: 0, heading: Math.PI / 2, y: heightAt(t, 50, 0) }); // facing east, up the ramp
    car.setOccupied(true);
    let minClearance = Infinity;
    runCar(pw, car, { throttle: 1, steer: 0, brake: false }, 15, () => {
      const p = car.pose();
      minClearance = Math.min(minClearance, p.y - VEHICLE_REST_Y - heightAt(t, p.x, p.z));
    });
    expect(car.pose().x).toBeGreaterThan(200); // over the top
    expect(minClearance).toBeGreaterThan(-0.3);
  });

  test('kerb trimesh on top of a flat heightfield at h = 2: character steps up, car drives over', async () => {
    const t = grid(-120, -60, 241, 121, () => 2);
    const v: number[] = [];
    const idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const o = v.length / 3;
      v.push(...a, ...b, ...c, ...d);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
    };
    const [x0, y0, z0, x1, y1, z1] = [-100, 2, 5, 9, 2.12, 40]; // miniScene's kerb slab, lifted by 2 m (no bottom face)
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    const asset = { vertices: new Float32Array(v), indices: new Uint32Array(idx), boundary: new Float32Array([-110, -50, 110, -50, 110, 50, -110, 50]) };

    const pw = await createPhysicsWorld(asset, t);
    const c = new Character(pw, { x: 0, y: 2, z: 3 });
    runChar(pw, c, { forward: 1, right: 0, run: false, yaw: 0 }, 3);
    expect(c.position().z).toBeGreaterThan(7);
    expect(c.position().y).toBeGreaterThan(2.12 - 0.05);
    expect(c.position().y).toBeLessThan(2.12 + 0.05);

    const car = new Vehicle(pw, { x: -30, z: -10, heading: 0, y: 2 }); // facing south toward the kerb at z = 5
    car.setOccupied(true);
    runCar(pw, car, { throttle: 0.5, steer: 0, brake: false }, 6);
    expect(car.pose().z).toBeGreaterThan(15);
    expect(car.speed()).toBeGreaterThan(2);
  });

  test('boundary walls follow the terrain: at the high end (10 m up) they still stop the character', async () => {
    // Rises 10 m from x = −20 to x = 20; the boundary square ±40 has its east wall on the high plateau.
    const t = grid(-60, -60, 121, 121, (x) => 10 * Math.min(1, Math.max(0, (x + 20) / 40)));
    const pw = await createPhysicsWorld(noCity([-40, -40, 40, -40, 40, 40, -40, 40]), t);
    const c = new Character(pw, { x: 35, y: 10, z: 0 });
    runChar(pw, c, { forward: 1, right: 0, run: true, yaw: Math.PI / 2 }, 3); // east
    expect(c.position().x).toBeLessThan(40 - 0.25);
    expect(c.position().x).toBeGreaterThan(38); // it did run there
    expect(c.position().y).toBeCloseTo(10, 1);
  });
});

describe('collision mesh', () => {
  test('degenerate triangles (coincident or collinear corners) are dropped from the city trimesh', async () => {
    const pw = await createPhysicsWorld({
      vertices: new Float32Array([
        -5, 0, -5, -5, 0, 5, 5, 0, 5, // a real triangle (small enough not to be subdivided)
        1, 0, 1, 1, 0, 1, 2, 0, 3, // two coincident corners (distinct indices)
        3, 0, 3, 4, 0, 4, 5, 0, 5, // three collinear corners: zero area
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      boundary: new Float32Array([-40, -40, 40, -40, 40, 40]),
    });
    const tris: number[] = [];
    pw.world.forEachCollider((c) => {
      if (c.shape.type === pw.rapier.ShapeType.TriMesh) tris.push(c.indices()!.length / 3);
    });
    expect(tris).toEqual([1]);
  });
});

describe('character', () => {
  test('dispose removes its body, collider and controller from the world', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const bodies = pw.world.bodies.len(), colliders = pw.world.colliders.len();
    const c = new Character(pw, { x: 0, y: 0, z: -20 });
    expect(pw.world.bodies.len()).toBe(bodies + 1);
    expect(pw.world.colliders.len()).toBe(colliders + 1);
    c.dispose();
    expect(pw.world.bodies.len()).toBe(bodies);
    expect(pw.world.colliders.len()).toBe(colliders);
    pw.step(); // the world is still consistent
  });

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
      c.applyInput(idle);
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

  test('jump: rises about 1 m, lands again, no second jump in the air', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 0, y: 0, z: -20 });
    runChar(pw, c, idle, 0.5);
    c.applyInput({ ...idle, jump: true });
    pw.step();
    let top = 0;
    for (let i = 0; i < 90; i++) {
      c.applyInput({ ...idle, jump: i === 20 }); // pressing again mid-air does nothing
      pw.step();
      top = Math.max(top, c.position().y);
    }
    expect(top).toBeGreaterThan(0.9);
    expect(top).toBeLessThan(1.2);
    expect(c.position().y).toBeCloseTo(0, 1); // landed after 1.5 s
  });

  test('jumping while running at a 1.4 m block climbs onto it; at a 4 m wall it is a plain jump', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const c = new Character(pw, { x: 198, y: 0, z: 192 });
    runChar(pw, c, idle, 0.3);
    const run = { forward: 1, right: 0, run: true, yaw: 0 };
    // run at the block (face at z = 196), jump about 1 m before it, keep running
    while (c.position().z < 194.8) runChar(pw, c, run, 1 / 60);
    c.applyInput({ ...run, jump: true });
    pw.step();
    runChar(pw, c, run, 0.8);
    expect(c.position().y).toBeCloseTo(1.4, 1);
    expect(c.position().z).toBeGreaterThan(196);

    const w = new Character(pw, { x: 8, y: 0, z: -20 });
    runChar(pw, w, idle, 0.3);
    const towards = { forward: 1, right: 0, run: true, yaw: Math.PI / 2 };
    while (w.position().x < 9.2) runChar(pw, w, towards, 1 / 60);
    w.applyInput({ ...towards, jump: true });
    pw.step();
    let top = 0;
    for (let i = 0; i < 60; i++) { w.applyInput(towards); pw.step(); top = Math.max(top, w.position().y); }
    expect(top).toBeLessThan(1.2);
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
      car.applyInput({ throttle: 0, steer: 0, brake: false });
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
    car.applyInput({ throttle: 0, steer: 0, brake: true });
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

  test('braking from top speed stops within 13 m, both via brake and via reverse throttle', async () => {
    for (const input of [{ throttle: 0, steer: 0, brake: true }, { throttle: -1, steer: 0, brake: false }]) {
      const pw = await createPhysicsWorld(miniScene());
      const car = new Vehicle(pw, { x: -150, z: 0, heading: Math.PI }); // heading north (−z)
      car.setOccupied(true);
      runCar(pw, car, full, 10);
      const z0 = car.pose().z;
      let steps = 0;
      while (car.speed() > 0.3 && steps < 300) {
        car.applyInput(input);
        pw.step();
        steps++;
      }
      expect(z0 - car.pose().z).toBeLessThan(13);
      expect(car.wheelsInContact()).toBe(4); // no nose-dive flip
    }
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

test('FixedStepper treats NaN, negative and infinite frame times as 0', () => {
  const s = new FixedStepper(1 / 60, 5);
  let n = 0;
  s.advance(1 / 120, () => n++);
  for (const bad of [NaN, -1, -1 / 60, Infinity, -Infinity]) {
    expect(s.advance(bad, () => n++)).toBe(0);
    expect(s.alpha).toBeCloseTo(0.5); // accumulator untouched
  }
  expect(n).toBe(0);
  expect(s.advance(1 / 120, () => n++)).toBe(1);
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
      c.applyInput({ forward: 1, right: 0.3, run: i > 60, yaw: i * 0.01 });
      car.applyInput({ throttle: 1, steer: Math.sin(i * 0.05), brake: i > 200 });
      pw.step();
    }
    return [c.position(), car.pose()];
  };
  expect(await run()).toEqual(await run());
});

test('tuning holds the brief values', () => {
  expect(TUNING.character).toMatchObject({ radius: 0.3, height: 1.8, walkSpeed: 1.6, runSpeed: 5.5, gravity: -20, jumpSpeed: 6.5 });
  expect(TUNING.vehicle).toMatchObject({ mass: 1200, maxForwardKmh: 60, maxReverseKmh: 20 });
});

const COLLISION_BIN = fileURLToPath(new URL('../../../../apps/client/public/world/collision.bin', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../../../../apps/client/public/world/manifest.json', import.meta.url));
const TERRAIN_BIN = fileURLToPath(new URL('../../../../apps/client/public/world/terrain.bin', import.meta.url));
const haveReal = existsSync(COLLISION_BIN) && existsSync(MANIFEST) && existsSync(TERRAIN_BIN);

test.skipIf(!haveReal)(
  haveReal ? 'real collision.bin + terrain.bin: world builds, character stands at the spawn (y ≈ spawn.y) and walks up the Dom stairs' : 'real collision.bin smoke test [SKIPPED: apps/client/public/world/{collision,terrain}.bin not found — run the pipeline]',
  async () => {
    const file = readFileSync(COLLISION_BIN);
    const asset = decodeCollision(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const tf = readFileSync(TERRAIN_BIN);
    const terrain = decodeTerrain(tf.buffer.slice(tf.byteOffset, tf.byteOffset + tf.byteLength));
    const spawn = JSON.parse(readFileSync(MANIFEST, 'utf8')).spawn as { x: number; y: number; z: number };
    const t0 = performance.now();
    // as the browser builds it: only the city around the spawn (both flights below are within CITY_NEED of it)
    const pw = await createPhysicsWorld(asset, terrain, { stream: [spawn] });
    // a generous bound: the budget (< 3 s) is measured in the browser; a loaded CI box must not flake here
    expect(performance.now() - t0).toBeLessThan(15_000);
    const c = new Character(pw, spawn);
    runChar(pw, c, idle, 1);
    expect(Math.abs(c.position().y - spawn.y)).toBeLessThanOrEqual(0.03); // spawn.y = the walkable surface there
    // the Domtreppe down to the Bahnhofsvorplatz and the steps up from the Kardinal-Höffner-Platz (data/models/
    // koelner-dom): walked up from 3 m in front of the lowest step, without jumping (autostep is 0.25 m; a lip at the
    // foot left the figure stuck)
    const flights = [
      { name: 'Domtreppe', from: { x: 350.5, z: 2352.8 }, yaw: 0, up: (p: { x: number; z: number }) => p.z > 2372.8, top: 8.7 },
      { name: 'Kardinal-Höffner-Platz', from: { x: 228.5, z: 2420.8 }, yaw: Math.PI / 2, up: (p: { x: number; z: number }) => p.x > 243.5, top: 7.75 },
    ];
    for (const f of flights) {
      const w = new Character(pw, { x: f.from.x, y: heightAt(terrain, f.from.x, f.from.z) + 0.05, z: f.from.z });
      runChar(pw, w, idle, 0.5);
      runChar(pw, w, { forward: 1, right: 0, run: false, yaw: f.yaw }, 20); // walking pace: ~1.4 m/s up the flight
      const p = w.position();
      expect({ name: f.name, up: f.up(p), y: p.y > f.top - 0.3 }).toEqual({ name: f.name, up: true, y: true });
      w.dispose();
    }
  },
  // decoding and building the city in a full parallel test run can take longer than the build bound alone
  30_000,
);

describe('multiplayer physics', () => {
  test('car passes a standing character without stopping', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const ch = new Character(pw, { x: 0, y: 0, z: 22 });
    const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
    car.setOccupied(true);
    for (let t = 0; t < 600 && car.pose().z < 18; t++) {
      car.applyInput({ throttle: car.speed() * KMH < 30 ? 1 : 0, steer: 0, brake: false });
      ch.applyInput(idle);
      pw.step();
    }
    expect(car.speed() * KMH).toBeGreaterThan(27); // up to speed before the hit
    runCar(pw, car, { throttle: 0.4, steer: 0, brake: false }, 1, () => ch.applyInput(idle));
    expect(car.pose().z).toBeGreaterThan(26); // went through the spot where the person stood
    expect(car.speed() * KMH).toBeGreaterThanOrEqual(25);
  });

  test('character cannot walk through a parked car', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
    runCar(pw, car, { throttle: 0, steer: 0, brake: false }, 0.3);
    expect(car.chassis.isSleeping()).toBe(true);
    const ch = new Character(pw, { x: -4, y: 0, z: 0 });
    runChar(pw, ch, { forward: 1, right: 0, run: false, yaw: Math.PI / 2 }, 3); // east, into the car's side
    const gap = car.pose().x - ch.position().x;
    expect(gap).toBeGreaterThanOrEqual(TUNING.vehicle.width / 2 + TUNING.character.radius - 0.05);
  });

  test('character save/restore round-trips mid-jump', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const ch = new Character(pw, { x: 0, y: 0, z: 0 });
    runChar(pw, ch, idle, 0.3);
    const inputs = (k: number): CharacterInput => ({ forward: 1, right: k % 7 < 3 ? 0.5 : -0.3, run: true, yaw: 0.1 * k, jump: k === 0 });
    for (let k = 0; k < 8; k++) { ch.applyInput(inputs(k)); pw.step(); }
    expect(ch.isGrounded()).toBe(false);
    const s = ch.saveState();
    const play = () => {
      for (let k = 8; k < 38; k++) { ch.applyInput(inputs(k)); pw.step(); }
      return { p: ch.position(), s: ch.saveState() };
    };
    const a = play();
    ch.restoreState(s);
    const b = play();
    expect(Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z)).toBeLessThan(1e-4);
    expect(Math.abs(a.s.vy - b.s.vy)).toBeLessThan(1e-4);
    expect(b.s.grounded).toBe(a.s.grounded);
  });

  test('knock: down for N ticks, no input effect, then walks again', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const ch = new Character(pw, { x: 0, y: 0, z: 0 });
    runChar(pw, ch, idle, 0.3);
    ch.knock({ x: 5, y: 3, z: 0 }, 60);
    const fwdZ: CharacterInput = { forward: 1, right: 0, run: false, yaw: 0 }; // would walk along +z
    const z0 = ch.position().z;
    let airborne = false;
    for (let k = 0; k < 60; k++) {
      expect(ch.isDown()).toBe(true);
      ch.applyInput(fwdZ);
      pw.step();
      if (!ch.isGrounded()) airborne = true;
    }
    expect(airborne).toBe(true);
    expect(ch.isDown()).toBe(false);
    const p = ch.position();
    expect(Math.abs(p.z - z0)).toBeLessThan(1e-3); // input had no effect
    expect(p.x).toBeGreaterThan(1); // flew along the knock velocity
    expect(ch.isGrounded()).toBe(true); // landed
    runChar(pw, ch, fwdZ, 1);
    expect(ch.position().z - p.z).toBeGreaterThan(1);
  });

  test('push moves the character through the controller, not through walls', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const ch = new Character(pw, { x: 9, y: 0, z: 0 });
    runChar(pw, ch, idle, 0.3);
    ch.push(2, 0); // the wall face is at x = 10
    runChar(pw, ch, idle, 0.1);
    expect(ch.position().x).toBeLessThan(10 - TUNING.character.radius + 0.01);
    ch.push(0, 0.5);
    const z = ch.position().z;
    runChar(pw, ch, idle, 0.1);
    expect(ch.position().z - z).toBeCloseTo(0.5, 2);
  });

  test('vehicle save/restore replays within 1 cm', async () => {
    const pw = await createPhysicsWorld(miniScene());
    const car = new Vehicle(pw, { x: 0, z: 0, heading: 0 });
    car.setOccupied(true);
    const inp = (k: number): VehicleInput => ({ throttle: 1, steer: Math.sin(k / 20) * 0.6, brake: false });
    for (let k = 0; k < 120; k++) { car.applyInput(inp(k)); pw.step(); }
    const s = car.saveState();
    const play = () => {
      for (let k = 120; k < 140; k++) { car.applyInput(inp(k)); pw.step(); }
      return { p: car.pose(), steer: car.steer() };
    };
    const a = play();
    car.restoreState(s);
    expect(car.steer()).toBe(s.steer);
    const b = play();
    expect(Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y, a.p.z - b.p.z)).toBeLessThan(0.01);
    expect(Math.abs(a.steer - b.steer)).toBeLessThan(1e-4);
  });
});
