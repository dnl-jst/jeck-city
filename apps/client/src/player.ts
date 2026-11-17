import { BoxGeometry, type Bone, type BufferGeometry, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, type Object3D, Quaternion, SphereGeometry, Vector3, type Scene } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TUNING } from '@nn/shared';
import type { RagdollWorld } from './ragdoll';

/** Shortest signed angle from a to b (rad). */
export const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Seconds to tip over and to get up. */
const FALL = 0.35;
const GET_UP = 0.5;
/** Knocked down by a car: seconds to fall over backwards and to get up again (setDown). */
export const DOWN_IN_S = 0.25, DOWN_OUT_S = 0.3;

/**
 * The ragdoll's centre of mass follows the sim's position (the thrown ball the camera follows, or the streamed
 * position of another player): a stiff spring and damper towards it and its velocity (1/s², 1/s), the same
 * acceleration on every part so the body moves as one and only arms, legs and the turning are left to the joints.
 * TRACK_Y: the centre of mass above the sim's feet position; TRACK_MAX: the most acceleration (m/s²) it applies.
 */
const TRACK_K = 50, TRACK_C = 14, TRACK_Y = 0.2, TRACK_MAX = 80;

/**
 * A get-up keyframe in the frame of the spot the figure will stand on (feet at the origin, facing +z): hip joint
 * height and forward offset (m, for 0.92 m hips; scaled to the model), pelvis pitch (+ forward), torso and head pitch,
 * hip flexion and knee bend per leg, arm raise (forward) per arm, arms out to the side, elbow bend.
 */
type Key = { t: number; hy: number; hz: number; p: number; torso: number; head: number; hip: [number, number]; knee: [number, number]; arm: [number, number]; out: number; elbow: number };
/** Squatting on both feet, arms forward for balance; then standing. */
const SQUAT: Omit<Key, 't'> = { hy: 0.56, hz: -0.28, p: 0.6, torso: 0.15, head: -0.35, hip: [1.95, 1.8], knee: [1.75, 1.6], arm: [0.7, 0.5], out: 0.12, elbow: 0.6 };
const STAND: Omit<Key, 't'> = { hy: 0.92, hz: 0, p: 0, torso: 0, head: 0, hip: [0, 0], knee: [0, 0], arm: [0, 0], out: 0.05, elbow: 0.15 };
/** Face down (head towards +z): hands under the shoulders, push up, onto hands and knees, squat, stand. */
const GET_UP_PRONE: Key[] = [
  { t: 0, hy: 0.17, hz: 0.45, p: 1.25, torso: 0, head: -0.5, hip: [-0.2, -0.2], knee: [0.15, 0.1], arm: [0.25, 0.25], out: 0.5, elbow: 1.6 },
  { t: 0.35, hy: 0.38, hz: 0.3, p: 1.25, torso: 0.1, head: -0.55, hip: [0.7, 0.5], knee: [1.1, 0.9], arm: [1.25, 1.25], out: 0.2, elbow: 0.25 },
  { t: 0.7, hy: 0.5, hz: 0, p: 1.4, torso: 0.05, head: -0.6, hip: [1.5, 1.45], knee: [1.55, 1.55], arm: [1.45, 1.45], out: 0.1, elbow: 0.05 },
  { t: 1.15, ...SQUAT },
  { t: 1.65, ...STAND },
];
/** Face up (head towards −z): sit up leaning on the hands, knees drawn up, rock forward into a squat, stand. */
const GET_UP_SUPINE: Key[] = [
  { t: 0, hy: 0.13, hz: -0.55, p: -1.5, torso: 0, head: 0.35, hip: [0.1, 0.15], knee: [0.2, 0.3], arm: [0.2, 0.2], out: 0.3, elbow: 0.3 },
  { t: 0.5, hy: 0.14, hz: -0.5, p: -0.35, torso: 0.4, head: 0.1, hip: [2.1, 1.7], knee: [2.2, 1.6], arm: [-0.55, -0.45], out: 0.25, elbow: 0.1 },
  { t: 1.1, ...SQUAT },
  { t: 1.6, ...STAND },
];
/** Seconds to blend from the ragdoll's last pose into the first get-up keyframe. */
const RISE_BLEND = 0.3;
/** Least height (m) of every joint above the ground while getting up. */
const RISE_CLEAR = 0.03;
/** The longest get-up (blend and keyframes): the ragdoll lies until this long before the sim lets the player go. */
export const RISE_S = RISE_BLEND + Math.max(GET_UP_PRONE.at(-1)!.t, GET_UP_SUPINE.at(-1)!.t);
/**
 * Joint motors (acceleration-based stiffness, damping) towards the standing rest pose: a little muscle tone, so the
 * body neither folds like cloth nor stays stiff. Knees are hinges with limits.
 */
const TONE = { spine: [40, 6], neck: [25, 3], hip: [8, 1.5], shoulder: [3, 0.8], elbow: [4, 0.8], knee: [3, 0.8] } as const;
/**
 * How far the ball joints turn (rad, about the parent's x, y, z; sign conventions of update(): + x bends the torso and
 * head forward, − x swings a thigh or an arm forward and bends an elbow), so a body lying still is not crumpled.
 * Sideways (z) ranges are for the left side (+x); the right side mirrors them.
 */
type Range = readonly [number, number];
const RANGE: Record<'spine' | 'neck' | 'hip' | 'shoulder' | 'elbow', readonly [Range, Range, Range]> = {
  spine: [[-0.5, 1.5], [-0.6, 0.6], [-0.45, 0.45]],
  neck: [[-0.8, 0.9], [-1.1, 1.1], [-0.5, 0.5]],
  hip: [[-2.3, 0.5], [-0.6, 0.6], [-0.3, 0.9]],
  shoulder: [[-3.0, 1.0], [-1.3, 1.3], [-0.5, 2.8]],
  elbow: [[-2.6, -0.05], [-1.3, 1.3], [-0.4, 0.4]],
};
/** Knee hinge range (rad, flexion positive about the shin's x axis). */
const KNEE_MIN = -0.02, KNEE_MAX = 2.5;

type Vec3 = { x: number; y: number; z: number };
/**
 * Ragdoll parts (body, torso, head, thighs, shins, upper arms, forearms) and the part each hangs from: torso and
 * thighs from the pelvis, head and upper arms from the torso, shins from the thighs, forearms from the upper arms.
 */
const RAG_PARENT = [-1, 0, 1, 0, 0, 3, 4, 1, 1, 7, 8];

export type Posture = 'upright' | 'sport' | 'race';
/** Upper-body pitch on the bike (rad, forward): Dutch/cargo upright, MTB sport, road race. */
const POSTURE_PITCH: Record<Posture, number> = { upright: 0.17, sport: 0.52, race: 0.87 };

/** How much further than its posture a rider may lean to reach the bar (rad). */
const MAX_EXTRA_PITCH = 0.6;
/** Fraction of the full arm length the hands may be from the shoulders on the bar (elbows stay a little bent). */
const REACH = 0.97;
/** Riding: the head tilts back by this share of the torso pitch, so the rider looks ahead. */
const HEAD_LOOK = 0.75;
/** Riding: share of the handlebar's turn the shoulders follow. */
const STEER_TORSO = 0.35;

const smooth = (t: number) => t * t * (3 - 2 * t);
/** The heel's sole point lies this far behind the ankle (m). */
const HEEL_BACK = -0.06;
/** Least height of a swinging foot above the ground (m). */
const SWING_CLEAR = 0.008;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Speeds (m/s) up to which the figure walks, and from which it fully runs (TUNING.character: walk 1.6, run 5.5). */
const WALK_TOP = 2.0;
const RUN_FULL = 4.5;
/** Ground covered per gait cycle (two steps, m): walking, running. */
const CYCLE_WALK = 1.6;
const CYCLE_RUN = 2.9;

