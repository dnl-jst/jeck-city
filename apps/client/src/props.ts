import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DoubleSide, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial,
  Object3D, Points, PointsMaterial, Quaternion, SRGBColorSpace, Vector3, type Scene, type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chunkKey, heightAt, type TerrainGrid, type WorldManifest } from '@nn/shared';

/** Height of the lamp's light source above ground (m). */
export const LAMP_LIGHT_Y = 5.55;

const UP = new Vector3(0, 1, 0);
const tq = new Quaternion(), ts = new Vector3(), tp = new Vector3();

/** Instance matrix of a lamp at (x, z) standing on the terrain; `light` is where its lantern glows. */
export function lampMatrix(t: TerrainGrid, x: number, z: number, out: Matrix4): { light: { x: number; y: number; z: number } } {
  const y = heightAt(t, x, z);
  out.makeTranslation(x, y, z);
  return { light: { x, y: y + LAMP_LIGHT_Y, z } };
}

/** Instance matrix of a tree at (x, z) on the terrain: random yaw and size from the position hash. */
export function treeMatrix(t: TerrainGrid, x: number, z: number, out: Matrix4): Matrix4 {
  const k = 0.75 + 0.55 * hash(x, z, 1);
  tq.setFromAxisAngle(UP, hash(x, z, 2) * Math.PI * 2);
  return out.compose(tp.set(x, heightAt(t, x, z), z), tq, ts.set(k * (0.9 + 0.2 * hash(x, z, 3)), k, k * (0.9 + 0.2 * hash(x, z, 4))));
}

type Sign = NonNullable<WorldManifest['shops'][number]['sign']>;

/**
 * Corners (bottom left, bottom right, top right, top left as seen from the street) of a w × h sign board
 * centred at (sign.x, sign.y, sign.z); sign.y already includes the building's base height.
 */
export function signCorners(sign: Sign, w: number, h: number): [number, number, number][] {
  const nx = Math.sin(sign.heading), nz = Math.cos(sign.heading);
  // local +x of a plane rotated by heading: (cos h, −sin h) — the reader's right when facing the wall
  const rx = nz, rz = -nx;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([a, b]) => [sign.x + rx * a * w / 2, sign.y + b * h / 2, sign.z + rz * a * w / 2]);
}

/** Deterministic [0,1) value of a world position and a channel number. */
function hash(x: number, z: number, k: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Merged, non-indexed copy of geometries (mergeGeometries needs uniform indexing). */
function merge(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  if (!g) throw new Error('props: geometry merge failed');
  return g;
}

/** Köln street lamp, ~6 m: base, slim mast, lantern (glass, separate mesh) and a dark cap. */
function lampGeometries(): { metal: BufferGeometry; glass: BufferGeometry } {
  const base = new CylinderGeometry(0.16, 0.2, 0.9, 8).translate(0, 0.45, 0);
  const mast = new CylinderGeometry(0.06, 0.1, 4.6, 8).translate(0, 0.9 + 2.3, 0);
  const collar = new CylinderGeometry(0.14, 0.08, 0.25, 8).translate(0, 5.6 - 0.3 - 0.12, 0);
  const cap = new CylinderGeometry(0.08, 0.36, 0.28, 8).translate(0, 5.6 + 0.28 + 0.14, 0);
  const finial = new CylinderGeometry(0.02, 0.05, 0.25, 6).translate(0, 5.6 + 0.42 + 0.12, 0);
  const glass = new CylinderGeometry(0.3, 0.17, 0.58, 8).translate(0, 5.6, 0);
  return { metal: merge([base, mast, collar, cap, finial]), glass };
}

/** Low-poly tree: trunk and a crown of three blobs, about 9 m at scale 1. */
function treeGeometries(): { trunk: BufferGeometry; crown: BufferGeometry } {
  const trunk = new CylinderGeometry(0.16, 0.24, 4.2, 6).translate(0, 2.1, 0);
  const blob = (r: number, x: number, y: number, z: number) => new IcosahedronGeometry(r, 1).translate(x, y, z);
  const crown = merge([blob(2.5, 0, 5.6, 0), blob(2.0, 1.3, 7.0, 0.6), blob(1.8, -1.0, 7.4, -0.8)]);
  // flat shading via per-face normals of the non-indexed geometry
  crown.computeVertexNormals();
  return { trunk, crown };
}

/** Radial glow sprite for the lamp halos. */
function glowTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,230,190,1)');
  grad.addColorStop(0.25, 'rgba(255,200,130,0.45)');
  grad.addColorStop(1, 'rgba(255,170,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** Stop sign: German green-on-yellow H plus the stop name, as a texture. */
function stopSignTexture(name: string): Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 320;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f1f1ec';
  g.fillRect(0, 0, 256, 320);
  g.fillStyle = '#f5c400';
  g.beginPath();
  g.arc(128, 104, 82, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#1d7a3a';
  g.stroke();
  g.fillStyle = '#1d7a3a';
  g.font = 'bold 120px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('H', 128, 110);
  g.fillStyle = '#1b1b1b';
  // wrap the name at '/' and spaces into at most 3 lines that fit
  const words = name.replace('/', '/ ').split(' ');
  const lines: string[] = [];
  g.font = 'bold 38px system-ui, sans-serif';
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && g.measureText(`${last} ${w}`).width < 232) lines[lines.length - 1] = `${last}${last.endsWith('/') ? '' : ' '}${w}`;
    else lines.push(w);
  }
  lines.slice(0, 3).forEach((l, i) => g.fillText(l, 128, 226 + i * 40, 244));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** One tram stop: shelter (posts, roof, back glass, bench) and a sign post, open towards +z before rotation. */
