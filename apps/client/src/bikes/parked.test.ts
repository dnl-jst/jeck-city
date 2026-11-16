import { expect, test } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, Scene } from 'three';
import type { BikeType } from '@nn/shared';
import { BikeView, type BikeSource } from './parked';

const model = () => {
  const g = new Group();
  const frame = new Mesh(new BoxGeometry(0.1, 0.1, 1), new MeshStandardMaterial({ name: 'paint' }));
  frame.name = 'frame';
  const wheel = new Mesh(new BoxGeometry(0.05, 0.7, 0.7), new MeshStandardMaterial({ name: 'tyre' }));
  wheel.name = 'wheel_rear';
  frame.add(wheel);
  g.add(frame);
  return g;
};

function source(): BikeSource {
  return {
    poses: [{ x: 0, y: 0, z: 0, heading: 0 }, { x: 5, y: 0, z: 0, heading: 0 }, { x: 500, y: 0, z: 0, heading: 0 }, { x: 3, y: 0, z: 0, heading: 0 }],
    types: ['dutch', 'dutch', 'dutch', 'road'] as BikeType[],
    colors: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff],
    rider: [null, null, null, null],
    activeIds: () => [],
  };
}

const counts = (scene: Scene) => scene.children.filter((c): c is InstancedMesh => (c as InstancedMesh).isInstancedMesh).map((m) => [m.name, m.count]);

test('draws the bikes near the camera per type, not the ridden one, racks always', () => {
  const scene = new Scene();
  const src = source();
  const models = new Map<BikeType, Group>([['dutch', model()], ['road', model()]]);
  const view = new BikeView(scene, models, new Map([[0, model()]]), src, [{ x: 1, z: 1, heading: 0, kind: 0 }], [0.12]);
  view.update(0, 0);
  expect(counts(scene)).toEqual(expect.arrayContaining([['bike_dutch_frame', 2], ['bike_dutch_wheel_rear', 2], ['bike_road_frame', 1], ['rack_0_frame', 1]]));
  (src.rider as (number | null)[])[0] = 3;
  view.update(0, 0);
  expect(counts(scene)).toEqual(expect.arrayContaining([['bike_dutch_frame', 1]]));
});