/**
 * Joint angles of one leg at gait-cycle fraction t (0 = heel strike), blended between walking (run 0) and running
 * (run 1): hip flexion (+ = thigh forward), knee flexion, ankle (+ = toes down), and whether the foot is on the ground.
 * Walking: 60 % stance, the knee bends ~65° in swing; running: 38 % stance (so both feet are off in between), cushioning
 * knee in stance, a moderate heel kick and knee drive in swing.
 */
export function gaitPose(t: number, run: number): { hip: number; knee: number; ankle: number; stance: boolean } {
  const S = mix(0.6, 0.38, run);
  const front = mix(0.42, 0.42, run), back = mix(0.3, 0.24, run);
  if (t < S) {
    const u = t / S;
    // the thigh sweeps back under the body; the knee gives at loading and again before push-off
    const hip = mix(front, -back, u * (0.85 + 0.15 * u));
    const knee = mix(mix(0.14, 0.06, clamp01(u / 0.3)) + 0.14 * Math.sin(Math.PI * clamp01(u / 0.55)) + 0.45 * smooth(clamp01((u - 0.72) / 0.28)),
      0.25 + 0.4 * Math.sin(Math.PI * u), run);
    const ankle = mix(
      u < 0.15 ? mix(-0.12, 0, u / 0.15) : u < 0.7 ? mix(0, -0.14, (u - 0.15) / 0.55) : mix(-0.14, 0.38, smooth((u - 0.7) / 0.3)),
      u < 0.3 ? mix(0.05, -0.2, u / 0.3) : mix(-0.2, 0.4, smooth((u - 0.3) / 0.7)), run);
    return { hip, knee, ankle, stance: true };
  }
  const u = (t - S) / (1 - S);
  // swing: the thigh comes through (running: well above the stance angle, then reaching for the next step)
  const hip = mix(-back, front, smooth(clamp01(u / 0.85))) + mix(0.04, 0.2, run) * Math.sin(Math.PI * clamp01(u / 0.9));
  const kneeOff = mix(0.53, 0.6, run);
  // the knee stays a little bent when the foot reaches the ground (as stance starts)
  const kneeEnd = mix(0.14, 0.25, run);
  const knee = (1 - u) * kneeOff * (1 - u) + u * u * kneeEnd + mix(0.95, 1.3, run) * Math.sin(Math.PI * Math.pow(u, mix(0.9, 0.8, run)));
  const ankle = mix(mix(0.38, 0.5, run), mix(-0.1, 0.05, run), smooth(clamp01(u / 0.45)));
  return { hip, knee, ankle, stance: false };
}

/** Running flight: progress 0 → 1 between toe-off of one foot and touch-down of the other (0 outside a flight). */
function flight(t: number, run: number): number {
  const S = mix(0.6, 0.38, run);
  const f = (t % 0.5);
  return S < 0.5 && f >= S ? (f - S) / (0.5 - S) : 0;
}

/** Palm centre relative to the grip axis: on top of the bar (bar radius + half the hand's thickness). */
const GRIP_PALM = new Vector3(0, 0.028, -0.008);
/** Share of the hand's twist about the forearm that the forearm takes (pronation), the wrist the rest. */
const FOREARM_TWIST = 0.75;

/**
 * Rotation (figure rest frame → bike frame) that puts hand s (+1 left) on a grip: the wrist → knuckle axis forward and
 * a little out and down, the palm facing down and slightly in.
 */
function gripRotation(s: number, knuckleAxis: Vector3): Quaternion {
  // rest basis: a = towards the knuckles, b = palm normal (the hanging palm faces the body: −s·x)
  const a0 = knuckleAxis.clone().normalize();
  const b0 = new Vector3(-s, 0, 0).sub(a0.clone().multiplyScalar(-s * a0.x)).normalize();
  // target basis
  const a1 = new Vector3(s * 0.12, -0.3, 1).normalize();
  const b1 = new Vector3(-s * 0.2, -1, 0).sub(a1.clone().multiplyScalar(a1.dot(new Vector3(-s * 0.2, -1, 0)))).normalize();
  const m0 = new Matrix4().makeBasis(a0, b0, a0.clone().cross(b0));
  const m1 = new Matrix4().makeBasis(a1, b1, a1.clone().cross(b1));
  return new Quaternion().setFromRotationMatrix(m1.multiply(m0.transpose()));
}

/**
 * Joint layout of a figure in its own frame (y up, +z forward, +x = the figure's left; feet on y = 0), left side;
 * the right side mirrors x. `contact` is the ball of the foot (what goes on the pedal), `palm` the middle of the hand;
 * `fingers` the joints (01, 02, 03) of each finger bone chain the model has.
 */
export interface Proportions {
  hip: Vector3;
  knee: Vector3;
  ankle: Vector3;
  contact: Vector3;
  torso: Vector3;
  head: Vector3;
  shoulder: Vector3;
  elbow: Vector3;
  wrist: Vector3;
  palm: Vector3;
  fingers: Partial<Record<Finger, Vector3[]>>;
}

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];

/** The primitive stand-in figure (1.8 m) and the layout used until a model is attached. */
export const DEFAULT_PROPORTIONS: Proportions = {
  hip: new Vector3(0.11, 0.92, 0),
  knee: new Vector3(0.11, 0.47, 0),
  ankle: new Vector3(0.11, 0.08, 0),
  contact: new Vector3(0.11, 0.02, 0.05),
  torso: new Vector3(0, 0.92, 0),
  head: new Vector3(0, 1.55, 0),
  shoulder: new Vector3(0.27, 1.47, 0),
  elbow: new Vector3(0.27, 1.18, 0),
  wrist: new Vector3(0.27, 0.92, 0),
  palm: new Vector3(0.27, 0.86, 0),
  fingers: {},
};

/** Bones of MPFB's game_engine rig the figure drives (data/models/character/README.md). */
const BONE = {
  body: 'pelvis', torso: 'spine_01', head: 'head',
  legs: ['thigh_l', 'thigh_r'], shins: ['calf_l', 'calf_r'], feet: ['foot_l', 'foot_r'], arms: ['upperarm_l', 'upperarm_r'], forearms: ['lowerarm_l', 'lowerarm_r'],
  hands: ['hand_l', 'hand_r'],
} as const;

/** Joint layout of a character model, read from its rest-pose bones (model frame = figure frame). */
export function proportionsOf(model: Object3D): Proportions {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const at = (name: string) => {
    const b = model.getObjectByName(name);
    if (!b) throw new Error(`character model lacks bone ${name}`);
    return b.getWorldPosition(new Vector3()).applyMatrix4(inv);
  };
  const fingers: Proportions['fingers'] = {};
  for (const f of FINGERS) {
    const names = [1, 2, 3].map((k) => `${f}_0${k}_l`);
    if (names.every((n) => model.getObjectByName(n))) fingers[f] = names.map(at);
  }
  const hip = at('thigh_l');
  const knee = at('calf_l');
  const ball = at('ball_l');
  const wrist = at('hand_l');
  return {
    hip, knee,
    ankle: at('foot_l').setX(knee.x),
    contact: new Vector3(knee.x, ball.y, ball.z),
    torso: at('spine_01').setX(0),
    head: at('head').setX(0),
    shoulder: at('upperarm_l'),
    elbow: at('lowerarm_l'),
    wrist: wrist.clone(),
    palm: wrist.clone().lerp(at('middle_01_l'), 0.6),
    fingers,
  };
}

const mirror = (v: Vector3, s: number) => new Vector3(v.x * s, v.y, v.z);