function stopGroup(stop: WorldManifest['tramStops'][number], y: number, frameMat: MeshStandardMaterial, glassMat: MeshStandardMaterial): Group {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new BoxGeometry(w, h, d).translate(x, y, z);
  const frame = merge([
    ...[-1.9, 1.9].flatMap((x) => [box(0.08, 2.5, 0.08, x, 1.25, -0.6), box(0.08, 2.5, 0.08, x, 1.25, 0.6)]),
    box(4.2, 0.12, 1.6, 0, 2.56, 0), // roof
    box(2.4, 0.06, 0.4, 0, 0.48, -0.35), // bench seat
    box(0.06, 0.45, 0.06, -1.0, 0.24, -0.35), box(0.06, 0.45, 0.06, 1.0, 0.24, -0.35),
    box(0.07, 3.1, 0.07, 3.0, 1.55, 0.4), // sign post
  ]);
  const group = new Group();
  const f = new Mesh(frame, frameMat);
  const glass = new Mesh(merge([box(3.8, 2.1, 0.03, 0, 1.3, -0.62), box(0.03, 2.1, 1.1, -1.9, 1.3, 0)]), glassMat);
  const signMat = new MeshStandardMaterial({ map: stopSignTexture(stop.name), roughness: 0.5, side: DoubleSide });
  const sign = new Mesh(new BoxGeometry(0.62, 0.78, 0.03).translate(3.0, 2.85, 0.44), [frameMat, frameMat, frameMat, frameMat, signMat, signMat]);
  sign.name = 'stopSign';
  f.castShadow = sign.castShadow = true;
  f.receiveShadow = true;
  group.add(f, glass, sign);
  group.position.set(stop.x, y, stop.z);
  // open front (+z) faces the track, which lies left of the heading: left of (sin h, cos h) is (cos h, −sin h)
  group.rotation.y = stop.heading + Math.PI / 2;
  group.name = `stop:${stop.name}`;
  return group;
}

const SIGN_H = 0.6;
/** Sign atlas: boards 64 px high, at most 416 px wide, shelf-packed into rows 2048 px wide with 4 px gaps (mipmaps). */
const ATLAS_W = 2048, CELL_H = 64, CELL_MAX_W = 416, GAP = 4;

/** Board colours (background, ink) of the sign styles. */
const SIGN_STYLES: [string, string][] = [
  ['#1f3b2c', '#f1e7cc'], ['#5a1a22', '#f6e3b8'], ['#1c2a4a', '#f2f0e6'], ['#18181a', '#f2c46b'],
  ['#ece4d0', '#2a2622'], ['#7a4a1c', '#fbeed2'], ['#f3f1ea', '#1d4f7a'], ['#2e5a5a', '#ffffff'],
];

