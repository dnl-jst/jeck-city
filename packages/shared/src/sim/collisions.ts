import type RAPIER from '@dimforge/rapier3d-compat';
import { bikeColliderRadius, type RiddenBike } from '../physics/bike';
import type { Character } from '../physics/character';
import { TUNING } from '../physics/tuning';
import { CHASSIS_CLEARANCE } from '../physics/vehicle';
import { KNOCKDOWN_KMH, KNOCKDOWN_S, TICK_HZ } from '../net/constants';
import type { PlayerId } from './cars';
import { headingOf } from './rules';
import type { SimEvent, WorldSim } from './world-sim';

const KMH = 1 / 3.6;
const DT = TUNING.world.dt;
const R = TUNING.character.radius;
/** A knocked-down person is thrown at 0.9 × the car's velocity plus this much upwards (m/s). */
const KNOCK_UP = 3;
/** A car keeps this much of its speed when it hits someone. */
const CAR_KEEP = 0.97;
/** Most a slow car shoves a person in one tick (m). */
const PUSH_MAX = 0.5;
/** Feet this far below the top of a car's chassis box still count as standing on it (m). */
const ON_TOP = 0.25;
/** Cell size of the walker separation grid (m). */
const CELL = 2;

/**
 * Before every step: every awake car faster than KNOCKDOWN_KMH knocks down the people (not already down) inside its
 * chassis box, grown by the distance it covers this step (pattern of StreetProps.checkHits); a slower car shoves
 * them out of its way. Cars and people do not collide in the solver (see CAR_GROUPS), so this is the only contact.
 * Riders the same: a fast car throws them off the bike (the crash path, WorldSim.knockOffBike, plus a `knock`), a
 * slow one shoves the bike.
 */
