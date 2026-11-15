import { BufferAttribute, type BufferGeometry, Color, type IUniform, MeshStandardMaterial } from 'three';

/**
 * Procedural Gründerzeit facades for the chunk `buildings` mesh, all in the fragment shader.
 * Attributes (GLTFLoader lowercases them): _facadeuv (wall: u = m along wall, v = m above the LoD2 base,
 * v < 0 on the plinth down to the terrain; roof: world x/z), _kind (0 wall, 1 roof), _seed ([0,1)), _flags (bit 0 Neusser shopfront,
 * bit 1 backdrop, bit 2 set on the client: carries a real shop sign) and _eave (added on the client by addEaveAttribute).
 */

/** _flags bit 2: the building has a shop sign board (props.ts), so its sign band stays plain. */
export const FLAG_SIGNED = 4;

/** Ten Cologne old-building plaster tones (sRGB). */
const PALETTE = [
  0xd8b170, // Ocker
  0xd3a39c, // Altrosa
  0xc8c6c0, // Hellgrau
  0xebe6dc, // Weiß
  0xcfb48c, // Sandstein
  0x8ea2b4, // Taubenblau
  0xe5d197, // Hellgelb
  0xdfa686, // Lachs
  0xa8b597, // Salbeigrün
  0xbf7f60, // Terrakotta
];

/** Signage band colours of shopfronts (sRGB). */
const SIGNS = [0x1f3b2c, 0x5a1a22, 0x1c2a4a, 0x1d1d1f, 0xe9e1cc, 0x7a4a1c];

/**
 * Per-vertex eave height of each wall surface: wall triangles are grouped into surfaces by shared
 * vertices; a surface's eave is its lowest vertex height that lies more than 1 m above its bottom
 * (rectangle: the top edge; gable wall: the corners, not the apex). Plinth vertices (v < 0) are ignored
 * for bottom and eave but get their surface's eave. Roof vertices get 0.
 */
export function wallEaves(index: ArrayLike<number>, kind: ArrayLike<number>, facadeUv: ArrayLike<number>, vertexCount: number): Float32Array {
  const parent = Int32Array.from({ length: vertexCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]!, b = index[t + 1]!, c = index[t + 2]!;
    if (kind[a] !== 0 || kind[b] !== 0 || kind[c] !== 0) continue;
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  // Plinth vertices (v < 0, below the LoD2 base on slopes) are welded to their wall but must not lower its bottom.
  const bottom = new Map<number, number>();
  for (let i = 0; i < vertexCount; i++) {
    if (kind[i] !== 0) continue;
    const r = find(i), v = facadeUv[i * 2 + 1]!;
    if (v < 0) continue;
    bottom.set(r, Math.min(bottom.get(r) ?? Infinity, v));
  }
  for (let i = 0; i < vertexCount; i++) {
    if (kind[i] === 0 && !bottom.has(find(i))) bottom.set(find(i), 0); // plinth-only surface
  }
  const eave = new Map<number, number>();
  for (let i = 0; i < vertexCount; i++) {
    if (kind[i] !== 0) continue;
    const r = find(i), v = facadeUv[i * 2 + 1]!;
    if (v >= 0 && v > bottom.get(r)! + 1) eave.set(r, Math.min(eave.get(r) ?? Infinity, v));
  }
  const out = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    if (kind[i] !== 0) continue;
    const r = find(i);
    out[i] = eave.get(r) ?? bottom.get(r)! + 1;
  }
  return out;
}

/** Adds the `_eave` attribute the facade shader needs to a chunk buildings geometry. */
export function addEaveAttribute(g: BufferGeometry): void {
  const n = g.getAttribute('position').count;
  const index = g.index?.array ?? Uint32Array.from({ length: n }, (_, i) => i);
  const eaves = wallEaves(index, g.getAttribute('_kind').array, g.getAttribute('_facadeuv').array, n);
  g.setAttribute('_eave', new BufferAttribute(eaves, 1));
}

const VERTEX_DECL = /* glsl */ `
attribute vec2 _facadeuv;
attribute float _kind;
attribute float _seed;
attribute float _flags;
attribute float _eave;
varying vec2 vFacadeUv;
varying float vKind;
varying float vSeed;
varying float vFlags;
varying float vEave;
varying vec3 vNnNormal;
`;

