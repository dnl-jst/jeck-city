import { describe, expect, test } from 'vitest';
import { Group, Scene, Vector3 } from 'three';
import { PlayerFigure } from './player';

const seat = new Vector3(0, 0.98, -0.25);
const grips: [Vector3, Vector3] = [new Vector3(0.28, 1.1, 0.35), new Vector3(-0.28, 1.1, 0.35)];
/** Pedals of a crank at the bottom bracket (0, 0.29, 0.1), 0.17 m arms, left arm down at crank 0. */
const pedals = (crank: number): [Vector3, Vector3] => [
  new Vector3(0.1, 0.29 - 0.17 * Math.cos(crank), 0.1 - 0.17 * Math.sin(crank)),
  new Vector3(-0.1, 0.29 + 0.17 * Math.cos(crank), 0.1 + 0.17 * Math.sin(crank)),
];

describe('riding pose', () => {
  test('feet follow the pedals', () => {
    const f = new PlayerFigure(new Scene());
    for (const crank of [0, 1, Math.PI, 4]) {
      const p = pedals(crank);
      f.ride(seat, grips, p, 'upright');
      expect(f.foot(0).distanceTo(p[0])).toBeLessThan(0.05);
      expect(f.foot(1).distanceTo(p[1])).toBeLessThan(0.05);
    }
  });

  test('race posture leans forward more than upright', () => {
    const f = new PlayerFigure(new Scene());
    f.ride(seat, grips, pedals(0), 'upright');
    const upright = f.torsoPitch();
    f.ride(seat, grips, pedals(0), 'race');
    expect(f.torsoPitch()).toBeGreaterThan(upright + 0.3);
  });

  test('hands reach the grips also when the figure hangs in a turned and leaning bike', () => {
    const scene = new Scene();
    const f = new PlayerFigure(scene);
    const bike = new Group();
    bike.position.set(5, 0.1, -3);
    bike.rotation.set(0, 1.2, 0.2);
    scene.add(bike);
    bike.add(f.group);
    f.ride(seat, grips, pedals(0.5), 'upright');
    expect(f.hand(0).distanceTo(grips[0])).toBeLessThan(0.15);
    expect(f.hand(1).distanceTo(grips[1])).toBeLessThan(0.15);
    expect(f.foot(0).distanceTo(pedals(0.5)[0])).toBeLessThan(0.05);
  });

  test('hands reach towards the grips', () => {
    const f = new PlayerFigure(new Scene());
    f.ride(seat, grips, pedals(0), 'sport');
    expect(f.hand(0).distanceTo(grips[0])).toBeLessThan(0.15);
    expect(f.hand(1).distanceTo(grips[1])).toBeLessThan(0.15);
  });
});

describe('fall and get up', () => {
  test('busy while falling and lying, free again after about a second', () => {
    const f = new PlayerFigure(new Scene());
    f.fall(0);
    const step = (s: number) => { for (let i = 0; i < Math.round(s * 60); i++) f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 1 / 60); };
    step(0.5);
    expect(f.busy).toBe(true);
    step(1.2);
    expect(f.busy).toBe(false);
  });

  test('getUp ends a fall early', () => {
    const f = new PlayerFigure(new Scene());
    f.fall(0);
    f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 0.3);
    f.getUp();
    f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 0.7);
    expect(f.busy).toBe(false);
  });
});
