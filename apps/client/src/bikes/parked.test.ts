import { expect, test } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import type { BikeType } from '@nn/shared';
import { BikeView, FALL_S, fallFraction, RACK_RENDER_RADIUS, type BikeSource } from './parked';

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

test('draws the bikes near the camera per type, not the ridden one, racks near the camera', () => {
  const scene = new Scene();
  const src = source();
  const models = new Map<BikeType, Group>([['dutch', model()], ['road', model()]]);
  const racks = [{ x: 1, z: 1, heading: 0, kind: 0 as const }, { x: RACK_RENDER_RADIUS + 50, z: 0, heading: 0, kind: 0 as const }];
  const view = new BikeView(scene, models, new Map([[0, model()]]), src, racks, [0.12, 0.12]);
  view.update(0, 0);
  expect(counts(scene)).toEqual(expect.arrayContaining([['bike_dutch_frame', 2], ['bike_dutch_wheel_rear', 2], ['bike_road_frame', 1], ['rack_0_frame', 1]]));
  (src.rider as (number | null)[])[0] = 3;
  view.update(0, 0);
  expect(counts(scene)).toEqual(expect.arrayContaining([['bike_dutch_frame', 1]]));
  view.update(RACK_RENDER_RADIUS + 50, 0); // moved to the far rack: only it is drawn
  expect(counts(scene)).toEqual(expect.arrayContaining([['rack_0_frame', 1]]));
});

test('a bike lying when first drawn just lies; one that falls while drawn falls over once', () => {
  const scene = new Scene();
  const side = [1, 0, 0, 0];
  const src: BikeSource = { ...source(), activeIds: () => [1], fallSide: (i) => side[i]! };
  const view = new BikeView(scene, new Map<BikeType, Group>([['dutch', model()], ['road', model()]]), new Map(), src, [], []);
  expect(view.update(0, 0, 0.016)).toEqual([]);
  side[1] = -1;
  expect(view.update(0, 0, 0.016)).toEqual([{ x: 5, z: 0 }]);
  const frame = scene.getObjectByName('bike_dutch_frame') as InstancedMesh;
  const up = () => {
    const m = new Matrix4();
    frame.getMatrixAt(1, m);
    return new Vector3(0, 1, 0).transformDirection(m).y;
  };
  view.update(0, 0, FALL_S / 2);
  const half = up();
  for (let k = 0; k < 60; k++) expect(view.update(0, 0, 0.016)).toEqual([]);
  expect(half).toBeGreaterThan(0.5); // still on its way down
  expect(up()).toBeLessThan(0.3); // lying
  expect(fallFraction(FALL_S / 2)).toBeCloseTo(0.25);
  expect(fallFraction(10)).toBe(1);
});
