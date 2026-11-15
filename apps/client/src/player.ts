import { BoxGeometry, type BufferGeometry, Euler, Group, Mesh, MeshStandardMaterial, type Object3D, Quaternion, SphereGeometry, Vector3, type Scene } from 'three';
import { TUNING } from '@nn/shared';

/** Shortest signed angle from a to b (rad). */
export const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

const HIP = 0.92;
const SHOULDER = 1.47;
const THIGH = 0.45;
const SHIN = 0.45;
/** The ball of the foot sits this far ahead of the ankle line (on the pedal). */
const FOOT_FORWARD = 0.05;
/** Seconds to tip over and to get up. */
const FALL = 0.35;
const GET_UP = 0.5;

export type Posture = 'upright' | 'sport' | 'race';
/** Upper-body pitch on the bike (rad, forward): Dutch/cargo upright, MTB sport, road race. */
const POSTURE_PITCH: Record<Posture, number> = { upright: 0.17, sport: 0.52, race: 0.87 };

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * The player's own low-poly figure (head, torso, arms, legs from primitives), 1.8 m tall, feet at the
 * group origin, facing local +z. Arms and legs swing with the distance walked.
 */
export class PlayerFigure {
  readonly group = new Group();
  /** Facing (heading convention, forward = (sin h, cos h)); turns smoothly towards the walking direction. */
  heading = 0;
  private phase = 0;
  private swingAmp = 0;
  /** 0 standing on ground … 1 in the air (smoothed, so a one-step kerb climb does not flicker). */
  private air = 0;
  private readonly legs: Group[] = [];
  /** Knee joints (children of the legs, 0.45 m below the hip). */
  private readonly shins: Group[] = [];
  private readonly arms: Group[] = [];
  private readonly body = new Group();
  /** Upper body, pivoting at the hips: torso, head, arms. */
  private readonly torso = new Group();
  /** Fall: seconds since it started, or −1; `up` = the get-up phase started at that time. */
  private fallT = -1;
  private upAt = Infinity;