const VERTEX_MAIN = /* glsl */ `
vFacadeUv = _facadeuv;
vKind = _kind;
vSeed = _seed;
vFlags = _flags;
vEave = _eave;
vNnNormal = normal;
`;

const FRAGMENT_DECL = /* glsl */ `
varying vec2 vFacadeUv;
varying float vKind;
varying float vSeed;
varying float vFlags;
varying float vEave;
varying vec3 vNnNormal;
uniform float nightFactor;
uniform vec3 nnPalette[10];
uniform vec3 nnSigns[6];
uniform vec3 nnSky;

float nnHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float nnNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nnHash(i), nnHash(i + vec2(1, 0)), f.x), mix(nnHash(i + vec2(0, 1)), nnHash(i + vec2(1, 1)), f.x), f.y);
}
// 1 inside the axis-aligned box [lo, hi], 0 outside
float nnBox(vec2 p, vec2 lo, vec2 hi) {
  vec2 s = step(lo, p) * step(p, hi);
  return s.x * s.y;
}

// Gründerzeit window at local (x: m from axis centre, y: m above sill) with opening w × h.
// Writes colour; returns 1 where the pixel is glass.
// rnd: per-window random value (curtains).
float nnWindow(vec2 p, float w, float h, float rnd, vec3 plaster, inout vec3 col) {
  float hw = w * 0.5;
  vec3 stucco = mix(plaster, vec3(0.93, 0.91, 0.86), 0.45);
  // lintel cornice (Verdachung) with a shadow line under it
  if (nnBox(p, vec2(-hw - 0.22, h + 0.16), vec2(hw + 0.22, h + 0.36)) > 0.5) { col = stucco * 1.05; return 0.0; }
  if (nnBox(p, vec2(-hw - 0.22, h + 0.12), vec2(hw + 0.22, h + 0.16)) > 0.5) { col = plaster * 0.55; return 0.0; }
  // sill (Fensterbank) with shadow below
  if (nnBox(p, vec2(-hw - 0.12, -0.08), vec2(hw + 0.12, 0.0)) > 0.5) { col = stucco; return 0.0; }
  if (nnBox(p, vec2(-hw - 0.12, -0.13), vec2(hw + 0.12, -0.08)) > 0.5) { col = plaster * 0.62; return 0.0; }
  // surround (Fasche)
  if (nnBox(p, vec2(-hw - 0.13, 0.0), vec2(hw + 0.13, h + 0.12)) < 0.5) return 0.0;
  if (nnBox(p, vec2(-hw, 0.0), vec2(hw, h)) < 0.5) { col = stucco * 0.97; return 0.0; }
  // reveal (Laibung): sides and top in shadow, inset 0.11 m
  float rv = 0.11;
  if (p.y > h - rv || abs(p.x) > hw - rv) { col = plaster * (p.y > h - rv ? 0.36 : 0.5); return 0.0; }
  // white wooden frame with mullion and transom (T-window)
  vec2 q = vec2(abs(p.x), p.y);
  float fr = 0.055;
  float transom = h * 0.72;
  if (q.x > hw - rv - fr || p.y < fr || p.y > h - rv - fr || q.x < fr * 0.6 && p.y < transom || abs(p.y - transom) < fr * 0.6) {
    col = vec3(0.86, 0.85, 0.82);
    return 0.0;
  }
  // dark room behind the pane, net curtains (Gardinen) in about half the windows
  col = vec3(0.03, 0.035, 0.042) * (0.8 + 0.5 * p.y / h);
  float curtain = step(rnd, 0.5) * step(p.y, transom) * (0.85 + 0.15 * sin(p.x * 60.0));
  if (rnd < 0.15) curtain *= step(hw * 0.45, q.x); // drawn to the sides
  col = mix(col, vec3(0.42, 0.41, 0.38), curtain * 0.8);
  return 1.0 - 0.5 * curtain;
}

// pseudo lettering for sign bands: rows of 3x5-pixel glyphs; 1 on a stroke
float nnLetters(vec2 p, float seed) {
  vec2 g = floor(p / vec2(0.34, 0.42));
  vec2 f = fract(p / vec2(0.34, 0.42));
  vec2 px = floor(vec2(f.x * 4.0, f.y * 6.0));
  if (px.x > 2.0 || px.y > 4.0 || px.y < 0.0) return 0.0;
  float on = step(0.42, nnHash(g * 7.13 + px * vec2(1.3, 2.9) + seed * 50.0));
  // keep glyphs readable as letters: always fill the stem column
  return max(on, step(px.x, 0.0) * step(0.25, nnHash(g + seed)));
}

void nnRoof(out vec3 col, out float rough) {
  vec3 n = normalize(vNnNormal);
  vec2 xz = vFacadeUv;
  float tone = nnHash(vec2(vSeed * 91.7, 3.1));
  rough = 0.85;
  if (n.y > 0.97) { // flat roof: gravel / bitumen
    col = vec3(0.1, 0.1, 0.098) * (0.85 + 0.3 * nnNoise(xz * 0.7));
    return;
  }
  bool slate = nnHash(vec2(vSeed * 37.3, 5.7)) > 0.55;
  vec3 base = slate ? vec3(0.07, 0.08, 0.09) : vec3(0.22, 0.065, 0.04);
  base *= 0.85 + 0.3 * tone;
  vec2 dir = normalize(n.xz);
  float d = dot(xz, dir), a = dot(xz, vec2(-dir.y, dir.x));
  float rowH = slate ? 0.22 : 0.33;
  float row = floor(d / rowH);
  float fr = fract(d / rowH);
  float tile = floor(a / (slate ? 0.3 : 0.25) + row * 0.5);
  float fw = fwidth(d);
  float shade = mix(0.72, 1.0, smoothstep(0.0, 0.25, fr));
  float tv = 0.9 + 0.2 * nnHash(vec2(tile, row));
  float detail = 1.0 - smoothstep(0.03, 0.15, fw);
  col = base * mix(0.93, shade * tv, detail) * (0.85 + 0.3 * nnNoise(xz * 0.15));
  if (slate) rough = 0.6;
}

void nnWall(out vec3 col, out float rough, out vec3 emit, out float glass) {
  float u = vFacadeUv.x, v = vFacadeUv.y, seed = vSeed;
  float fw = max(fwidth(u), fwidth(v));
  bool shop = mod(floor(vFlags + 0.5), 2.0) > 0.5;
  bool backdrop = mod(floor((vFlags + 0.5) * 0.5), 2.0) > 0.5;
  bool hasSign = mod(floor((vFlags + 0.5) * 0.25), 2.0) > 0.5;
  vec3 plaster = nnPalette[int(min(floor(seed * 10.0), 9.0))];
  plaster *= 0.9 + 0.16 * nnHash(vec2(seed * 53.1, 1.7));
  plaster *= 0.95 + 0.07 * nnNoise(vec2(u, v) * 1.3) + 0.03 * nnNoise(vec2(u, v) * 6.0);
  plaster *= mix(0.82, 1.0, smoothstep(0.0, 2.5, v)); // splash grime
  col = plaster; rough = 0.92; emit = vec3(0.0); glass = 0.0;
  if (v < 0.0) {
    // plinth below the LoD2 base (downhill side on slopes): plain dark plaster/stone, no windows, shop or light
    col = nnPalette[int(min(floor(seed * 10.0), 9.0))] * 0.55 * (0.92 + 0.12 * nnNoise(vec2(u * 2.0, v * 4.0)));
    rough = 0.95;
    return;
  }
  if (backdrop) return;

  float h1 = nnHash(vec2(seed * 11.0, 1.3)), h2 = nnHash(vec2(seed * 13.0, 2.7)), h3 = nnHash(vec2(seed * 17.0, 4.1));
  float gf = shop ? 4.2 : 3.2 + (h1 - 0.5) * 0.3;
  float ww = 1.2 + (h2 - 0.5) * 0.24;
  float wh = 1.6 + (h3 - 0.5) * 0.3;
  float eave = vEave;
  float cell = floor(u / 2.6);
  float ax = u - (cell + 0.5) * 2.6;
  vec3 farCol = mix(plaster, vec3(0.05), 0.22);
  float far = smoothstep(0.08, 0.45, fw);
  float lit = 0.0;
  vec3 warm = mix(vec3(1.0, 0.62, 0.30), vec3(1.0, 0.82, 0.55), nnHash(vec2(cell, seed * 7.0)));

  if (v > eave + 0.02) {
    // gable / attic: plain plaster
  } else if (v > eave - 0.6) {
    // main cornice under the eaves: projecting band, dentil row, shadow line
    float cv = v - (eave - 0.6);
    vec3 stucco = mix(plaster, vec3(0.93, 0.91, 0.86), 0.5);
    if (cv > 0.4) col = stucco * 1.06;
    else if (cv > 0.3) col = stucco * 0.8;
    else if (cv > 0.14) col = fract(u / 0.3) < 0.5 ? stucco : stucco * 0.6;
    else if (cv > 0.06) col = stucco * 0.92;
    else col = plaster * 0.5;
  } else if (v < (shop ? 0.35 : 0.6)) {
    // plinth (Sockel)
    col = mix(plaster, vec3(0.2, 0.2, 0.19), 0.6) * (0.9 + 0.15 * nnNoise(vec2(u * 3.0, v * 9.0)));
    if (!shop && fract(u / 0.5) < 0.04) col *= 0.7;
  } else if (v < gf) {
    if (shop) {
      // shopfront: big glass, dark frames, door every few axes, sign band above
      float sh = nnHash(vec2(cell, seed * 31.0));
      vec3 frame = vec3(0.045, 0.048, 0.052);
      vec3 signCol = nnSigns[int(min(floor(nnHash(vec2(seed * 3.3, 9.1)) * 6.0), 5.0))];
      if (v > 3.95) col = mix(plaster, vec3(0.93, 0.91, 0.86), 0.4); // ledge
      else if (v > 3.88) col = plaster * 0.5;
      else if (v > 3.15) { // sign band
        col = signCol;
        float seg = floor(u / 7.8), su = u - seg * 7.8;
        float len = 2.4 + 3.0 * nnHash(vec2(seg, seed * 9.0));
        float lettering = nnBox(vec2(su, v), vec2(3.9 - len * 0.5, 3.3), vec2(3.9 + len * 0.5, 3.72))
          * nnLetters(vec2(su - 3.9 + len * 0.5, v - 3.3), seed);
        float bright = dot(signCol, vec3(0.33)) > 0.4 ? 1.0 : 0.0;
        vec3 ink = bright > 0.5 ? vec3(0.08, 0.08, 0.09) : vec3(0.92, 0.88, 0.75);
        if (hasSign) lettering = 0.0; // the real sign board hangs here
        col = mix(col, ink, lettering);
        emit = (signCol * 0.35 + lettering * (1.0 - bright) * vec3(1.0, 0.9, 0.7)) * 1.2;
        rough = 0.5;
      } else if (abs(ax) > 1.12) {
        col = plaster * 0.85; // pier between shop windows
      } else {
        bool door = sh < 0.22;
        float bottom = door ? 0.0 : 0.35;
        float topG = 3.0;
        vec2 p = vec2(abs(ax), v);
        if (p.y > topG || p.x > 1.04 || p.y < bottom + 0.06 || abs(p.y - 2.45) < 0.035 || door && p.x < 0.04) col = frame;
        else {
          // shop interior: shelves and goods, dim by day
          float shelf = step(0.82, fract(p.y / 0.55));
          float item = nnHash(floor(vec2(u * 5.0, p.y / 0.55)));
          vec3 goods = mix(vec3(0.07, 0.06, 0.05), vec3(0.11, 0.1, 0.09), item);
          col = mix(vec3(0.04, 0.042, 0.046), goods, step(p.y, 2.2) * (1.0 - shelf) * step(0.3, item));
          col *= 0.8 + 0.4 * smoothstep(3.0, 0.4, p.y);
          glass = 1.0; lit = step(sh, 0.9) * (p.y < 2.45 ? 1.0 : 0.55) * (0.45 + 4.0 * dot(col, vec3(0.33))); warm = vec3(1.0, 0.68, 0.4) * 0.45; }
        rough = 0.3;
      }
    } else {
      // ground floor windows (raised: Hochparterre)
      float sill = 1.05;
      glass = nnWindow(vec2(ax, v - sill), ww, min(wh, gf - sill - 0.5), nnHash(vec2(cell + seed * 61.0, 0.5)), plaster, col);
      lit = step(0.01, glass) * step(nnHash(vec2(cell * 1.7 + seed * 101.0, 0.5)), 0.35);
      if (glass < 0.5 && abs(v - (gf - 0.12)) < 0.12) col = mix(plaster, vec3(0.93, 0.91, 0.86), 0.35);
    }
  } else {
    // upper storeys: as many 3.2 m storeys as fit under the cornice, stretched to fit
    float avail = eave - 0.6 - gf;
    float sh0 = 3.2 + (h1 - 0.5) * 0.3;
    float n = floor(avail / sh0 + 0.3);
    if (n >= 1.0) {
      float sh = avail / n;
      float s = floor((v - gf) / sh);
      float sv = v - gf - s * sh;
      float sill = 0.85 + (sh - 3.2) * 0.35;
      float h = wh * clamp(sh / 3.2, 0.85, 1.2) - (s == n - 1.0 ? 0.15 : 0.0);
      if (sv < 0.16) col = mix(plaster, vec3(0.93, 0.91, 0.86), 0.3) * (sv < 0.04 ? 0.7 : 1.0); // string course
      else glass = nnWindow(vec2(ax, sv - sill), ww, h, nnHash(vec2(cell + seed * 61.0, s + 1.5)), plaster, col);
      lit = step(0.01, glass) * step(nnHash(vec2(cell * 1.7 + seed * 101.0, s + 1.5)), 0.35);
    }
  }
  if (glass > 0.5) rough = 0.15;
  // rooms: brighter towards the ceiling lamp, curtains glow
  float room = 0.55 + 0.45 * nnNoise(vec2(u * 2.5, v * 2.0));
  emit += lit * warm * (shop ? 1.0 : 0.6 * room * (glass < 0.99 ? 1.5 : 1.0));
  emit *= nightFactor;
  col = mix(col, farCol, far);
  glass *= 1.0 - far;
}
`;

