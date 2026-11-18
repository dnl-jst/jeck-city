import { expect, test } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { BikeType, NpcKind } from '@nn/shared';
import type { CarView, RiderRig } from '../remote/remote-players';
import type { NpcDraw } from './npc-feed';
import { NpcView } from './npc-view';

class FakeCar implements CarView {
  shown: [string, number] | null = null;
  show(type: string, color: number): void { this.shown = [type, color]; }
  hide(): void { this.shown = null; }
  setPose(): void {}
  setWheels(): void {}
  setLights(): void {}
  updateGlare(): void {}
}
class FakeRig implements RiderRig {
  readonly root = new Group();
  readonly leanGroup = new Group();
  constructor(readonly type: BikeType) { this.root.add(this.leanGroup); }
  update(): void {}
  setColor(): void {}
  setLights(): void {}
  localPoint(): Vector3 { return new Vector3(0, 1, 0); }
}

const draw = (id: number, kind: NpcKind, x: number, extra: Partial<NpcDraw> = {}): NpcDraw => ({
  id, kind, look: { variant: 0, tint: 0x336699, scale: 1, vehicleType: kind === 'driver' ? 1 : kind === 'cyclist' ? 0 : kind === 'sitter' ? 1 : -1, vehicleColor: 0xc0262d },
  pose: { x, y: 0, z: 0, heading: 0, pitch: 0, speed: kind === 'sitter' ? 0 : 1.4, s: 0, done: false },
  action: kind === 'sitter' ? 'sit' : 'move', alpha: 1, say: null, honk: false, planAgeMs: 0, ...extra,
});

function setup(quality: 'low' | 'medium' | 'high' = 'medium') {
  const scene = new Scene();
  const cars: FakeCar[] = [];
  const view = new NpcView(scene, {
    occluded: () => false, makeCar: () => { const c = new FakeCar(); cars.push(c); return c; },
    makeRig: (t) => new FakeRig(t), figureFor: () => null, quality: () => quality,
  });
  const camera = new PerspectiveCamera();
  return { scene, view, cars, camera };
}

test('pools figures and reuses them', () => {
  const { view, camera } = setup();
  view.update([draw(1, 'walker', 0), draw(2, 'walker', 2)], camera, 0, 0.016);
  expect(view.counts().figures).toBe(2);
  view.update([draw(3, 'walker', 0)], camera, 0, 0.016);
  expect(view.counts().figures).toBe(1);
  expect(view.counts().pooledFigures).toBe(1);
  view.update([draw(4, 'walker', 0), draw(5, 'walker', 1)], camera, 0, 0.016);
  expect(view.counts().pooledFigures).toBe(0);
});

test('hides walkers beyond 150 m but keeps cars', () => {
  const { view, camera, cars } = setup();
  view.update([draw(1, 'walker', 200), draw(2, 'driver', 200)], camera, 0, 0.016);
  expect(view.counts().figures).toBe(0);
  expect(cars.filter((c) => c.shown).length).toBe(1);
});

test('the driver car shows type and colour from its look', () => {
  const { view, camera, cars } = setup();
  view.update([draw(1, 'driver', 10)], camera, 0, 0.016);
  expect(cars[0]!.shown).toEqual(['mittelklasse', 0xc0262d]);
});

test('a sitter on a bench sits with the hips at bench height', () => {
  const { view, camera } = setup();
  view.update([draw(1, 'sitter', 3)], camera, 0, 0.016);
  const f = view.figureOf(1)!;
  expect(f.sitting).toBe(true);
  expect(f.hipY()).toBeCloseTo(0.45, 1);
});

test('two cyclists on the same bike type each get their own bike (the model is cloned)', () => {
  const scene = new Scene();
  const model = new Group();
  model.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ name: 'paint' })));
  const view = new NpcView(scene, { occluded: () => false, figureFor: () => null, bikeModels: new Map([['dutch', model]]) });
  view.update([draw(1, 'cyclist', 3), draw(2, 'cyclist', 6)], new PerspectiveCamera(), 0, 0.016);
  const a = view.figureOf(1)!.group.parent!, b = view.figureOf(2)!.group.parent!;
  expect(a).not.toBe(b);
  expect(model.parent).toBeNull(); // the template itself stays out of the scene
});

test('low quality: npc figures cast no shadows', () => {
  const { view, camera } = setup('low');
  view.update([draw(1, 'walker', 3)], camera, 0, 0.016);
  let casting = 0;
  view.figureOf(1)!.group.traverse((o) => { if ((o as Mesh).isMesh && o.castShadow) casting++; });
  expect(casting).toBe(0);
});