  constructor(scene: Scene) {
    const mat = (color: number, roughness = 0.85) => new MeshStandardMaterial({ color, roughness });
    const jacket = mat(0x2f6168), jeans = mat(0x2b3a55), skin = mat(0xdcae8a, 0.7), shoe = mat(0x1d1b1a, 0.6), hair = mat(0x3a2a20);
    const part = (g: BufferGeometry, m: MeshStandardMaterial, parent: Group) => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // legs pivot at the hip (0.92 m): thigh, then the shin and shoe pivot at the knee (0.45 m lower)
    for (const s of [1, -1]) {
      const leg = new Group();
      leg.position.set(s * 0.11, HIP, 0);
      part(new BoxGeometry(0.16, THIGH + 0.02, 0.18).translate(0, -THIGH / 2, 0), jeans, leg);
      const shin = new Group();
      shin.position.y = -THIGH;
      part(new BoxGeometry(0.15, SHIN, 0.17).translate(0, -SHIN / 2, 0), jeans, shin);
      part(new BoxGeometry(0.15, 0.08, 0.28).translate(0, -SHIN - 0.01, 0.05), shoe, shin);
      leg.add(shin);
      this.legs.push(leg);
      this.shins.push(shin);
      this.body.add(leg);
    }
    this.torso.position.y = HIP;
    part(new BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.21 - HIP, 0), jacket, this.torso);
    part(new BoxGeometry(0.14, 0.08, 0.14).translate(0, 1.54 - HIP, 0), skin, this.torso); // neck
    part(new SphereGeometry(0.125, 12, 9).scale(0.92, 1.05, 1).translate(0, 1.67 - HIP, 0.005), skin, this.torso);
    // hair: a cap tilted backwards, so it covers the top and the back of the head but leaves the face
    part(new SphereGeometry(0.135, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.6).rotateX(-0.55).scale(0.95, 1, 1.02).translate(0, 1.68 - HIP, -0.015), hair, this.torso);
    // arms pivot at the shoulder (1.47 m): sleeve plus hand
    for (const s of [1, -1]) {
      const arm = new Group();
      arm.position.set(s * 0.27, SHOULDER - HIP, 0);
      part(new BoxGeometry(0.11, 0.56, 0.13).translate(0, -0.28, 0), jacket, arm);
      part(new BoxGeometry(0.09, 0.1, 0.1).translate(0, -0.61, 0), skin, arm);
      this.arms.push(arm);
      this.torso.add(arm);
    }
    this.body.add(this.torso);
    this.group.add(this.body);
    scene.add(this.group);
  }

  /**
   * Places the figure at the feet position and animates it from its velocity v (m/s): facing turns towards
   * the horizontal velocity when moving, arms and legs swing, in the air the legs tuck and the arms lift.
   * During a fall (fall()) it tips over, lies, and gets up again.
   */
  update(x: number, y: number, z: number, v: { x: number; y: number; z: number }, dt: number): void {
    this.torso.rotation.set(0, 0, 0);
    if (this.fallT >= 0) {
      this.tickFall(dt);
      this.group.position.set(x, y, z);
      return;
    }
    const vx = v.x, vz = v.z;
    const speed = Math.hypot(vx, vz);
    this.air += ((Math.abs(v.y) > 0.6 ? 1 : 0) - this.air) * Math.min(1, dt * 8);
    if (speed > 0.2) this.heading += angleDelta(this.heading, Math.atan2(vx, vz)) * Math.min(1, dt * 12);
    // one full cycle per two strides; strides lengthen when running
    const stride = speed > 3 ? 1.5 : 0.75;
    this.phase = (this.phase + (speed * dt * Math.PI) / stride) % (Math.PI * 2);
    const target = speed < 0.2 ? 0 : speed > 3 ? 0.85 : 0.45;
    this.swingAmp += (target - this.swingAmp) * Math.min(1, dt * 10);
    const sw = Math.sin(this.phase) * this.swingAmp * (1 - this.air);
    const air = this.air;
    this.legs[0]!.rotation.set(sw - 0.55 * air, 0, 0);
    this.legs[1]!.rotation.set(-sw + 0.3 * air, 0, 0);
    // the knee bends on the leg swinging back
    this.shins[0]!.rotation.x = Math.max(0, -sw) * 0.7 + 0.6 * air;
    this.shins[1]!.rotation.x = Math.max(0, sw) * 0.7 + 0.3 * air;
    this.arms[0]!.quaternion.setFromEuler(new Euler(-sw * 0.8 - 0.5 * air, 0, 0.06 + 0.5 * air));
    this.arms[1]!.quaternion.setFromEuler(new Euler(sw * 0.8 - 0.5 * air, 0, -0.06 - 0.5 * air));
    this.body.position.set(0, Math.abs(Math.cos(this.phase)) * this.swingAmp * 0.05, 0);
    this.body.rotation.set(speed > 3 ? 0.12 : 0, 0, 0); // lean into the run
    this.group.position.set(x, y, z);
    this.group.rotation.set(0, this.heading, 0);
  }

  /**
   * Riding pose in the frame of the bike's lean group (the caller parents `group` there): hips on the seat, feet on
   * the pedals (two-bone leg IK), torso pitched for the posture, arms towards the grips.
   */
  ride(seat: Vector3, grips: [Vector3, Vector3], pedals: [Vector3, Vector3], posture: Posture): void {
    this.fallT = -1;
    this.group.position.set(seat.x, seat.y - HIP, seat.z);
    this.group.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.torso.rotation.set(POSTURE_PITCH[posture], 0, 0);
    this.group.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]!, shin = this.shins[i]!;
      // hip and pedal in the group frame; the legs swing in the y/z plane
      const dy = pedals[i]!.y - (seat.y - HIP) - HIP, dz = pedals[i]!.z - seat.z - FOOT_FORWARD;
      const L = Math.min(THIGH + SHIN - 1e-4, Math.max(0.05, Math.hypot(dy, dz)));
      const toward = -Math.atan2(dz, -dy); // leg rotation that points it at the pedal
      const hipBend = Math.acos(Math.min(1, (THIGH * THIGH + L * L - SHIN * SHIN) / (2 * THIGH * L)));
      const knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, (THIGH * THIGH + SHIN * SHIN - L * L) / (2 * THIGH * SHIN))));
      leg.rotation.set(toward - hipBend, 0, 0);
      shin.rotation.x = knee;
    }
    this.group.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i]!;
      arm.quaternion.identity();
      arm.updateMatrixWorld(true);
      // direction shoulder → grip in the torso frame; the arm hangs along −y
      const shoulder = arm.getWorldPosition(new Vector3());
      const toGrip = grips[i]!.clone().sub(shoulder);
      const inv = new Quaternion();
      this.torso.getWorldQuaternion(inv).invert();
      toGrip.applyQuaternion(inv).normalize();
      arm.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), toGrip);
    }
    this.group.updateMatrixWorld(true);
  }

  /** Tips over in `direction` (heading convention), lies, and gets up after TUNING.bike.getUpSeconds. */
  fall(direction: number): void {
    this.fallT = 0;
    this.upAt = TUNING.bike.getUpSeconds - GET_UP;
    this.group.rotation.set(0, direction, 0);
    this.heading = direction;
    this.legs.forEach((l) => l.rotation.set(0, 0, 0));
    this.shins.forEach((s) => (s.rotation.x = 0.3));
  }

  /** Starts getting up now (if lying). */
  getUp(): void {
    if (this.fallT >= 0) this.upAt = Math.min(this.upAt, this.fallT);
  }

  /** Falling, lying or getting up: no control. */
  get busy(): boolean {
    return this.fallT >= 0;
  }

  /** Pitch of the upper body (rad, + = forward). */
  torsoPitch(): number {
    return this.torso.rotation.x;
  }

  /** Ankle of leg i (0 left, 1 right) in the parent frame of the figure's group. */
  foot(i: number): Vector3 {
    return this.inParent(this.shins[i]!, new Vector3(0, -SHIN, FOOT_FORWARD));
  }

  /** Hand of arm i in the parent frame of the figure's group. */
  hand(i: number): Vector3 {
    return this.inParent(this.arms[i]!, new Vector3(0, -0.61, 0));
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
