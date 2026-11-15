import { describe, expect, test } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { BikeState } from '@nn/shared';
import { BikeRig, visibleBikes, wheelSpin } from './rig';

/** Minimal bike model with the README node contract; wheels are 0.7 m boxes (radius 0.35). */
function model(trike = false): { root: Object3D; paint: MeshStandardMaterial } {
  const scene = new Group();
  const paint = new MeshStandardMaterial({ name: 'paint', color: 0x00ff00 });
  const tyre = new MeshStandardMaterial({ name: 'tyre', color: 0x111111 });
  const lampF = new MeshStandardMaterial({ name: 'lamp_front' });
  const node = (name: string, parent: Object3D, mesh?: Mesh) => {
    const o = mesh ?? new Object3D();
    o.name = name;
    parent.add(o);
    return o;
  };
  const frame = node('frame', scene, new Mesh(new BoxGeometry(0.1, 0.1, 1), paint));
  const fork = node('fork', frame);
  fork.position.set(0, 0.9, 0.4);
  const wheels = trike ? ['wheel_front_l', 'wheel_front_r'] : ['wheel_front'];
  for (const w of wheels) node(w, fork, new Mesh(new BoxGeometry(0.05, 0.7, 0.7), tyre)).position.set(0, -0.55, 0.15);
  node('wheel_rear', frame, new Mesh(new BoxGeometry(0.05, 0.7, 0.7), tyre)).position.set(0, 0.35, -0.55);
  const crank = node('crank', frame);
  node('pedal_l', crank);
  node('pedal_r', crank);
  node('light_front', fork, new Mesh(new BoxGeometry(0.05, 0.05, 0.05), lampF));
  node('light_rear', frame);
  node('seat', frame).position.set(0, 0.95, -0.25);
  node('grip_l', fork).position.set(0.3, 0.1, -0.1);
  node('grip_r', fork).position.set(-0.3, 0.1, -0.1);
  return { root: scene, paint };
}

const state = (o: Partial<BikeState> = {}): BikeState => ({ x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, vy: 0, grounded: true, crank: 0, ...o });

describe('bike rig', () => {
  test('wheelSpin: one circumference is one turn', () => {
    expect(wheelSpin(2 * Math.PI * 0.35, 0.35)).toBeCloseTo(2 * Math.PI, 9);
  });

  test('steering turns the fork (right = negative yaw), lean rolls the bike, pose places it', () => {
    const rig = new BikeRig(model().root, 'dutch');
    rig.update(state({ x: 3, y: 0.12, z: -4, heading: 1, steer: 0.3 }), 0.2, 0);
    expect(rig.node('fork')!.rotation.y).toBeCloseTo(-0.3, 9);
    expect(rig.leanGroup.rotation.z).toBeCloseTo(0.2, 9);
    expect(rig.root.position.toArray()).toEqual([3, 0.12, -4]);
    expect(rig.root.rotation.y).toBeCloseTo(1, 9);
  });

  test('wheels spin with the distance ridden, crank from the state, pedals stay level', () => {
    const rig = new BikeRig(model().root, 'road');
    rig.update(state({ speed: 5, crank: 1.3 }), 0, 0.1);
    expect(rig.node('wheel_front')!.rotation.x).toBeCloseTo(0.5 / 0.35, 6);
    expect(rig.node('wheel_rear')!.rotation.x).toBeCloseTo(0.5 / 0.35, 6);
    expect(rig.node('crank')!.rotation.x).toBeCloseTo(1.3, 9);
    expect(rig.node('pedal_l')!.rotation.x).toBeCloseTo(-1.3, 9);
  });

  test('trike: both front wheels turn with the fork and spin', () => {
    const rig = new BikeRig(model(true).root, 'trike');
    rig.update(state({ speed: 3.5, steer: -0.2 }), 0, 0.1);
    expect(rig.node('fork')!.rotation.y).toBeCloseTo(0.2, 9);
    expect(rig.node('wheel_front_l')!.rotation.x).toBeCloseTo(1, 6);
    expect(rig.node('wheel_front_r')!.rotation.x).toBeCloseTo(1, 6);
  });

  test('setColor recolours only this rig\'s paint', () => {
    const { root, paint } = model();
    const rig = new BikeRig(root, 'dutch');
    rig.setColor(0xff0000);
    expect(rig.paint!.color.getHex()).toBe(0xff0000);
    expect(paint.color.getHex()).toBe(0x00ff00);
  });

  test('lights glow only at night', () => {
    const rig = new BikeRig(model().root, 'dutch');
    rig.setLights(0);
    expect(rig.lampFront!.emissiveIntensity).toBe(0);
    rig.setLights(1);
    expect(rig.lampFront!.emissiveIntensity).toBeGreaterThan(1);
  });

  test('seat and grips in world space', () => {
    const rig = new BikeRig(model().root, 'dutch');
    rig.update(state({ x: 10 }), 0, 0);
    expect(rig.seat().x).toBeCloseTo(10, 6);
    expect(rig.seat().y).toBeCloseTo(0.95, 6);
    const [l, r] = rig.grips();
    expect(l.x).toBeGreaterThan(r.x); // heading 0: rider's left is +x
  });
});

describe('visible bikes', () => {
  test('within the radius, minus the skipped one', () => {
    const poses = [{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 200, z: 0 }];
    expect(visibleBikes(poses, 0, 0, 120, null)).toEqual([0, 1]);
    expect(visibleBikes(poses, 0, 0, 120, 0)).toEqual([1]);
  });
});
