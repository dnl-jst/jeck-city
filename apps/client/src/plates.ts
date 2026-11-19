import {
  CanvasTexture, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, LinearFilter, type Matrix4, MeshStandardMaterial,
  type Object3D, PlaneGeometry, SRGBColorSpace,
} from 'three';

/**
 * Number plates drawn by the game: one quad per plate, lettered in the shader from a small glyph atlas, so every car
 * can carry its own text (plateText in @nn/shared) without a texture per car. Works instanced: the text travels as a
 * per-instance attribute.
 */

/** Plate size (m): the German standard plate, as the models' blank plates. */
export const PLATE_W = 0.52, PLATE_H = 0.11;
/** The glyphs of the atlas, by index; index 31 is the EU band. */
export const PLATE_GLYPHS = ' 0123456789KBNSUMGLEVD';
/** Characters across a plate (right of the EU band). */
export const PLATE_CELLS = 9;
const ATLAS_COLS = 32, EU_GLYPH = 31;
/** Node names of the plate positions in the car models (front, rear). */
export const PLATE_NODES = ['plate_f', 'plate_r'] as const;

/** The text centred in PLATE_CELLS cells as three numbers of three glyph indices each (base 32, first glyph lowest). */
export function encodePlate(text: string): [number, number, number] {
  const t = text.slice(0, PLATE_CELLS);
  const cells = (' '.repeat(Math.floor((PLATE_CELLS - t.length) / 2)) + t).padEnd(PLATE_CELLS, ' ');
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < PLATE_CELLS; c++) {
    const g = Math.max(0, PLATE_GLYPHS.indexOf(cells[c]!));
    out[Math.floor(c / 3) as 0 | 1 | 2] += g * 32 ** (c % 3);
  }
  return out;
}

/** The cells of a plate code as text (what the shader reads). */
export function decodePlate(code: readonly number[]): string {
  let s = '';
  for (let c = 0; c < PLATE_CELLS; c++) s += PLATE_GLYPHS[Math.floor(code[Math.floor(c / 3)]! / 32 ** (c % 3)) % 32] ?? ' ';
  return s;
}

/** The glyph atlas: ATLAS_COLS cells in a row, black characters on white; the last cell is the blue EU band. */
function atlas(): CanvasTexture {
  const cw = 64, ch = 128;
  const cv = document.createElement('canvas');
  cv.width = cw * ATLAS_COLS;
  cv.height = ch;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, cv.width, ch);
  g.fillStyle = '#111';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 96px "DIN Condensed", "Roboto Condensed", "Arial Narrow", "Liberation Sans Narrow", sans-serif';
  [...PLATE_GLYPHS].forEach((c, i) => {
    // squeezed to the cell: plate lettering is narrow
    const w = g.measureText(c).width;
    g.save();
    g.translate(i * cw + cw / 2, ch / 2 + 6);
    g.scale(Math.min(1, (cw - 6) / Math.max(w, 1)), 1);
    g.fillText(c, 0, 0);
    g.restore();
  });
  // EU band: blue, a ring of stars, the country letter
  const x = EU_GLYPH * cw;
  g.fillStyle = '#0a3aa0';
  g.fillRect(x, 0, cw, ch);
  g.fillStyle = '#f2c500';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.beginPath();
    g.arc(x + cw / 2 + Math.cos(a) * 15, 36 + Math.sin(a) * 15, 2.6, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#fff';
  g.font = '700 44px sans-serif';
  g.fillText('D', x + cw / 2, 92);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearFilter; // the shader steps from cell to cell: no mip seams, and plates are only lettered up close
  t.magFilter = LinearFilter;
  return t;
}

let shared: MeshStandardMaterial | null = null;

/** The plate material (one for all plates): reads its lettering from the instance attribute `plateCode`. */
function plateMaterial(): MeshStandardMaterial {
  if (shared) return shared;
  const m = new MeshStandardMaterial({ map: atlas(), roughness: 0.45, metalness: 0 });
  m.name = 'plate_text';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 plateCode;\nvarying vec3 vPlateCode;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPlateCode = plateCode;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPlateCode;')
      .replace('#include <map_fragment>', `
        {
          vec2 p = vMapUv;
          float eu = 0.105; // the EU band's share of the width
          vec2 at;
          if (p.x < eu) at = vec2((${EU_GLYPH}.0 + p.x / eu) / ${ATLAS_COLS}.0, p.y);
          else {
            float t = (p.x - eu) / (1.0 - eu) * ${PLATE_CELLS}.0;
            float c = min(floor(t), ${PLATE_CELLS - 1}.0);
            float pack = c < 3.0 ? vPlateCode.x : c < 6.0 ? vPlateCode.y : vPlateCode.z;
            float k = mod(c, 3.0);
            float g = mod(floor(pack / (k < 0.5 ? 1.0 : k < 1.5 ? 32.0 : 1024.0) + 0.001), 32.0);
            // inset a little, so linear filtering never reaches the neighbouring glyph
            at = vec2((g + 0.02 + 0.96 * (t - c)) / ${ATLAS_COLS}.0, p.y);
          }
          vec4 texel = texture2D(map, at);
          // a thin black border
          float edge = min(min(p.x, 1.0 - p.x) * ${(PLATE_W / PLATE_H).toFixed(3)}, min(p.y, 1.0 - p.y));
          if (edge < 0.05) texel.rgb = vec3(0.03);
          diffuseColor *= texel;
        }`);
  };
  shared = m;
  return m;
}

/** The plate positions of a car model as matrices relative to `model` (front, rear; fewer if the model has none). */
export function platePoses(model: Object3D): Matrix4[] {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const out: Matrix4[] = [];
  for (const n of PLATE_NODES) {
    const node = model.getObjectByName(n);
    if (node) out.push(inv.clone().multiply(node.matrixWorld));
  }
  return out;
}

/** Up to `capacity` plates as one instanced mesh. */
export class Plates {
  readonly mesh: InstancedMesh;
  private readonly codes: InstancedBufferAttribute;

  constructor(capacity: number) {
    const geo = new PlaneGeometry(PLATE_W, PLATE_H);
    this.codes = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.codes.setUsage(DynamicDrawUsage);
    geo.setAttribute('plateCode', this.codes);
    this.mesh = new InstancedMesh(geo, plateMaterial(), capacity);
    this.mesh.name = 'plates';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // spread over all near cars; a handful of quads
    this.mesh.receiveShadow = true;
  }

  get capacity(): number {
    return this.codes.count;
  }

  /** Letters plate k. */
  text(k: number, text: string): void {
    this.codes.setXYZ(k, ...encodePlate(text));
    this.codes.needsUpdate = true;
  }

  /** Places plate k at `matrix` (in the mesh's parent frame). */
  move(k: number, matrix: Matrix4): void {
    this.mesh.setMatrixAt(k, matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
