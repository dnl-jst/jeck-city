import { BoxGeometry, type BufferGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, type Scene } from 'three';

/** Shortest signed angle from a to b (rad). */
export const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Seconds to fall over and to get up again. */
export const DOWN_IN_S = 0.25, DOWN_OUT_S = 0.3;

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
  private readonly arms: Group[] = [];
  private readonly body = new Group();
  /** Knocked down: target (0 standing … 1 lying) and the smoothed amount. */
  private downTarget = 0;
  private down = 0;

  constructor(scene: Scene) {
    const mat = (color: number, roughness = 0.85) => new MeshStandardMaterial({ color, roughness });
    const jacket = mat(0x2f6168), jeans = mat(0x2b3a55), skin = mat(0xdcae8a, 0.7), shoe = mat(0x1d1b1a, 0.6), hair = mat(0x3a2a20);
    const part = (g: BufferGeometry, m: MeshStandardMaterial, parent: Group) => {
      const mesh = new Mesh(g, m);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    // legs pivot at the hip (0.92 m); each a trouser leg plus a shoe
    for (const s of [1, -1]) {
      const leg = new Group();
      leg.position.set(s * 0.11, 0.92, 0);
      part(new BoxGeometry(0.16, 0.86, 0.18).translate(0, -0.43, 0), jeans, leg);
      part(new BoxGeometry(0.15, 0.08, 0.28).translate(0, -0.88, 0.05), shoe, leg);
      this.legs.push(leg);
      this.body.add(leg);
    }
    part(new BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.21, 0), jacket, this.body);
    part(new BoxGeometry(0.14, 0.08, 0.14).translate(0, 1.54, 0), skin, this.body); // neck
    part(new SphereGeometry(0.125, 12, 9).scale(0.92, 1.05, 1).translate(0, 1.67, 0.005), skin, this.body);
    // hair: a cap tilted backwards, so it covers the top and the back of the head but leaves the face
    part(new SphereGeometry(0.135, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.6).rotateX(-0.55).scale(0.95, 1, 1.02).translate(0, 1.68, -0.015), hair, this.body);
    // arms pivot at the shoulder (1.47 m): sleeve plus hand
    for (const s of [1, -1]) {
      const arm = new Group();
      arm.position.set(s * 0.27, 1.47, 0);
      part(new BoxGeometry(0.11, 0.56, 0.13).translate(0, -0.28, 0), jacket, arm);
      part(new BoxGeometry(0.09, 0.1, 0.1).translate(0, -0.61, 0), skin, arm);
      this.arms.push(arm);
      this.body.add(arm);
    }
    this.group.add(this.body);
    scene.add(this.group);
  }

  /**
   * Places the figure at the feet position and animates it from its velocity v (m/s): facing turns towards
   * the horizontal velocity when moving, arms and legs swing, in the air the legs tuck and the arms lift.
   */
  update(x: number, y: number, z: number, v: { x: number; y: number; z: number }, dt: number): void {
    const vx = v.x, vz = v.z;
    const speed = Math.hypot(vx, vz);
    this.air += ((Math.abs(v.y) > 0.6 ? 1 : 0) - this.air) * Math.min(1, dt * 8);
    if (speed > 0.2) this.heading += angleDelta(this.heading, Math.atan2(vx, vz)) * Math.min(1, dt * 12);
    // one full cycle per two strides; strides lengthen when running
    const stride = speed > 3 ? 1.5 : 0.75;
    this.phase = (this.phase + (speed * dt * Math.PI) / stride) % (Math.PI * 2);
    const target = speed < 0.2 ? 0 : speed > 3 ? 0.85 : 0.45;
    this.swingAmp += (target - this.swingAmp) * Math.min(1, dt * 10);
    // knocked over (backwards, about the feet): 0.25 s down, 0.3 s back up
    const dk = this.downTarget - this.down;
    this.down += Math.sign(dk) * Math.min(Math.abs(dk), dt / (dk > 0 ? DOWN_IN_S : DOWN_OUT_S));
    const lie = this.down;
    const sw = Math.sin(this.phase) * this.swingAmp * (1 - this.air) * (1 - lie);
    const air = this.air;
    this.legs[0]!.rotation.x = sw - 0.55 * air;
    this.legs[1]!.rotation.x = -sw + 0.3 * air;
    this.arms[0]!.rotation.x = -sw * 0.8 - 0.5 * air;
    this.arms[1]!.rotation.x = sw * 0.8 - 0.5 * air;
    this.arms[0]!.rotation.z = 0.06 + 0.5 * air;
    this.arms[1]!.rotation.z = -0.06 - 0.5 * air;
    this.body.position.y = Math.abs(Math.cos(this.phase)) * this.swingAmp * 0.05 * (1 - lie) + 0.12 * lie;
    this.body.rotation.x = (speed > 3 ? 0.12 : 0) * (1 - lie) - (Math.PI / 2) * lie; // lean into the run / lie on the back
    this.group.position.set(x, y, z);
    this.group.rotation.y = this.heading;
  }

  /** Knocked down (1) or standing (0); the figure tips over / gets up within DOWN_IN_S / DOWN_OUT_S. */
  setDown(k: number): void {
    this.downTarget = Math.max(0, Math.min(1, k));
  }

  set visible(on: boolean) {
    this.group.visible = on;
  }
}