const COLOR_MAIN = /* glsl */ `
vec3 nnCol; float nnRough; vec3 nnEmit = vec3(0.0); float nnGlass = 0.0;
if (vKind > 0.5) nnRoof(nnCol, nnRough);
else nnWall(nnCol, nnRough, nnEmit, nnGlass);
diffuseColor.rgb = nnCol;
`;

const EMISSIVE_MAIN = /* glsl */ `
// glass: a little sky reflection by day (fresnel), lit rooms at night
float nnFres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.0);
totalEmissiveRadiance += nnGlass * nnSky * (0.03 + 0.3 * nnFres) * (1.0 - nightFactor);
totalEmissiveRadiance += nnEmit;
`;

export type FacadeMaterial = MeshStandardMaterial & { userData: { nightFactor: IUniform<number>; sky: IUniform<Color> } };

/** MeshStandardMaterial with the procedural facade shader; drive `userData.nightFactor.value` (0..1) and `userData.sky.value` (glass reflection). */
export function createFacadeMaterial(): FacadeMaterial {
  const mat = new MeshStandardMaterial({ roughness: 0.9, metalness: 0 }) as FacadeMaterial;
  const nightFactor: IUniform<number> = { value: 0 };
  mat.userData.nightFactor = nightFactor;
  const sky: IUniform<Color> = { value: new Color(0x9cc3e8) };
  mat.userData.sky = sky;
  const toLinear = (hex: number) => new Color(hex);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.nightFactor = nightFactor;
    shader.uniforms.nnPalette = { value: PALETTE.map(toLinear) };
    shader.uniforms.nnSigns = { value: SIGNS.map(toLinear) };
    shader.uniforms.nnSky = sky;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${COLOR_MAIN}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = nnRough;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${EMISSIVE_MAIN}`);
  };
  mat.customProgramCacheKey = () => 'nn-facade-1';
  return mat;
}