/**
 * The player's figure, feet at the group origin, facing local +z. A skeleton of groups (body, legs/shins, torso with
 * head and arms/forearms) carries the animation: walking swings arms and legs with the distance walked, riding solves
 * legs and arms onto pedals and grips, a fall tips it over. Shown either as a primitive stand-in or, after
 * setModel(), as a skinned character model whose bones follow that skeleton.
 */
export class PlayerFigure {
  readonly group = new Group();
  /** Facing (heading convention, forward = (sin h, cos h)); turns smoothly towards the walking direction. */
  heading = 0;
  private phase = 0;
  private swingAmp = 0;
  /** 0 walking … 1 running (smoothed). */
  private run = 0;
  /** Pelvis drop (m) when the last foot left the ground (running flight starts from there). */
  private lastGround = 0;
  /** 0 standing on ground … 1 in the air (smoothed, so a one-step kerb climb does not flicker). */
  private air = 0;
  private p: Proportions = DEFAULT_PROPORTIONS;
  private readonly legs: Group[] = [];
  /** Knee joints (children of the legs) and ankles (children of the shins). */
  private readonly shins: Group[] = [];
  private readonly feet: Group[] = [];
  private readonly arms: Group[] = [];
  /** Elbow joints (children of the arms). */
  private readonly forearms: Group[] = [];
  /** Wrists (children of the forearms) and the finger joints of each hand (chains of three, per finger). */
  private readonly hands: Group[] = [];
  private fingerNodes: Map<Finger, Group[]>[] = [new Map(), new Map()];
  private readonly body = new Group();
  /** Upper body, pivoting at the lower spine: head, arms. */
  private readonly torso = new Group();
  private readonly headNode = new Group();
  /** Fall: seconds since it started, or −1; `up` = the get-up phase started at that time. */
  private fallT = -1;
  private upAt = Infinity;
  private model: SkinnedModel | null = null;
  /** Knocked down (setDown): target (0 standing … 1 lying) and the smoothed amount. */
  private downTarget = 0;
  private down = 0;
  /** Ragdoll (ragdoll()): its parts (body per skeleton group), seconds since it started, when it gets up. */
  private rag: {
    world: RagdollWorld; parts: { node: Object3D; body: RAPIER.RigidBody }[]; t: number; upAt: number;
    /** The sim position last frame and its velocity (smoothed), to track. */
    last: Vector3 | null; vel: Vector3;
  } | null = null;
  /** Getting up from the ragdoll: from its last pose to standing at the sim's position, over RISE_S. */
  private rise: { t: number; pos: Vector3; q: Quaternion; locals: Quaternion[]; heading: number; keys: Key[]; from: Vector3 } | null = null;

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < 2; i++) {
      const leg = new Group(), shin = new Group(), arm = new Group(), forearm = new Group(), hand = new Group();
      const foot = new Group();
      leg.add(shin);
      shin.add(foot);
      this.feet.push(foot);
      arm.add(forearm);
      forearm.add(hand);
      this.hands.push(hand);
      this.legs.push(leg);
      this.shins.push(shin);
      this.arms.push(arm);
      this.forearms.push(forearm);
      this.body.add(leg);
      this.torso.add(arm);
    }
    this.torso.add(this.headNode);
    this.body.add(this.torso);
    this.group.add(this.body);
    this.layout(DEFAULT_PROPORTIONS);
    this.buildStandIn();
    scene.add(this.group);
  }

  /** Shows a character model (a template; it is cloned) instead of the stand-in; null = back to the stand-in. */
  setModel(template: Object3D | null): void {
    if (this.model) {
      this.group.remove(this.model.root);
      this.model = null;
    }
    this.group.traverse((o) => { if (o.userData.standIn) o.visible = !template; });
    if (!template) {
      this.layout(DEFAULT_PROPORTIONS);
      return;
    }
    const root = cloneSkinned(template);
    this.layout(proportionsOf(root));
    this.model = new SkinnedModel(root, this.drivers());
    this.group.add(root);
    this.model.apply();
  }

  private drivers(): [Object3D, string][] {
    return [
      [this.body, BONE.body], [this.torso, BONE.torso], [this.headNode, BONE.head],
      ...[0, 1].flatMap((i): [Object3D, string][] => [
        [this.legs[i]!, BONE.legs[i]!], [this.shins[i]!, BONE.shins[i]!], [this.feet[i]!, BONE.feet[i]!], [this.arms[i]!, BONE.arms[i]!], [this.forearms[i]!, BONE.forearms[i]!],
        [this.hands[i]!, BONE.hands[i]!],
        ...[...this.fingerNodes[i]!].flatMap(([f, nodes]) => nodes.map((n, k): [Object3D, string] => [n, `${f}_0${k + 1}_${i === 0 ? 'l' : 'r'}`])),
      ]),
    ];
  }

  /** Places the skeleton's joints for proportions p (all rotations reset). */
  private layout(p: Proportions): void {
    this.p = p;
    for (const o of [this.body, this.torso, this.headNode, ...this.legs, ...this.shins, ...this.feet, ...this.arms, ...this.forearms, ...this.hands]) o.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.torso.position.copy(p.torso);
    this.headNode.position.copy(p.head).sub(p.torso);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      this.legs[i]!.position.copy(mirror(p.hip, s));
      this.shins[i]!.position.copy(mirror(p.knee, s).sub(mirror(p.hip, s)));
      this.feet[i]!.position.copy(mirror(p.ankle, s).sub(mirror(p.knee, s)));
      this.arms[i]!.position.copy(mirror(p.shoulder, s).sub(p.torso));
      this.forearms[i]!.position.copy(mirror(p.elbow, s).sub(mirror(p.shoulder, s)));
      this.hands[i]!.position.copy(mirror(p.wrist, s).sub(mirror(p.elbow, s)));
      // finger chains: first joint under the wrist, the others under their predecessor
      for (const nodes of this.fingerNodes[i]!.values()) for (const n of nodes) n.removeFromParent();
      const chains = new Map<Finger, Group[]>();
      for (const f of FINGERS) {
        const joints = p.fingers[f];
        if (!joints) continue;
        let parent: Group = this.hands[i]!, from = mirror(p.wrist, s);
        const nodes = joints.map((j) => {
          const n = new Group();
          n.position.copy(mirror(j, s).sub(from));
          parent.add(n);
          parent = n;
          from = mirror(j, s);
          return n;
        });
        chains.set(f, nodes);
      }
      this.fingerNodes[i] = chains;
    }
  }

  /**
   * Curls the fingers of hand i (rad per joint, base → tip): about the axis that brings each finger towards the palm.
   * grip 0 = relaxed, 1 = closed round a handlebar.
   */
  private curlFingers(i: number, grip: number): void {
    const s = i === 0 ? 1 : -1, p = this.p;
    const palmIn = new Vector3(-s, 0, 0); // the hanging hand's palm faces the body
    for (const [f, nodes] of this.fingerNodes[i]!) {
      const joints = p.fingers[f]!.map((j) => mirror(j, s));
      const curl = f === 'thumb' ? [0.15 + 0.45 * grip, 0.1 + 0.4 * grip, 0.1 + 0.5 * grip] : [0.25 + 1.15 * grip, 0.3 + 1.1 * grip, 0.2 + 0.8 * grip];
      const index = p.fingers.index?.[1] ? mirror(p.fingers.index[1], s) : null;
      nodes.forEach((n, k) => {
        const tip = k < 2 ? joints[k + 1]! : joints[k]!.clone().add(joints[k]!.clone().sub(joints[k - 1]!));
        const dir = tip.clone().sub(joints[k]!).normalize();
        // the fingers fold into the palm; the thumb turns towards the middle of the index finger and lies over it
        const towards = f === 'thumb' && index ? index.clone().sub(joints[k]!).normalize() : palmIn;
        const axis = dir.clone().cross(towards);
        if (axis.lengthSq() < 1e-8) return;
        // joint rotations are relative to the parent joint: the rest axes are the same (identity rest), so each
        // joint just turns about its own axis
        n.quaternion.setFromAxisAngle(axis.normalize(), curl[k]!);
      });
    }
  }

  /** Thigh, shin (knee → ball of foot), upper arm, forearm (elbow → wrist) and hand (wrist → palm) of side i as rest vectors. */
  private segs(i: number) {
    const s = i === 0 ? 1 : -1, p = this.p;
    return {
      thigh: mirror(p.knee, s).sub(mirror(p.hip, s)),
      shin: mirror(p.contact, s).sub(mirror(p.knee, s)),
      upper: mirror(p.elbow, s).sub(mirror(p.shoulder, s)),
      fore: mirror(p.wrist, s).sub(mirror(p.elbow, s)),
      palm: mirror(p.palm, s).sub(mirror(p.wrist, s)),
    };
  }

  /** The primitive stand-in: boxes on the skeleton groups (userData.standIn; hidden while a model is shown). */
  private buildStandIn(): void {
    const mat = (color: number, roughness = 0.85) => new MeshStandardMaterial({ color, roughness });
    const jacket = mat(0x2f6168), jeans = mat(0x2b3a55), skin = mat(0xdcae8a, 0.7), shoe = mat(0x1d1b1a, 0.6), hair = mat(0x3a2a20);
    const part = (g: BufferGeometry, m: MeshStandardMaterial, parent: Object3D) => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = true;
      mesh.userData.standIn = true;
      parent.add(mesh);
      return mesh;
    };
    const p = DEFAULT_PROPORTIONS, thigh = p.hip.y - p.knee.y, shin = p.knee.y - p.contact.y;
    for (let i = 0; i < 2; i++) {
      part(new BoxGeometry(0.16, thigh + 0.02, 0.18).translate(0, -thigh / 2, 0), jeans, this.legs[i]!);
      part(new BoxGeometry(0.15, shin, 0.17).translate(0, -shin / 2, 0), jeans, this.shins[i]!);
      part(new BoxGeometry(0.15, 0.08, 0.28).translate(0, -shin - 0.01, 0.05), shoe, this.shins[i]!);
      part(new BoxGeometry(0.11, 0.3, 0.13).translate(0, -0.15, 0), jacket, this.arms[i]!);
      part(new BoxGeometry(0.1, 0.26, 0.12).translate(0, -0.13, 0), jacket, this.forearms[i]!);
      part(new BoxGeometry(0.09, 0.1, 0.1).translate(0, p.palm.y - p.wrist.y, 0), skin, this.hands[i]!);
    }
    part(new BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.21 - p.torso.y, 0), jacket, this.torso);
    part(new BoxGeometry(0.14, 0.08, 0.14).translate(0, 1.54 - p.head.y, 0), skin, this.headNode); // neck
    part(new SphereGeometry(0.125, 12, 9).scale(0.92, 1.05, 1).translate(0, 1.67 - p.head.y, 0.005), skin, this.headNode);
    // hair: a cap tilted backwards, so it covers the top and the back of the head but leaves the face
    part(new SphereGeometry(0.135, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.6).rotateX(-0.55).scale(0.95, 1, 1.02).translate(0, 1.68 - p.head.y, -0.015), hair, this.headNode);
  }

  /**
   * Places the figure at the feet position and animates it from its velocity v (m/s): facing turns towards
   * the horizontal velocity when moving, arms and legs swing; airborne (jumping, falling: not standing on anything,
   * from the character controller) the legs tuck and the arms lift. Not from v.y: climbing stairs or a steep ramp
   * moves up fast while the feet are on the ground. During a fall (fall()) it tips over, lies, and gets up again.
   */
  update(x: number, y: number, z: number, v: { x: number; y: number; z: number }, dt: number, airborne = false): void {
    if (this.rag) {
      this.tickRagdoll(x, y, z, dt);
      this.model?.apply();
      return;
    }
    if (this.rise) {
      this.tickRise(x, y, z, dt);
      this.model?.apply();
      return;
    }
    this.torso.rotation.set(0, 0, 0);
    this.headNode.rotation.set(0, 0, 0);
    if (this.fallT >= 0) {
      this.tickFall(dt);
      this.group.position.set(x, y, z);
      this.model?.apply();
      return;
    }
    const speed = Math.hypot(v.x, v.z);
    this.air += ((airborne ? 1 : 0) - this.air) * Math.min(1, dt * 8);
    if (speed > 0.2) this.heading += angleDelta(this.heading, Math.atan2(v.x, v.z)) * Math.min(1, dt * 12);
    const k = Math.min(1, dt * 6);
    // amp: 0 standing … 1 walking; run: 0 walking … 1 running (both smoothed, so gaits blend)
    this.swingAmp += (Math.min(1, speed / 1.2) - this.swingAmp) * k;
    this.run += (Math.min(1, Math.max(0, (speed - WALK_TOP) / (RUN_FULL - WALK_TOP))) - this.run) * k;
    // knocked over (backwards, the whole figure about its feet): DOWN_IN_S down, DOWN_OUT_S back up
    const dk = this.downTarget - this.down;
    this.down += Math.sign(dk) * Math.min(Math.abs(dk), dt / (dk > 0 ? DOWN_IN_S : DOWN_OUT_S));
    const lie = this.down;
    const amp = this.swingAmp * (1 - this.air) * (1 - lie), run = this.run, air = this.air * (1 - lie);
    // one cycle = two steps; it covers more ground per cycle when running
    this.phase = (this.phase + (speed * dt * 2 * Math.PI) / (CYCLE_WALK + (CYCLE_RUN - CYCLE_WALK) * run)) % (2 * Math.PI);
    const t0 = this.phase / (2 * Math.PI);
    const poses = [gaitPose(t0, run), gaitPose((t0 + 0.5) % 1, run)];
    for (let i = 0; i < 2; i++) {
      const g = poses[i]!;
      // the feet land nearer the midline than the hips are apart (more so running)
      this.legs[i]!.rotation.set(-(g.hip * amp + (i === 0 ? 0.55 : 0.3) * air), 0, -(i === 0 ? 1 : -1) * (0.04 + 0.03 * run) * amp);
      this.shins[i]!.rotation.set(g.knee * amp + (i === 0 ? 0.6 : 0.3) * air, 0, 0);
      this.feet[i]!.rotation.set(g.ankle * amp + 0.25 * air, 0, 0);
    }
    // pelvis: twists with the swinging leg, drops on the swing side, sways over the stance foot
    const yaw = (0.07 + 0.06 * run) * amp * Math.sin(this.phase);
    const roll = 0.035 * amp * Math.cos(2 * this.phase);
    const sway = 0.02 * amp * (1 - run) * Math.sin(this.phase);
    this.body.position.set(sway, 0, 0);
    this.body.rotation.set(0.04 * run * amp, yaw, roll, 'YXZ');
    // the pelvis sits so that the lower stance foot (ball or heel) is on the ground; in a running flight it rises and
    // falls between the steps
    let ground = -Infinity;
    for (let i = 0; i < 2; i++) if (poses[i]!.stance) ground = Math.max(ground, this.footDrop(i));
    if (ground === -Infinity) ground = this.lastGround + 0.06 * run * Math.sin(Math.PI * flight(t0, run));
    else this.lastGround = ground;
    // a swinging foot reaching for the next step never dips into the ground
    for (let i = 0; i < 2; i++) if (!poses[i]!.stance) ground = Math.max(ground, this.footDrop(i) - SWING_CLEAR);
    this.body.position.y = ground;
    // upper body: counter-twists, leans into the run, bobs a little with each step
    const lean = (0.03 + 0.17 * run) * amp;
    this.torso.rotation.set(lean + 0.02 * amp * Math.cos(2 * this.phase), -yaw * 1.8, -roll * 0.6, 'YXZ');
    // the head looks ahead: takes back the twist and most of the lean
    this.headNode.rotation.set(-lean * 0.8, yaw * 0.8, 0, 'YXZ');
    // arms swing with the opposite leg; running: elbows at about 90°, fists, the swing crosses a little in front
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      // the shoulder swings less forward than back (running: about +20° / −20° against the leaning torso)
      const h = poses[1 - i]!.hip;
      const swing = (h > 0 ? h * mix(0.8, 0.45, run) : h * mix(0.9, 1.1, run)) * amp;
      const fwd = Math.max(0, swing);
      this.arms[i]!.quaternion.setFromEuler(new Euler(-swing - 0.5 * air, -s * 0.3 * run * fwd, s * (0.05 + 0.06 * run + 0.5 * air), 'YXZ'));
      // elbows: slightly bent walking (a bit more on the forward swing), about 60° running, a little more in front
      const elbow = mix(0.15 + 0.4 * fwd, 1.05 + 0.3 * swing, run) * amp + 0.15 * (1 - amp) + 0.4 * air;
      this.forearms[i]!.quaternion.setFromEuler(new Euler(-elbow, 0, 0));
      this.hands[i]!.quaternion.identity();
      this.curlFingers(i, mix(0.3, 0.8, run));
    }
    this.group.position.set(x, y + 0.12 * lie, z);
    this.group.rotation.set(-(Math.PI / 2) * lie, this.heading, 0, 'YXZ');
    this.model?.apply();
  }

  /** Knocked down (1) or standing (0); the whole figure tips over backwards / gets up within DOWN_IN_S / DOWN_OUT_S. */
  setDown(k: number): void {
    this.downTarget = Math.max(0, Math.min(1, k));
  }

  /**
   * Riding pose in the frame of the bike's lean group (the caller parents `group` there): hips on the seat, feet on
   * the pedals (two-bone leg IK), torso pitched for the posture, arms bent at the elbows to the grips.
   */
  ride(seat: Vector3, grips: [Vector3, Vector3], pedals: [Vector3, Vector3], posture: Posture): void {
    this.fallT = -1;
    this.endRagdoll();
    this.rise = null;
    const p = this.p;
    this.group.position.set(seat.x, seat.y - p.hip.y, seat.z);
    this.group.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.torso.rotation.set(POSTURE_PITCH[posture], 0, 0);
    for (let i = 0; i < 2; i++) {
      this.feet[i]!.rotation.set(0, 0, 0);
      this.solveLeg(i, pedals[i]!);
    }
    this.group.updateMatrixWorld(true);
    // a far or low bar: lean further forward (up to MAX_EXTRA_PITCH) until both grips are within arm's reach
    // the hands sit on the grips: palm just above the bar, back of the hand up, knuckles forward; the arm IK aims at the
    // wrist that puts the palm there
    // the bar's turn (from the line between the grips): the hands turn with it and the shoulders follow a little
    const across = grips[0].clone().sub(grips[1]);
    const barYaw = Math.atan2(-across.z, across.x);
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), barYaw);
    const handRot = [0, 1].map((i) => turn.clone().multiply(gripRotation(i === 0 ? 1 : -1, this.fingerAxis(i))));
    const wrists = grips.map((g, i) => g.clone().add(GRIP_PALM).sub(this.segs(i).palm.applyQuaternion(handRot[i]!)));
    const gripsWorld = wrists.map((g) => (this.group.parent ? this.group.parent.localToWorld(g) : g));
    const reach = (i: number) => { const s = this.segs(i); return (s.upper.length() + s.fore.length()) * REACH; };
    const reachOk = () => this.arms.every((a, i) => a.getWorldPosition(new Vector3()).distanceTo(gripsWorld[i]!) <= reach(i));
    for (let extra = 0; extra < MAX_EXTRA_PITCH && !reachOk(); extra += 0.02) {
      this.torso.rotation.x += 0.02;
      this.torso.updateMatrixWorld(true);
    }
    this.torso.rotation.y = STEER_TORSO * barYaw;
    this.headNode.rotation.set(-HEAD_LOOK * this.torso.rotation.x, -STEER_TORSO * barYaw * 0.5, 0);
    for (let i = 0; i < 2; i++) {
      this.solveArm(i, gripsWorld[i]!);
      this.orientHand(i, handRot[i]!);
      this.curlFingers(i, 1);
    }
    this.group.updateMatrixWorld(true);
    this.model?.apply();
  }

  /** How far (m) the lower of ball and heel of foot i is below its rest height (negative: above), body at 0. */
  private footDrop(i: number): number {
    const s = i === 0 ? 1 : -1, p = this.p;
    this.body.updateMatrix();
    const m = new Matrix4();
    for (let o: Object3D = this.feet[i]!; o !== this.group; o = o.parent!) {
      o.updateMatrix();
      m.premultiply(o.matrix);
    }
    const ankle = mirror(p.ankle, s);
    const ball = mirror(p.contact, s).sub(ankle).applyMatrix4(m);
    const heel = new Vector3(0, p.contact.y - p.ankle.y, HEEL_BACK).applyMatrix4(m);
    return p.contact.y - Math.min(ball.y, heel.y);
  }

  /** Rest direction from the wrist to the middle knuckle of hand i (straight down without finger bones). */
  private fingerAxis(i: number): Vector3 {
    const s = i === 0 ? 1 : -1, m = this.p.fingers.middle;
    return m ? mirror(m[0]!, s).sub(mirror(this.p.wrist, s)).normalize() : new Vector3(0, -1, 0);
  }

  /**
   * Turns hand i to `rot` (relative to the figure's rest frame, i.e. in the bike frame the figure hangs in). The
   * forearm takes most of the twist about its own axis (as the radius does), the wrist the rest.
   */
  private orientHand(i: number, rot: Quaternion): void {
    const fore = this.forearms[i]!, hand = this.hands[i]!;
    hand.quaternion.identity();
    this.group.updateMatrixWorld(true);
    const groupQ = this.group.getWorldQuaternion(new Quaternion());
    const want = groupQ.clone().multiply(rot); // hand's world rotation
    const foreQ = fore.getWorldQuaternion(new Quaternion());
    const resid = foreQ.clone().invert().multiply(want); // in the forearm's frame
    // swing-twist: the twist about the forearm axis goes into the forearm
    const axis = this.segs(i).fore.normalize();
    const v = new Vector3(resid.x, resid.y, resid.z);
    const proj = axis.clone().multiplyScalar(v.dot(axis));
    const twist = new Quaternion(proj.x, proj.y, proj.z, resid.w);
    if (twist.lengthSq() > 1e-10) twist.normalize(); else twist.identity();
    const part = new Quaternion().slerp(twist, FOREARM_TWIST);
    fore.quaternion.multiply(part);
    hand.quaternion.copy(part.invert().multiply(resid));
  }

  /** Two-bone IK in the leg's y/z plane: the ball of the foot onto `pedal` (in the group's parent frame). */
  private solveLeg(i: number, pedal: Vector3): void {
    const { thigh, shin } = this.segs(i);
    const hip = this.legs[i]!.position;
    const base = this.group.position;
    const dy = pedal.y - base.y - hip.y, dz = pedal.z - base.z - hip.z;
    const L1 = Math.hypot(thigh.y, thigh.z), L2 = Math.hypot(shin.y, shin.z);
    const D = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-4, Math.hypot(dy, dz)));
    const toward = Math.atan2(dz, -dy); // forward angle of hip → pedal
    const hipBend = Math.acos(Math.min(1, (L1 * L1 + D * D - L2 * L2) / (2 * L1 * D)));
    const kneeIn = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2))));
    // forward angles (about +x, 0 = straight down) of the segments, then rotations relative to their rest angles
    const thighAbs = toward + hipBend;
    const shinAbs = thighAbs - (Math.PI - kneeIn);
    const r1 = Math.atan2(thigh.z, -thigh.y) - thighAbs;
    this.legs[i]!.rotation.set(r1, 0, 0);
    this.shins[i]!.rotation.set(Math.atan2(shin.z, -shin.y) - shinAbs - r1, 0, 0);
  }

  /** Two-bone IK of arm i to `grip` (world), elbow out and down. */
  private solveArm(i: number, grip: Vector3): void {
    const arm = this.arms[i]!, fore = this.forearms[i]!;
    const { upper, fore: lower } = this.segs(i);
    const a = upper.length(), b = lower.length();
    arm.quaternion.identity();
    fore.quaternion.identity();
    this.torso.updateMatrixWorld(true);
    const S = arm.position.clone();
    const T = this.torso.worldToLocal(grip.clone());
    const d = T.clone().sub(S);
    const D = Math.min((a + b) * 0.999, Math.max(Math.abs(a - b) + 1e-3, d.length()));
    const u = d.normalize();
    const alpha = Math.acos(Math.max(-1, Math.min(1, (a * a + D * D - b * b) / (2 * a * D))));
    const pole = new Vector3(i === 0 ? 0.7 : -0.7, -0.6, -0.4);
    const n = pole.sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
    const E = S.clone().add(u.clone().multiplyScalar(a * Math.cos(alpha)).add(n.multiplyScalar(a * Math.sin(alpha))));
    arm.quaternion.setFromUnitVectors(upper.clone().normalize(), E.clone().sub(S).normalize());
    const handAt = S.clone().add(u.multiplyScalar(D));
    const dirLocal = handAt.sub(E).normalize().applyQuaternion(arm.quaternion.clone().invert());
    fore.quaternion.setFromUnitVectors(lower.clone().normalize(), dirLocal);
  }

  /** Tips over in `direction` (heading convention), lies, and gets up after TUNING.bike.getUpSeconds. */
  fall(direction: number): void {
    this.fallT = 0;
    this.upAt = TUNING.bike.getUpSeconds - GET_UP;
    this.group.rotation.set(0, direction, 0);
    this.heading = direction;
    this.legs.forEach((l) => l.rotation.set(0, 0, 0));
    this.shins.forEach((s) => s.rotation.set(0.3, 0, 0));
    this.feet.forEach((f) => f.rotation.set(0.3, 0, 0));
    this.forearms.forEach((f) => f.quaternion.setFromEuler(new Euler(-0.3, 0, 0)));
    this.hands.forEach((h) => h.quaternion.identity());
  }

  /** Standing at once: no fall in progress, not knocked down (a pooled figure handed to another player). */
  reset(): void {
    this.endRagdoll();
    this.rise = null;
    this.fallT = -1;
    this.upAt = Infinity;
    this.down = this.downTarget = 0;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
  }

  /** Starts getting up now (if lying). */
  getUp(): void {
    if (this.fallT >= 0) this.upAt = Math.min(this.upAt, this.fallT);
    if (this.rag) this.rag.upAt = Math.min(this.rag.upAt, this.rag.t);
  }

  /** Falling, lying or getting up: no control. */
  get busy(): boolean {
    return this.fallT >= 0 || !!this.rag || !!this.rise;
  }

  /** A ragdoll is tumbling, or the figure is getting up from one. */
  get ragdolling(): boolean {
    return !!this.rag || !!this.rise;
  }

  /**
   * Goes limp from the current pose (riding or walking, wherever the group hangs) as a ragdoll in `world`: every part
   * starts with velocity v, plus a spin about the horizontal axis across v (spin > 0: head first along v, as over the
   * handlebar; < 0: legs swept away). Gets up after `upSeconds` (the last RISE_S of it getting up) at the position
   * update() is given, which it is drawn towards while lying. A ragdoll already going is left alone.
   */
  ragdoll(world: RagdollWorld, v: Vec3, spin: number, upSeconds: number): void {
    if (this.rag) return;
    this.fallT = -1;
    this.upAt = Infinity;
    this.rise = null;
    this.down = this.downTarget = 0;
    const R = world.R, p = this.p;
    this.group.updateWorldMatrix(true, true);
    const nodes: Object3D[] = [this.body, this.torso, this.headNode, ...this.legs, ...this.shins, ...this.arms, ...this.forearms];
    const pos = nodes.map((n) => n.getWorldPosition(new Vector3()));
    const rot = nodes.map((n) => n.getWorldQuaternion(new Quaternion()));
    // spin about the axis up × v̂, centred on the hips
    const hv = Math.hypot(v.x, v.z);
    const omega = (hv > 1e-3 ? new Vector3(v.z / hv, 0, -v.x / hv) : new Vector3()).multiplyScalar(spin);
    const hips = pos[0]!.clone().add(new Vector3(0, p.hip.y, 0).applyQuaternion(rot[0]!));
    const parts = nodes.map((node, k) => {
      const w = omega.clone().cross(pos[k]!.clone().sub(hips));
      const body = world.addBody(pos[k]!, rot[k]!, { x: v.x + w.x, y: v.y + w.y, z: v.z + w.z });
      body.setAngvel({ x: omega.x, y: omega.y, z: omega.z }, true);
      return { node, body };
    });
    /** A capsule from `from` to `to` (in the body's frame). */
    const capsule = (body: RAPIER.RigidBody, to: Vector3, radius: number, from = new Vector3()) => {
      const d = to.clone().sub(from), len = d.length();
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
      const mid = from.clone().addScaledVector(d, 0.5);
      world.addCollider(R.ColliderDesc.capsule(Math.max(0.01, len / 2 - radius * 0.5), radius).setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), body);
    };
    const [pelvis, torso, head] = parts.map((x) => x.body) as [RAPIER.RigidBody, RAPIER.RigidBody, RAPIER.RigidBody];
    const neck = this.headNode.position.clone();
    world.addCollider(R.ColliderDesc.roundCuboid(p.hip.x + 0.02, 0.07, 0.06, 0.05).setTranslation(0, p.hip.y + 0.02, 0), pelvis);
    world.addCollider(R.ColliderDesc.roundCuboid(Math.max(0.08, p.shoulder.x - 0.13), Math.max(0.05, neck.y / 2 - 0.08), 0.06, 0.05)
      .setTranslation(0, neck.y / 2, 0), torso);
    world.addCollider(R.ColliderDesc.ball(0.11).setTranslation(0, 0.12, 0.01), head);
    const joint = (a: RAPIER.RigidBody, b: RAPIER.RigidBody, anchor: Vector3, tone: readonly [number, number], range: readonly [Range, Range, Range], side = 1) => {
      const j = world.world.createImpulseJoint(R.JointData.spherical(anchor, { x: 0, y: 0, z: 0 }), a, b, true);
      // rapier.js 0.21 reports a spherical joint as generic and wraps it without the motor methods: borrow them
      const S = R.SphericalImpulseJoint.prototype;
      for (const ax of [R.JointAxis.AngX, R.JointAxis.AngY, R.JointAxis.AngZ]) {
        S.configureMotorModel.call(j, ax, R.MotorModel.AccelerationBased);
        S.configureMotorPosition.call(j, ax, 0, tone[0], tone[1]);
      }
      // limits per angular axis (the raw set takes any axis; the generic wrapper has no setter for them)
      const raw = (j as unknown as { rawSet: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).rawSet;
      const [rx, ry, rz] = range;
      raw.jointSetLimits(j.handle, R.JointAxis.AngX, rx[0], rx[1]);
      raw.jointSetLimits(j.handle, R.JointAxis.AngY, ry[0], ry[1]);
      raw.jointSetLimits(j.handle, R.JointAxis.AngZ, side > 0 ? rz[0] : -rz[1], side > 0 ? rz[1] : -rz[0]);
    };
    joint(pelvis, torso, this.torso.position, TONE.spine, RANGE.spine);
    joint(torso, head, neck, TONE.neck, RANGE.neck);
    for (let i = 0; i < 2; i++) {
      const thigh = parts[3 + i]!.body, shin = parts[5 + i]!.body, upper = parts[7 + i]!.body, fore = parts[9 + i]!.body;
      const knee = this.shins[i]!.position, ankle = this.feet[i]!.position, elbow = this.forearms[i]!.position;
      capsule(thigh, knee, 0.075);
      capsule(shin, ankle, 0.06);
      // the foot: a box from the ankle forward to the ball
      world.addCollider(R.ColliderDesc.cuboid(0.045, 0.035, 0.12).setTranslation(ankle.x, ankle.y - 0.03, ankle.z + 0.05), shin);
      capsule(upper, elbow, 0.055);
      capsule(fore, this.hands[i]!.position.clone().add(this.segs(i).palm), 0.045);
      const side = i === 0 ? 1 : -1;
      joint(pelvis, thigh, this.legs[i]!.position, TONE.hip, RANGE.hip, side);
      joint(torso, upper, this.arms[i]!.position, TONE.shoulder, RANGE.shoulder, side);
      joint(upper, fore, elbow, TONE.elbow, RANGE.elbow, side);
      const k = world.world.createImpulseJoint(R.JointData.revolute(knee, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), thigh, shin, true) as RAPIER.RevoluteImpulseJoint;
      k.setLimits(KNEE_MIN, KNEE_MAX);
      k.configureMotorModel(R.MotorModel.AccelerationBased);
      k.configureMotorPosition(0, TONE.knee[0], TONE.knee[1]);
      this.feet[i]!.rotation.set(0.15, 0, 0);
      this.hands[i]!.quaternion.identity();
      this.curlFingers(i, 0.25);
    }
    world.use(true);
    world.cover(hips.x, hips.z);
    // the figure now hangs in the scene at the origin; the parts carry it
    this.scene.add(this.group);
    this.group.position.set(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
    this.rag = { world, parts, t: 0, upAt: Math.max(0.3, upSeconds - RISE_S), last: null, vel: new Vector3(v.x, v.y, v.z) };
    this.readRagdoll();
    this.model?.apply();
  }

  /** Drops the ragdoll's bodies (if any). */
  private endRagdoll(): void {
    const rag = this.rag;
    if (!rag) return;
    for (const { body } of rag.parts) rag.world.world.removeRigidBody(body);
    rag.world.use(false);
    this.rag = null;
  }

  /** The skeleton groups from the parts: the pelvis in the scene (group at the origin), the others relative to their parent. */
  private readRagdoll(): void {
    const parts = this.rag!.parts;
    const world = parts.map(({ body }) => {
      const r = body.rotation();
      return new Quaternion(r.x, r.y, r.z, r.w);
    });
    const t = parts[0]!.body.translation();
    this.body.position.set(t.x, t.y, t.z);
    this.body.quaternion.copy(world[0]!);
    for (let k = 1; k < parts.length; k++) parts[k]!.node.quaternion.copy(world[RAG_PARENT[k]!]!.clone().invert().multiply(world[k]!));
  }

  private tickRagdoll(x: number, y: number, z: number, dt: number): void {
    const rag = this.rag!;
    rag.t += dt;
    // the whole body's centre of mass and velocity
    let m = 0;
    const c = new Vector3(), v = new Vector3();
    for (const { body } of rag.parts) {
      const bm = body.mass(), p = body.worldCom(), lv = body.linvel();
      m += bm;
      c.x += p.x * bm; c.y += p.y * bm; c.z += p.z * bm;
      v.x += lv.x * bm; v.y += lv.y * bm; v.z += lv.z * bm;
    }
    c.divideScalar(m);
    v.divideScalar(m);
    rag.world.cover(c.x, c.z);
    // follow the sim's position: where it is and how fast it moves (from frame to frame, smoothed)
    const target = new Vector3(x, y + TRACK_Y, z);
    if (rag.last && dt > 1e-4) rag.vel.lerp(target.clone().sub(rag.last).divideScalar(dt), Math.min(1, dt * 20));
    rag.last = target.clone();
    const a = target.sub(c).multiplyScalar(TRACK_K).add(rag.vel.clone().sub(v).multiplyScalar(TRACK_C));
    if (a.length() > TRACK_MAX) a.setLength(TRACK_MAX);
    for (const { body } of rag.parts) {
      const k = body.mass() * dt;
      body.applyImpulse({ x: a.x * k, y: a.y * k, z: a.z * k }, true);
    }
    this.readRagdoll();
    // fell through the world (a gap in the copied surroundings): stand up where the sim is
    if (rag.t >= rag.upAt || y - c.y > 20) this.startRise();
  }

  /**
   * From the ragdoll's last pose: the bodies go and the figure gets up the way a person does from how it lies — face
   * down over hands and knees, face up by sitting up — facing along its body (head first face down, feet first face up).
   */
  private startRise(): void {
    const q = this.body.quaternion.clone();
    const prone = new Vector3(0, 0, 1).applyQuaternion(q).y < 0; // the chest faces the ground
    const head = new Vector3(0, 1, 0).applyQuaternion(q);
    const heading = prone ? Math.atan2(head.x, head.z) : Math.atan2(-head.x, -head.z);
    const keys = prone ? GET_UP_PRONE : GET_UP_SUPINE;
    // where the first keyframe's hips are is where the ragdoll's hips lie: that places the standing spot
    const hips = this.body.position.clone().add(new Vector3(0, this.p.hip.y, 0).applyQuaternion(q));
    const sc = this.p.hip.y / 0.92;
    const from = hips.sub(new Vector3(0, 0, keys[0]!.hz * sc).applyAxisAngle(new Vector3(0, 1, 0), heading));
    const locals = this.riseNodes().map((n) => n.quaternion.clone());
    this.rise = { t: 0, pos: this.body.position.clone(), q, locals, heading, keys, from };
    this.endRagdoll();
  }

  private riseNodes(): Object3D[] {
    return [this.torso, this.headNode, ...this.legs, ...this.shins, ...this.arms, ...this.forearms, ...this.feet];
  }

  /** Poses the skeleton as keyframe k, standing spot `at` (feet), facing `heading` (group at the origin). */
  private poseKey(k: Omit<Key, 't'>, at: Vector3, heading: number): void {
    const sc = this.p.hip.y / 0.92;
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading);
    this.body.quaternion.copy(yaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), k.p));
    const hips = new Vector3(0, k.hy * sc, k.hz * sc).applyQuaternion(yaw).add(at);
    this.body.position.copy(hips).sub(new Vector3(0, this.p.hip.y, 0).applyQuaternion(this.body.quaternion));
    this.torso.rotation.set(k.torso, 0, 0);
    this.headNode.rotation.set(k.head, 0, 0);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      this.legs[i]!.rotation.set(-k.hip[i]!, 0, 0);
      this.shins[i]!.rotation.set(k.knee[i]!, 0, 0);
      // the feet stay flat on the ground (from the shin's forward tilt), within what an ankle bends
      const shinTilt = k.hip[i]! - k.p - k.knee[i]!;
      this.feet[i]!.rotation.set(Math.max(-0.7, Math.min(0.7, shinTilt)), 0, 0);
      this.arms[i]!.rotation.set(-k.arm[i]!, 0, s * k.out);
      this.forearms[i]!.rotation.set(-k.elbow, 0, 0);
    }
  }

  private tickRise(x: number, y: number, z: number, dt: number): void {
    const r = this.rise!;
    r.t += dt;
    const keys = r.keys, end = RISE_BLEND + keys.at(-1)!.t;
    // the standing spot moves from below the lying body to where the sim has the player
    const at = r.from.clone().lerp(new Vector3(x, 0, z), smooth(Math.min(1, r.t / end))).setY(y);
    const kt = Math.max(0, r.t - RISE_BLEND);
    let j = 0;
    while (j < keys.length - 2 && keys[j + 1]!.t <= kt) j++;
    const a = keys[j]!, b = keys[j + 1]!;
    const u = smooth(Math.min(1, Math.max(0, (kt - a.t) / (b.t - a.t))));
    const m = (x0: number, x1: number) => mix(x0, x1, u);
    this.poseKey({
      hy: m(a.hy, b.hy), hz: m(a.hz, b.hz), p: m(a.p, b.p), torso: m(a.torso, b.torso), head: m(a.head, b.head),
      hip: [m(a.hip[0], b.hip[0]), m(a.hip[1], b.hip[1])], knee: [m(a.knee[0], b.knee[0]), m(a.knee[1], b.knee[1])],
      arm: [m(a.arm[0], b.arm[0]), m(a.arm[1], b.arm[1])], out: m(a.out, b.out), elbow: m(a.elbow, b.elbow),
    }, at, r.heading);
    if (r.t < RISE_BLEND) {
      // out of the ragdoll's pose into the first keyframe
      const w = smooth(r.t / RISE_BLEND);
      this.body.position.lerpVectors(r.pos, this.body.position.clone(), w);
      this.body.quaternion.slerpQuaternions(r.q, this.body.quaternion.clone(), w);
      this.riseNodes().forEach((n, i) => n.quaternion.slerpQuaternions(r.locals[i]!, n.quaternion.clone(), w));
    }
    // no joint below the ground (the blend and the keyframes are not exact for every build): lift the whole body
    this.group.updateMatrixWorld(true);
    let low = Infinity;
    const p = new Vector3();
    for (const n of [this.headNode, ...this.riseNodes(), ...this.hands]) low = Math.min(low, n.getWorldPosition(p).y);
    if (low < y + RISE_CLEAR) this.body.position.y += y + RISE_CLEAR - low;
    if (r.t < end) return;
    // standing: back to the normal frame (group at the feet, turned to the heading)
    this.rise = null;
    this.heading = r.heading;
    this.body.position.set(0, 0, 0);
    this.body.quaternion.identity();
    this.riseNodes().forEach((n) => n.quaternion.identity());
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, r.heading, 0, 'YXZ');
  }

  /** Pitch of the upper body (rad, + = forward). */
  torsoPitch(): number {
    return this.torso.rotation.x;
  }

  /** Ball of foot i (0 left, 1 right) in the parent frame of the figure's group. */
  foot(i: number): Vector3 {
    const s = i === 0 ? 1 : -1;
    return this.inParent(this.feet[i]!, mirror(this.p.contact, s).sub(mirror(this.p.ankle, s)));
  }

  /** Middle of hand i in the parent frame of the figure's group. */
  hand(i: number): Vector3 {
    return this.inParent(this.hands[i]!, this.segs(i).palm);
  }

  private inParent(o: Object3D, local: Vector3): Vector3 {
    this.group.updateMatrixWorld(true);
    const w = o.localToWorld(local.clone());
    return this.group.parent ? this.group.parent.worldToLocal(w) : w;
  }

  private tickFall(dt: number): void {
    this.fallT += dt;
    const t = this.fallT;
    let k: number; // 0 standing … 1 lying
    if (t < FALL) k = smooth(t / FALL);
    else if (t < this.upAt) k = 1;
    else k = 1 - smooth(Math.min(1, (t - Math.max(FALL, this.upAt)) / GET_UP));
    this.body.rotation.set(k * Math.PI * 0.47, 0, 0);
    this.body.position.set(0, k * 0.12, 0);
    this.arms.forEach((a, i) => a.quaternion.setFromEuler(new Euler(-k * 2.2, 0, (i ? -1 : 1) * k * 0.4)));
    if (t >= Math.max(FALL, this.upAt) + GET_UP) {
      this.fallT = -1;
      this.upAt = Infinity;
      this.body.rotation.set(0, 0, 0);
      this.body.position.set(0, 0, 0);
    }
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }
}

