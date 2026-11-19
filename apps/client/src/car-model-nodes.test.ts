import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAR_SEATS } from '@nn/shared';
import { describe, expect, it } from 'vitest';

type Gltf = {
  nodes: { name?: string; translation?: [number, number, number]; children?: number[] }[];
  materials: { name: string; alphaMode?: string }[];
};

/** The JSON chunk of a model in data/models/cars (GLB: 12-byte header, then chunk length u32, type 'JSON', data). */
function readModel(type: string): Gltf {
  const buf = readFileSync(fileURLToPath(new URL(`../../../data/models/cars/${type}/${type}.glb`, import.meta.url)));
  const len = buf.readUInt32LE(12);
  expect(buf.toString('ascii', 16, 20)).toBe('JSON');
  return JSON.parse(buf.toString('utf8', 20, 20 + len)) as Gltf;
}

describe('kleinwagen model', () => {
  const g = readModel('kleinwagen');
  const names = g.nodes.map((n) => n.name);
  const parent = new Map<number, number>();
  g.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  /** Position in the model frame (glTF: x = left, y = up, z = forward): the translations up the parent chain. */
  const world = (name: string): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0];
    for (let i: number | undefined = names.indexOf(name); i !== undefined && i >= 0; i = parent.get(i)) {
      const t = g.nodes[i]!.translation ?? [0, 0, 0];
      p[0] += t[0]; p[1] += t[1]; p[2] += t[2];
    }
    return p;
  };

  it('has the nodes the client uses by name', () => {
    for (const n of ['body', 'interior', 'steering', 'grip_l', 'grip_r', 'door_fl', 'door_fr', 'door_rl', 'door_rr',
      'seat_0', 'seat_1', 'seat_2', 'seat_3', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'light_fl', 'light_fr', 'tail_l', 'tail_r']) {
      expect(names, n).toContain(n);
    }
  });

  it('has its seats and door hinges where CAR_SEATS says', () => {
    const L = CAR_SEATS.kleinwagen!;
    L.seats.forEach((s, i) => {
      const [x, y, z] = world(`seat_${i}`);
      expect(Math.hypot(x - s.x, y - s.h, z - s.u), `seat_${i}`).toBeLessThan(0.05);
    });
    for (const [name, d] of Object.entries(L.doors)) {
      const [x, , z] = world(name);
      expect(Math.hypot(x - d.hingeX, z - d.hingeU), name).toBeLessThan(0.05);
    }
  });

  it('marks its glass as blended', () => {
    expect(g.materials.find((m) => m.name === 'glass')?.alphaMode).toBe('BLEND');
  });
});

describe.each(['kleinwagen', 'mittelklasse', 'transporter', 'smart'])('%s model', (type) => {
  it('has a node for each number plate, front ahead of the rear', () => {
    const g = readModel(type);
    const at = (name: string) => g.nodes.find((n) => n.name === name)?.translation;
    const f = at('plate_f'), r = at('plate_r');
    expect(f, 'plate_f').toBeDefined();
    expect(r, 'plate_r').toBeDefined();
    expect(f![2]).toBeGreaterThan(1); // glTF z = forward
    expect(r![2]).toBeLessThan(-1);
    expect(Math.abs(f![0])).toBeLessThan(0.01);
  });
});
