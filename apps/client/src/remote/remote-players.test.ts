import { describe, expect, test } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import type { SnapshotCar, SnapshotWalker } from '@nn/shared';
import { labelOpacity, type Label } from './name-label';
import { RemotePlayers, type CarView, type RemoteCarInfo } from './remote-players';

const walker = (slot: number, x = slot * 2, state: 0 | 1 | 2 = 0): SnapshotWalker => ({ slot, x, y: 0, z: 0, yaw: 0, speed: 0, state });
const car = (id: number, hasDriver = true): SnapshotCar => ({ id, x: 5, y: 1, z: 5, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, steer: 0, brakeLight: false, hasDriver });

class FakeLabel implements Label {
  disposed = false;
  constructor(readonly name: string, readonly all: FakeLabel[]) { all.push(this); }
  place(): void {}
  attach(): void {}
  dispose(): void { this.disposed = true; }
}
class FakeCar implements CarView {
  shown = false;
  lights: { braking: boolean; power: number } | null = null;
  show(): void { this.shown = true; }
  hide(): void { this.shown = false; }
  setPose(): void {}
  setLights(_n: number, braking: boolean, power: number): void { this.lights = { braking, power }; }
  updateGlare(): void {}
}

function setup(me = 0) {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const labels: FakeLabel[] = [];
  const cars: FakeCar[] = [];
  const hidden: Set<number>[] = [];
  const rp = new RemotePlayers(scene, { setHidden: (ids) => hidden.push(new Set(ids)) }, {
    me, colorOf: () => 0xff0000, occluded: () => false,
    makeLabel: (n) => new FakeLabel(n, labels),
    makeCar: () => { const c = new FakeCar(); cars.push(c); return c; },
  });
  const frame = (ws: SnapshotWalker[], cs: SnapshotCar[] = [], names = new Map<number, string>(), info = new Map<number, RemoteCarInfo>()) =>
    rp.update({ walkers: new Map(ws.map((w) => [`p${w.slot}`, w])), cars: new Map(cs.map((c) => [`c${c.id}`, c])) }, names, info, camera, 0, 1 / 60);
  return { scene, rp, labels, cars, hidden, frame };
}

describe('RemotePlayers', () => {
  test('figures are pooled', () => {
    const { scene, frame } = setup();
    const names = new Map([1, 2, 3, 4, 5].map((s) => [s, `P${s}`] as const));
    const all = [1, 2, 3, 4, 5].map((s) => walker(s));
    frame(all, [], names);
    expect(scene.children.filter((c) => c.type === 'Group')).toHaveLength(5);
    for (let round = 0; round < 3; round++) {
      frame([], [], names); // everyone leaves
      expect(scene.children.filter((c) => c.type === 'Group' && c.visible)).toHaveLength(0);
      frame(all, [], names); // and comes back
      expect(scene.children.filter((c) => c.type === 'Group' && c.visible)).toHaveLength(5);
    }
    expect(scene.children.filter((c) => c.type === 'Group')).toHaveLength(5); // never more than 5 created
  });

  test('label fades between 35 and 50 m', () => {
    expect(labelOpacity(0)).toBe(1);
    expect(labelOpacity(35)).toBe(1);
    expect(labelOpacity(42.5)).toBeCloseTo(0.5);
    expect(labelOpacity(50)).toBe(0);
    expect(labelOpacity(80)).toBe(0);
  });

  test('own name is never shown; labels are disposed when a player leaves', () => {
    const { frame, labels } = setup(1);
    const names = new Map([[1, 'Me'], [2, 'Jupp']]);
    frame([walker(1), walker(2)], [], names);
    expect(labels.map((l) => l.name)).toEqual(['Jupp']);
    frame([walker(1)], [], names);
    expect(labels[0]!.disposed).toBe(true);
  });

  test('remote car hides its parked instance and shows lights from the lamp level and brake flag', () => {
    const { frame, hidden, cars, labels } = setup();
    const names = new Map([[3, 'Tünnes']]);
    const c = { ...car(7), brakeLight: true };
    frame([], [c, car(8, false)], names, new Map([[7, { driver: 3, level: 1 }], [8, { driver: -1, level: 0 }]]));
    expect(hidden.at(-1)).toEqual(new Set([7])); // the unoccupied streamed car stays a parked instance
    expect(cars).toHaveLength(1);
    expect(cars[0]!.shown).toBe(true);
    expect(cars[0]!.lights).toEqual({ braking: true, power: 1 });
    expect(labels.map((l) => l.name)).toEqual(['Tünnes']);
    frame([], [], names);
    expect(hidden.at(-1)).toEqual(new Set());
    expect(cars[0]!.shown).toBe(false);
    expect(labels[0]!.disposed).toBe(true);
  });

  test('a car the own player drives is not drawn as a remote car', () => {
    const { frame, cars } = setup(3);
    frame([], [car(7)], new Map(), new Map([[7, { driver: 3, level: 1 }]]));
    expect(cars).toHaveLength(0);
  });
});
