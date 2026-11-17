import { describe, expect, test } from 'vitest';
import { Bone, Group, type Object3D, Scene, Vector3 } from 'three';
import { gaitPose, PlayerFigure, proportionsOf } from './player';

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

  test('a far, low bar (MTB): the rider leans further forward until the hands are on the grips', () => {
    const f = new PlayerFigure(new Scene());
    const far: [Vector3, Vector3] = [new Vector3(0.36, 1.05, 0.58), new Vector3(-0.36, 1.05, 0.58)];
    f.ride(seat, far, pedals(0), 'sport');
    expect(f.hand(0).distanceTo(far[0])).toBeLessThan(0.08);
    expect(f.hand(1).distanceTo(far[1])).toBeLessThan(0.08);
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

  test('reset: standing at once, from a fall and from being knocked down', () => {
    const f = new PlayerFigure(new Scene());
    const still = { x: 0, y: 0, z: 0 };
    f.fall(0);
    f.update(0, 0, 0, still, 0.5);
    f.reset();
    expect(f.busy).toBe(false);
    f.setDown(1);
    for (let i = 0; i < 120; i++) f.update(0, 0, 0, still, 1 / 60);
    expect(f.group.rotation.x).toBeCloseTo(-Math.PI / 2, 2);
    f.reset();
    f.update(0, 0, 0, still, 1 / 60);
    expect(f.group.rotation.x).toBeCloseTo(0, 5);
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

/** A bone hierarchy like MPFB's game_engine rig (only the bones the figure uses), rest pose at the given joints. */
function fakeRig(): Group {
  const root = new Group();
  const bone = (name: string, parent: Object3D, at: Vector3, parentAt: Vector3) => {
    const b = new Bone();
    b.name = name;
    b.position.copy(at).sub(parentAt);
    parent.add(b);
    return b;
  };
  const O = new Vector3();
  const pelvis = bone('pelvis', root, new Vector3(0, 1.0, 0), O);
  const spine = bone('spine_01', pelvis, new Vector3(0, 1.08, 0.02), pelvis.position);
  const spineAt = new Vector3(0, 1.08, 0.02);
  bone('head', spine, new Vector3(0, 1.65, -0.02), spineAt);
  for (const [s, side] of [[1, 'l'], [-1, 'r']] as const) {
    const hip = new Vector3(s * 0.1, 0.98, 0), knee = new Vector3(s * 0.1, 0.53, 0), ankle = new Vector3(s * 0.1, 0.09, 0);
    const thigh = bone(`thigh_${side}`, pelvis, hip, new Vector3(0, 1.0, 0));
    const calf = bone(`calf_${side}`, thigh, knee, hip);
    const foot = bone(`foot_${side}`, calf, ankle, knee);
    bone(`ball_${side}`, foot, new Vector3(s * 0.1, 0.025, 0.13), ankle);
    const sh = new Vector3(s * 0.19, 1.45, -0.02), el = new Vector3(s * 0.21, 1.19, -0.02), wr = new Vector3(s * 0.22, 0.93, 0.0);
    const up = bone(`upperarm_${side}`, spine, sh, spineAt);
    const lo = bone(`lowerarm_${side}`, up, el, sh);
    const hand = bone(`hand_${side}`, lo, wr, el);
    // finger chains: knuckle, middle, tip joints (the thumb forward of the palm)
    const chains: [string, number, number][] = [['index', -0.02, 0.03], ['middle', 0.0, 0.01], ['ring', 0.01, -0.01], ['pinky', 0.015, -0.03], ['thumb', -0.03, 0.05]];
    for (const [f, dx, dz] of chains) {
      let parent: Bone = hand, from = wr;
      for (let k = 1; k <= 3; k++) {
        const at = f === 'thumb' ? new Vector3(s * (0.2 + dx * 0), 0.9 - 0.025 * k, 0.03 + 0.02 * k) : new Vector3(s * (0.225 + dx), 0.85 - 0.03 * (k - 1), dz);
        parent = bone(`${f}_0${k}_${side}`, parent, at, from);
        from = at;
      }
    }
  }
  return root;
}

describe('character model', () => {
  test('proportions come from the bones', () => {
    const p = proportionsOf(fakeRig());
    expect(p.hip.y).toBeCloseTo(0.98);
    expect(p.knee.y).toBeCloseTo(0.53);
    expect(p.contact.z).toBeCloseTo(0.13);
    expect(p.shoulder.x).toBeCloseTo(0.19);
  });

  test('riding: the model bones follow the IK (balls of the feet on the pedals, palms at the grips)', () => {
    const scene = new Scene();
    const f = new PlayerFigure(scene);
    const bike = new Group();
    bike.rotation.set(0, 0.7, 0.15);
    scene.add(bike);
    bike.add(f.group);
    f.setModel(fakeRig());
    const p = pedals(0.8);
    f.ride(seat, grips, p, 'upright');
    f.group.updateMatrixWorld(true);
    const at = (name: string) => bike.worldToLocal(f.group.getObjectByName(name)!.getWorldPosition(new Vector3()));
    for (const [i, side] of [[0, 'l'], [1, 'r']] as const) {
      expect(at(`ball_${side}`).distanceTo(p[i])).toBeLessThan(0.02);
      expect(at(`ball_${side}`).distanceTo(f.foot(i))).toBeLessThan(0.005);
      const palm = at(`hand_${side}`).lerp(at(`middle_01_${side}`), 0.6);
      expect(palm.distanceTo(f.hand(i))).toBeLessThan(0.005);
      expect(palm.distanceTo(grips[i])).toBeLessThan(0.05);
      // the hand lies on the bar: knuckles forward of the wrist, palm above the grip, fingertips curled down
      expect(at(`middle_01_${side}`).z).toBeGreaterThan(at(`hand_${side}`).z + 0.03);
      expect(palm.y).toBeGreaterThan(grips[i].y);
      expect(at(`middle_03_${side}`).y).toBeLessThan(at(`middle_01_${side}`).y);
    }
  });

  test('walking: switching models keeps the feet on the ground', () => {
    const f = new PlayerFigure(new Scene());
    f.setModel(fakeRig());
    f.update(0, 0, 0, { x: 0, y: 0, z: 0 }, 0.016);
    f.group.updateMatrixWorld(true);
    expect(f.group.getObjectByName('ball_l')!.getWorldPosition(new Vector3()).y).toBeCloseTo(0.025, 2);
    f.setModel(null);
    expect(f.group.getObjectByName('ball_l')).toBeUndefined();
  });
});

describe('walking and running', () => {
  for (const [what, speed] of [['walking', 1.6], ['running', 5.5]] as const) {
    test(`${what}: a stance foot stays on the ground, nothing sinks into it`, () => {
      const f = new PlayerFigure(new Scene());
      f.setModel(fakeRig());
      let lowest = Infinity, highest = -Infinity;
      for (let n = 0; n < 240; n++) {
        f.update(0, 0, 0, { x: 0, y: 0, z: speed }, 1 / 60);
        if (n < 60) continue; // gait blending in
        f.group.updateMatrixWorld(true);
        const y = Math.min(...['ball_l', 'ball_r'].map((b) => f.group.getObjectByName(b)!.getWorldPosition(new Vector3()).y));
        lowest = Math.min(lowest, y);
        highest = Math.max(highest, y);
      }
      expect(lowest).toBeGreaterThan(0.025 - 0.02);
      // walking: always a foot down (the trailing toes may lift a little at push-off); running: flight phases
      expect(highest).toBeLessThan(what === 'walking' ? 0.06 : 0.2);
    });
  }

  test('running up stairs (steep climb, still on the ground) keeps the gait; only airborne tucks the legs', () => {
    const swing = (airborne: boolean) => {
      const f = new PlayerFigure(new Scene());
      let lo = Infinity, hi = -Infinity;
      for (let n = 0; n < 120; n++) {
        // the controller steps up the stairs: big vertical speed spikes while grounded
        f.update(0, 0, 0, { x: 0, y: n % 6 === 0 ? 10 : 2.5, z: 5.5 }, 1 / 60, airborne);
        if (n < 60) continue;
        const a = f.group.children[0]!.children[0]!.rotation.x; // left leg (body → first leg)
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      return hi - lo;
    };
    expect(swing(false)).toBeGreaterThan(0.5);
    expect(swing(true)).toBeLessThan(0.1);
  });

  test('running bends the knee further in swing than walking, both feet are off between the steps', () => {
    const peak = (run: number) => Math.max(...Array.from({ length: 100 }, (_, k) => gaitPose(k / 100, run).knee));
    expect(peak(1)).toBeGreaterThan(peak(0) + 0.2);
    expect(gaitPose(0.2, 1).stance).toBe(true);
    expect(gaitPose(0.45, 1).stance).toBe(false);
    expect(gaitPose(0.45, 0).stance).toBe(true);
  });
});