/**
 * A skinned model whose bones follow driver nodes: each driven bone gets its rest transform (in the model's frame)
 * moved by its driver's change from rest (in the figure's frame); other bones keep their rest offset to the parent.
 * The model's frame is the figure frame (the root sits at identity in the figure's group).
 */
class SkinnedModel {
  private readonly bones: Bone[] = [];
  private readonly rest = new Map<Object3D, Matrix4>();
  private readonly restLocal = new Map<Bone, Matrix4>();
  private readonly drive = new Map<Bone, { node: Object3D; restInv: Matrix4 }>();
  private readonly want = new Map<Object3D, Matrix4>();
  private readonly figureRoot: Object3D;

  constructor(readonly root: Object3D, drivers: [Object3D, string][]) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    root.traverse((o) => {
      this.rest.set(o, inv.clone().multiply(o.matrixWorld));
      if ((o as Bone).isBone) {
        this.bones.push(o as Bone);
        this.restLocal.set(o as Bone, o.matrix.clone());
      }
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false; // the skeleton moves the mesh away from its rest bounds
      }
    });
    // the drivers' rest transforms: their joint position in the figure frame, no rotation
    this.figureRoot = drivers[0]![0].parent!; // body's parent = the figure's group
    for (const [node, name] of drivers) {
      const bone = root.getObjectByName(name) as Bone | undefined;
      if (!bone) throw new Error(`character model lacks bone ${name}`);
      this.drive.set(bone, { node, restInv: this.relative(node).invert() });
    }
  }

  /** Transform of a driver node relative to the figure's group (its local matrices up the chain). */
  private relative(node: Object3D, restOnly = true): Matrix4 {
    const m = new Matrix4();
    for (let o: Object3D | null = node; o && o !== this.figureRoot; o = o.parent) {
      const local = restOnly ? new Matrix4().makeTranslation(o.position.x, o.position.y, o.position.z) : (o.updateMatrix(), o.matrix);
      m.premultiply(local);
    }
    return m;
  }

  /** Poses the bones from the drivers' current transforms. */
  apply(): void {
    this.want.clear();
    const tmp = new Matrix4();
    for (const bone of this.bones) {
      const parentWant = this.want.get(bone.parent!) ?? this.rest.get(bone.parent!)!;
      const d = this.drive.get(bone);
      let w: Matrix4;
      if (d) {
        w = this.relative(d.node, false).multiply(d.restInv).multiply(this.rest.get(bone)!);
        tmp.copy(parentWant).invert().multiply(w);
        tmp.decompose(bone.position, bone.quaternion, bone.scale);
      } else {
        w = parentWant.clone().multiply(this.restLocal.get(bone)!);
      }
      this.want.set(bone, w);
    }
  }
}
