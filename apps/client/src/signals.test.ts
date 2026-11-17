import { expect, test } from 'vitest';
import { BoxGeometry, Color, Group, InstancedMesh, Mesh, MeshStandardMaterial, Scene } from 'three';
import { signalAt, TICK_HZ, type SignalJunction } from '@nn/shared';
import { TrafficSignals } from './signals';

/** A model like data/models/signals: pole + the named lamp meshes. */
function model(lamps: string[]): Group {
  const g = new Group();
  const pole = new Mesh(new BoxGeometry(0.1, 3.5, 0.1), new MeshStandardMaterial());
  pole.name = 'pole';
  g.add(pole);
  for (const n of lamps) {
    const m = new Mesh(new BoxGeometry(0.2, 0.2, 0.02), new MeshStandardMaterial({ name: n }));
    m.name = n;
    g.add(m);
  }
  return g;
}

const j: SignalJunction = {
  x: 0, z: 0, signal: { id: 0, offsetTicks: 0, midblock: false },
  poles: [
    { x: 5, z: 0, heading: 0, kind: 'car', group: 0, ped: -1 },
    { x: -5, z: 0, heading: 0, kind: 'car', group: 1, ped: -1 },
    { x: 0, z: 5, heading: 0, kind: 'ped', group: -1, ped: 1 },
  ],
  stopLines: [{ x0: -1, z0: 3, x1: 1, z1: 3 }],
};

function setup() {
  const scene = new Scene();
  const models = new Map([
    ['car', model(['lamp_red', 'lamp_amber', 'lamp_green'])],
    ['ped', model(['lamp_ped_red', 'lamp_ped_green'])],
    ['car+ped', model(['lamp_red', 'lamp_amber', 'lamp_green', 'lamp_ped_red', 'lamp_ped_green'])],
  ] as const);
  const s = new TrafficSignals(scene, [j], new Map(models), () => 0);
  return { scene, s };
}

/** Whether instance i of the lamp mesh `name` of kind `kind` is lit. */
const lit = (s: TrafficSignals, kind: 'car' | 'ped', name: string, i: number): boolean => {
  const m = s.mesh(kind, name)!;
  const c = new Color();
  m.getColorAt(i, c);
  return c.r + c.g + c.b > 1;
};

test('car heads follow signalAt for their group', () => {
  const { s } = setup();
  for (const t of [0, 21 * TICK_HZ, 25.5 * TICK_HZ, 30 * TICK_HZ]) {
    s.update(t, 0, 0, 0);
    for (const [i, group] of [[0, 0], [1, 1]] as const) {
      const l = signalAt(j, group, t);
      expect(lit(s, 'car', 'lamp_red', i)).toBe(l === 'red' || l === 'redAmber');
      expect(lit(s, 'car', 'lamp_amber', i)).toBe(l === 'amber' || l === 'redAmber');
      expect(lit(s, 'car', 'lamp_green', i)).toBe(l === 'green');
    }
  }
});

test('pedestrian heads follow pedSignalAt', () => {
  const { s } = setup();
  s.update(0, 0, 0, 0); // group 0 green: the pedestrians of group 1 wait
  expect(lit(s, 'ped', 'lamp_ped_red', 0)).toBe(true);
  expect(lit(s, 'ped', 'lamp_ped_green', 0)).toBe(false);
  s.update(27 * TICK_HZ, 0, 0, 0);
  expect(lit(s, 'ped', 'lamp_ped_green', 0)).toBe(true);
});

test('one instanced mesh per model part, stop lines as one mesh', () => {
  const { scene } = setup();
  const inst = scene.children.filter((o) => (o as InstancedMesh).isInstancedMesh) as InstancedMesh[];
  expect(inst.find((m) => m.name === 'car/pole')!.count).toBe(2);
  expect(inst.find((m) => m.name === 'ped/pole')!.count).toBe(1);
  expect(scene.getObjectByName('stop-lines')).toBeDefined();
});