/** Deterministic small hash of a string. */
function strHash(t: string): number {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * All shop signs as one mesh: every distinct label is drawn once into a shelf-packed canvas atlas,
 * every sign is a quad on its building's street-facing wall that maps its label's cell. The quad's front
 * (+z before rotation) faces outwards along the sign heading, so the text reads left to right from the street.
 */
export function buildShopSigns(shops: WorldManifest['shops'], material: MeshStandardMaterial): Mesh | null {
  const signed = shops.filter((s) => s.sign);
  if (!signed.length) return null;
  const labels = [...new Set(signed.map((s) => s.label))];
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const style = (label: string) => {
    const h = strHash(label);
    return { colors: SIGN_STYLES[h % SIGN_STYLES.length]!, font: (h >>> 8) % 3 === 0 ? 'italic bold 37px Georgia, serif' : 'bold 35px system-ui, sans-serif' };
  };
  // measure, then shelf-pack the boards (each as wide as its text) into rows of the atlas
  const pad = 20;
  const boxes = labels.map((label) => {
    g.font = style(label).font;
    return { label, w: Math.min(CELL_MAX_W, Math.ceil(g.measureText(label).width) + pad * 2), x: 0, y: 0 };
  });
  let x = 0, y = 0;
  for (const b of boxes) {
    if (x + b.w > ATLAS_W) { x = 0; y += CELL_H + GAP; }
    b.x = x; b.y = y;
    x += b.w + GAP;
  }
  c.width = ATLAS_W;
  c.height = y + CELL_H;
  const used = new Map<string, { u0: number; u1: number; v0: number; v1: number; aspect: number }>();
  for (const { label, w, x: left, y: y0 } of boxes) {
    const { colors: [bg, ink], font } = style(label);
    g.fillStyle = bg;
    g.fillRect(left, y0, w, CELL_H);
    g.strokeStyle = ink;
    g.globalAlpha = 0.55;
    g.lineWidth = 2.5;
    g.strokeRect(left + 5.5, y0 + 5.5, w - 11, CELL_H - 11);
    g.globalAlpha = 1;
    g.font = font;
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, left + w / 2, y0 + CELL_H / 2 + 2, w - pad * 2);
    // half-texel inset against bleeding from neighbouring boards
    used.set(label, { u0: (left + 0.5) / c.width, u1: (left + w - 0.5) / c.width, v0: 1 - (y0 + CELL_H - 0.5) / c.height, v1: 1 - (y0 + 0.5) / c.height, aspect: w / CELL_H });
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  material.map = tex;
  material.emissiveMap = tex;
  material.needsUpdate = true;

  const pos = new Float32Array(signed.length * 12), nor = new Float32Array(signed.length * 12), uv = new Float32Array(signed.length * 8);
  const idx: number[] = [];
  signed.forEach((s, i) => {
    const sign = s.sign!;
    const cell = used.get(s.label)!;
    let w = SIGN_H * cell.aspect, h = SIGN_H;
    if (w > sign.width) { h *= sign.width / w; w = sign.width; }
    const nx = Math.sin(sign.heading), nz = Math.cos(sign.heading);
    const uvs = [[cell.u0, cell.v0], [cell.u1, cell.v0], [cell.u1, cell.v1], [cell.u0, cell.v1]] as const;
    signCorners(sign, w, h).forEach((corner, k) => {
      const [u, v] = uvs[k]!;
      pos.set(corner, (i * 4 + k) * 3);
      nor.set([nx, 0, nz], (i * 4 + k) * 3);
      uv.set([u, v], (i * 4 + k) * 2);
    });
    const o = i * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('normal', new BufferAttribute(nor, 3));
  geo.setAttribute('uv', new BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new Mesh(geo, material);
  mesh.name = 'shopSigns';
  mesh.receiveShadow = true;
  return mesh;
}

/** Street furniture: instanced lamps and trees plus tram stops, limited to loaded chunks; all shop signs. */
export class Props {
  /** Lantern glass; Lighting drives its emissive intensity at night. */
  readonly lampGlass = new MeshStandardMaterial({ color: 0xdcd6c4, emissive: 0xffc98a, emissiveIntensity: 0, roughness: 0.2 });
  /** Additive halo sprites over the lanterns; Lighting drives the opacity. */
  readonly halo = new PointsMaterial({ size: 4, map: glowTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0, fog: true });
  private readonly lampMetal = new MeshStandardMaterial({ color: 0x2c3530, roughness: 0.55, metalness: 0.6 });
  private readonly trunkMat = new MeshStandardMaterial({ color: 0x5a4636, roughness: 0.95 });
  private readonly crownMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
  private readonly stopFrame = new MeshStandardMaterial({ color: 0x4a5258, roughness: 0.5, metalness: 0.15 });
  private readonly stopGlass = new MeshStandardMaterial({ color: 0xbcd0d8, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false });
  private readonly lamps: [InstancedMesh, InstancedMesh];
  private readonly trees: [InstancedMesh, InstancedMesh];
  private readonly haloPoints: Points;
  /** Tram shelters in the scene, by index in manifest.tramStops (names need not be unique). */
  private readonly stops = new Map<number, Group>();
  /** Shop sign boards; their lettering glows at night (setNight). */
  private readonly signMat = new MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.55 });

  constructor(private readonly scene: Scene, private readonly manifest: WorldManifest, private readonly terrain: TerrainGrid) {
    const signs = buildShopSigns(manifest.shops, this.signMat);
    if (signs) scene.add(signs);
    const lg = lampGeometries();
    const tg = treeGeometries();
    const n = manifest.lamps.length, t = manifest.trees.length;
    this.lamps = [new InstancedMesh(lg.metal, this.lampMetal, n), new InstancedMesh(lg.glass, this.lampGlass, n)];
    this.trees = [new InstancedMesh(tg.trunk, this.trunkMat, t), new InstancedMesh(tg.crown, this.crownMat, t)];
    this.trees[1].setColorAt(0, new Color()); // allocate instanceColor
    const haloGeo = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage));
    this.haloPoints = new Points(haloGeo, this.halo);
    this.haloPoints.frustumCulled = false;
    for (const m of [...this.lamps, ...this.trees]) {
      m.count = 0;
      m.castShadow = true;
      m.frustumCulled = false; // instances spread over the whole loaded area
      scene.add(m);
    }
    this.trees[1].receiveShadow = true;
    scene.add(this.haloPoints);
  }

  /** night 0..1: lit shop signs after dark. */
  setNight(night: number): void {
    this.signMat.emissiveIntensity = 1.1 * night;
  }

  /** Rebuilds the instance sets for the loaded chunks; call when that set changes. */
  rebuild(loaded: ReadonlySet<string>): void {
    const inside = (x: number, z: number) => loaded.has(chunkKey(x, z));
    const m = new Matrix4();

    const halo = this.haloPoints.geometry.getAttribute('position') as BufferAttribute;
    let i = 0;
    for (const [x, z] of this.manifest.lamps) {
      if (!inside(x, z)) continue;
      const { light } = lampMatrix(this.terrain, x, z, m);
      this.lamps[0].setMatrixAt(i, m);
      this.lamps[1].setMatrixAt(i, m);
      halo.setXYZ(i, light.x, light.y, light.z);
      i++;
    }
    for (const l of this.lamps) { l.count = i; l.instanceMatrix.needsUpdate = true; }
    this.haloPoints.geometry.setDrawRange(0, i);
    halo.needsUpdate = true;

    const c = new Color();
    i = 0;
    for (const [x, z] of this.manifest.trees) {
      if (!inside(x, z)) continue;
      treeMatrix(this.terrain, x, z, m);
      this.trees[0].setMatrixAt(i, m);
      this.trees[1].setMatrixAt(i, m);
      c.setHSL(0.24 + 0.06 * hash(x, z, 5), 0.42 + 0.15 * hash(x, z, 6), 0.2 + 0.08 * hash(x, z, 7));
      this.trees[1].setColorAt(i, c);
      i++;
    }
    for (const t of this.trees) { t.count = i; t.instanceMatrix.needsUpdate = true; }
    this.trees[1].instanceColor!.needsUpdate = true;
    for (const t of [...this.lamps, ...this.trees]) t.computeBoundingSphere();

    for (const [k, stop] of this.manifest.tramStops.entries()) {
      const want = inside(stop.x, stop.z);
      const have = this.stops.get(k);
      if (want && !have) {
        const g = stopGroup(stop, heightAt(this.terrain, stop.x, stop.z), this.stopFrame, this.stopGlass);
        this.scene.add(g);
        this.stops.set(k, g);
      } else if (!want && have) {
        this.scene.remove(have);
        have.traverse((o: Object3D) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          if (mesh.name === 'stopSign') (mesh.material as MeshStandardMaterial[])[4]!.map?.dispose();
          if (mesh.name === 'stopSign') (mesh.material as MeshStandardMaterial[])[4]!.dispose();
        });
        this.stops.delete(k);
      }
    }
  }
}
