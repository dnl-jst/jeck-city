import {
  BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Quaternion, Vector3, type Material, type Object3D, type Scene,
} from 'three';
import { pedSignalAt, signalAt, type SignalJunction, type SignalPole } from '@nn/shared';

type Kind = SignalPole['kind'];
/** Lamp colours when lit, and the dark glass when off. */
const LIT: Record<string, Color> = {
  lamp_red: new Color(1.0, 0.08, 0.04), lamp_amber: new Color(1.0, 0.62, 0.05), lamp_green: new Color(0.15, 1.0, 0.55),
  lamp_ped_red: new Color(1.0, 0.08, 0.04), lamp_ped_green: new Color(0.15, 1.0, 0.55),
};
const DARK = new Color(0.035, 0.035, 0.04);
/** Lights are switched within this radius (m) of the camera; farther ones keep their last state. */
const SWITCH_RADIUS = 200;
/** Stop lines: width (m) and height above the road (m). */
const STOP_W = 0.3, STOP_Y = 0.03;

type Part = { name: string; mesh: InstancedMesh };
type Pole = { j: SignalJunction; p: SignalPole; i: number };

/**
 * The traffic lights: one InstancedMesh per part (pole, lamps) of each model kind, the lamps unlit-shaded so a lit one
 * glows by day and night; every frame the lights within SWITCH_RADIUS switch with the shared phase (signalAt at the
 * shown tick). The stop lines are one white mesh on the road.
 */
export class TrafficSignals {
  private readonly parts = new Map<Kind, Part[]>();
  private readonly poles = new Map<Kind, Pole[]>();

  constructor(
    scene: Scene, junctions: readonly SignalJunction[], models: ReadonlyMap<Kind, Object3D>, groundAt: (x: number, z: number) => number,
  ) {
    for (const j of junctions) for (const p of j.poles) {
      const list = this.poles.get(p.kind) ?? [];
      list.push({ j, p, i: list.length });
      this.poles.set(p.kind, list);
    }
    const m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), one = new Vector3(1, 1, 1);
    for (const [kind, poles] of this.poles) {
      const model = models.get(kind);
      if (!model) continue;
      model.updateMatrixWorld(true);
      const parts: Part[] = [];
      model.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const name = mesh.name.replace(/[._]\d+$/, '');
        const lamp = name in LIT;
        const material: Material = lamp ? new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }) : (mesh.material as Material);
        const inst = new InstancedMesh(mesh.geometry, material, poles.length);
        inst.name = `${kind}/${lamp ? name : 'pole'}`;
        inst.castShadow = !lamp;
        inst.receiveShadow = true;
        inst.frustumCulled = false; // spread over the whole city: the bounding sphere would not cull anything
        const local = mesh.matrixWorld;
        for (const { p, i } of poles) {
          q.setFromAxisAngle(up, p.heading);
          m.compose(new Vector3(p.x, groundAt(p.x, p.z), p.z), q, one).multiply(local);
          inst.setMatrixAt(i, m);
          if (lamp) inst.setColorAt(i, DARK);
        }
        if (lamp) inst.instanceColor!.setUsage(DynamicDrawUsage);
        scene.add(inst);
        parts.push({ name, mesh: inst });
        if (!lamp && mesh.material instanceof MeshStandardMaterial) mesh.material.needsUpdate = true;
      });
      this.parts.set(kind, parts);
    }
    const lines = stopLineMesh(junctions, groundAt);
    if (lines) scene.add(lines);
  }

  /** The instanced lamp (or pole) mesh `name` of a kind (tests). */
  mesh(kind: Kind, name: string): InstancedMesh | null {
    return this.parts.get(kind)?.find((p) => p.name === name)?.mesh ?? null;
  }

  update(tick: number, camX: number, camZ: number, _night: number): void {
    for (const [kind, poles] of this.poles) {
      const parts = this.parts.get(kind);
      if (!parts) continue;
      let dirty = false;
      for (const { j, p, i } of poles) {
        if (Math.abs(p.x - camX) > SWITCH_RADIUS || Math.abs(p.z - camZ) > SWITCH_RADIUS) continue;
        const car = p.group >= 0 ? signalAt(j, p.group as 0 | 1, tick) : null;
        const ped = p.ped >= 0 ? pedSignalAt(j, p.ped as 0 | 1, tick) : null;
        for (const part of parts) {
          let on: boolean | null = null;
          if (part.name === 'lamp_red') on = car === 'red' || car === 'redAmber';
          else if (part.name === 'lamp_amber') on = car === 'amber' || car === 'redAmber';
          else if (part.name === 'lamp_green') on = car === 'green';
          else if (part.name === 'lamp_ped_red') on = ped === 'red';
          else if (part.name === 'lamp_ped_green') on = ped === 'green';
          if (on === null) continue;
          part.mesh.setColorAt(i, on ? LIT[part.name]! : DARK);
          dirty = true;
        }
      }
      if (dirty) for (const part of parts) if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** All stop lines as one flat white mesh just above the road. */
function stopLineMesh(junctions: readonly SignalJunction[], groundAt: (x: number, z: number) => number): Mesh | null {
  const pos: number[] = [];
  for (const j of junctions) {
    for (const l of j.stopLines) {
      const dx = l.x1 - l.x0, dz = l.z1 - l.z0, len = Math.hypot(dx, dz) || 1;
      // the line's width runs along the lane (perpendicular to the line)
      const nx = (-dz / len) * (STOP_W / 2), nz = (dx / len) * (STOP_W / 2);
      const y0 = groundAt(l.x0, l.z0) + STOP_Y, y1 = groundAt(l.x1, l.z1) + STOP_Y;
      const a = [l.x0 - nx, y0, l.z0 - nz], b = [l.x1 - nx, y1, l.z1 - nz], c = [l.x1 + nx, y1, l.z1 + nz], d = [l.x0 + nx, y0, l.z0 + nz];
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  if (!pos.length) return null;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const mesh = new Mesh(g, new MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.8, side: 2, polygonOffset: true, polygonOffsetFactor: -2 }));
  mesh.name = 'stop-lines';
  mesh.receiveShadow = true;
  return mesh;
}