export function carHitsPeople(sim: WorldSim, ev: SimEvent[]): void {
  const awake = sim.cars.awake();
  if (awake.length === 0) return;
  const people = new Map<number, { id: PlayerId; char: Character }>();
  for (const p of sim.onFoot()) people.set(p.char.colliderHandle, p);
  /** Riders by the collider handles of their bikes. */
  const riders = new Map<number, { id: PlayerId; bike: RiddenBike }>();
  for (const r of sim.riders()) for (const h of r.bike.colliderHandles()) riders.set(h, r);
  if (people.size === 0 && riders.size === 0) return;
  const { rapier, world } = sim.pw;
  const knocked = new Set<number>();
  for (const i of awake) {
    const v = sim.cars.vehicle(i)!;
    const body = v.chassis;
    // a kinematic stand-in for a car the server streams (client prediction): the server decides its hits
    if (!body.isDynamic()) continue;
    const vel = body.linvel();
    const speed = Math.hypot(vel.x, vel.z);
    if (speed < 0.2) continue;
    const fast = speed > KNOCKDOWN_KMH * KMH;
    const m = speed * DT + 0.05;
    const V = v.spec;
    const box = new rapier.Cuboid(V.width / 2 + m, (V.height - CHASSIS_CLEARANCE) / 2 + m, V.length / 2 + m);
    const hit: { id: PlayerId; char: Character }[] = [];
    const hitRiders = new Map<PlayerId, RiddenBike>();
    // the chassis box (its collider sits off the body origin, see chassisLayout), in world space
    const box0 = body.collider(0);
    const riderOf = (c: RAPIER.Collider) => riders.get(c.handle);
    // someone standing on the car (feet at the roof or above) rides along: neither knocked down nor shoved
    const roof = box0.translation().y + (V.height - CHASSIS_CLEARANCE) / 2 - ON_TOP;
    world.intersectionsWithShape(box0.translation(), box0.rotation(), box, (c: RAPIER.Collider) => {
      const p = people.get(c.handle);
      if (p) hit.push(p);
      else {
        const r = riderOf(c)!;
        hitRiders.set(r.id, r.bike); // a bike has two colliders: once per rider
      }
      return true;
    }, undefined, undefined, undefined, body, (c: RAPIER.Collider) => {
      const p = people.get(c.handle);
      if (p) return !p.char.isDown() && !knocked.has(p.id) && p.char.position().y < roof;
      const r = riderOf(c);
      return !!r && !knocked.has(r.id);
    });
    if (hit.length === 0 && hitRiders.size === 0) continue;
    const pose = v.pose();
    const h = headingOf(pose), fx = Math.sin(h), fz = Math.cos(h);
    const dx = vel.x / speed, dz = vel.z / speed;
    // extent of the chassis box along the travel direction
    const extent = (V.length / 2) * Math.abs(dx * fx + dz * fz) + (V.width / 2) * Math.abs(dx * fz - dz * fx);
    let struck = false;
    for (const p of hit.sort((a, b) => a.id - b.id)) {
      if (knocked.has(p.id)) continue;
      if (fast) {
        knocked.add(p.id);
        p.char.knock({ x: vel.x * 0.9, y: vel.y * 0.9 + KNOCK_UP, z: vel.z * 0.9 }, KNOCKDOWN_S * TICK_HZ);
        ev.push({ t: 'knock', id: p.id, by: i });
        const f = p.char.position();
        ev.push({ t: 'impact', x: f.x, z: f.z, strength: speed });
        struck = true;
      } else {
        const f = p.char.position();
        const ahead = (f.x - pose.x) * dx + (f.z - pose.z) * dz;
        if (ahead <= 0) continue; // beside or behind the middle of the car: never shoved into the chassis
        const overlap = Math.min(PUSH_MAX, Math.max(0, extent + R - ahead));
        p.char.push(dx * overlap, dz * overlap);
      }
    }
    for (const [id, bike] of [...hitRiders].sort((a, b) => a[0] - b[0])) {
      if (knocked.has(id)) continue;
      const s = bike.state();
      if (fast) {
        knocked.add(id);
        // the car's push plus half the rider's own momentum
        const bx = Math.sin(s.heading) * s.speed * 0.5, bz = Math.cos(s.heading) * s.speed * 0.5;
        sim.knockOffBike(id, ev, { x: vel.x * 0.9 + bx, y: vel.y * 0.9 + KNOCK_UP, z: vel.z * 0.9 + bz });
        ev.push({ t: 'knock', id, by: i });
        ev.push({ t: 'impact', x: s.x, z: s.z, strength: speed });
        struck = true;
      } else {
        // the bike collides with the car in the solver (it is kinematic: the car would stop dead), so it is kept a
        // step's travel (m) ahead of the chassis box: from the box centre, its extent plus the bike's frame box (half
        // width across, half length along its heading) along the travel direction
        const c = box0.translation();
        const ahead = (s.x - c.x) * dx + (s.z - c.z) * dz;
        if (ahead <= 0) continue;
        const along = dx * Math.sin(s.heading) + dz * Math.cos(s.heading);
        const reach = (bike.spec.wheelbase / 2 + 0.3) * Math.abs(along) + bikeColliderRadius(bike.spec) * Math.sqrt(Math.max(0, 1 - along * along));
        const overlap = Math.min(PUSH_MAX, Math.max(0, extent + reach + m - ahead));
        bike.push(dx * overlap, dz * overlap);
      }
    }

    if (struck) body.setLinvel({ x: vel.x * CAR_KEEP, y: vel.y, z: vel.z * CAR_KEEP }, true);
  }
}

/** Pairs of people on foot closer than two radii are moved apart by half the deficit each (grid of CELL m, O(n²) per cell neighbourhood). */
export function separatePeople(sim: WorldSim): void {
  const people = sim.onFoot();
  if (people.length < 2) return;
  const pos = people.map((p) => p.char.position());
  const grid = new Map<string, number[]>();
  pos.forEach((p, k) => {
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
  });
  const min = 2 * R;
  for (let a = 0; a < people.length; a++) {
    const cx = Math.floor(pos[a]!.x / CELL), cz = Math.floor(pos[a]!.z / CELL);
    for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
      for (const b of grid.get(`${cx + ox},${cz + oz}`) ?? []) {
        if (b <= a) continue;
        const pa = pos[a]!, pb = pos[b]!;
        if (Math.abs(pa.y - pb.y) > TUNING.character.height) continue;
        let dx = pb.x - pa.x, dz = pb.z - pa.z;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        if (d < 1e-4) { dx = 1; dz = 0; d = 1; } // same spot: arbitrary but deterministic axis
        const k = ((min - d) / 2) / d;
        people[a]!.char.push(-dx * k, -dz * k);
        people[b]!.char.push(dx * k, dz * k);
      }
    }
  }
}
