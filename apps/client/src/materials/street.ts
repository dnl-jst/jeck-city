import { Color, MeshStandardMaterial } from 'three';

/**
 * Procedural street surfaces. Street meshes carry POSITION and TEXCOORD_0 in metres
 * (ribbons: u along, v across; polygons: world x/z) but no normals, hence flatShading.
 * Asphalt, grass and squares are patterned from world x/z so overlapping ribbons look identical
 * (no visible z-fighting); sidewalk slabs and kerb joints follow the ribbon uv.
 */

type Kind = 'road' | 'sidewalk' | 'curb' | 'tram' | 'trackbed' | 'green' | 'squares' | 'ground';

const SPEC: Record<Kind, { id: number; color: number; roughness: number; metalness: number; offset: number }> = {
  // offset: polygonOffset factor; positive pushes back (the layers lie ≤ 5 mm apart)
  // ground plane under everything (forecourts, yards): paving
  ground: { id: 6, color: 0x8a877f, roughness: 0.95, metalness: 0, offset: 4 },
  green: { id: 4, color: 0x4f6e34, roughness: 0.95, metalness: 0, offset: 3 },
  squares: { id: 5, color: 0xa9a397, roughness: 0.85, metalness: 0, offset: 2 },
  road: { id: 0, color: 0x4a4c50, roughness: 0.9, metalness: 0, offset: 1 },
  // track bed (built from the rails by the pipeline, see packages/pipeline/src/trackbed.ts): concrete with grooved rails
  trackbed: { id: 7, color: 0xffffff, roughness: 0.8, metalness: 0, offset: 0.5 },
  tram: { id: 3, color: 0xd4d8dd, roughness: 0.25, metalness: 0.15, offset: 0 },
  sidewalk: { id: 1, color: 0x9d9b95, roughness: 0.9, metalness: 0, offset: 0 },
  curb: { id: 2, color: 0xb9b7b0, roughness: 0.85, metalness: 0, offset: 0 },
};

/** Draw order of street meshes, back layers first. */
export const STREET_RENDER_ORDER: Record<string, number> = { ground: -1, green: 0, squares: 1, road: 2, trackbed: 3, tram: 4, sidewalk: 5, curb: 5 };

const DECL = /* glsl */ `
varying vec2 vNnUv;
varying vec2 vNnXz;
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
// antialiased joint mask (1 on a joint) of a grid with cell size s and joint width j; fades to its mean when too small
float nnJoints(vec2 p, vec2 s, float j) {
  vec2 d = abs(fract(p / s) - 0.5) * s; // distance from cell centre
  vec2 fw = fwidth(p);
  vec2 m = smoothstep(s * 0.5 - j - fw, s * 0.5 - j + fw, d);
  float joint = max(m.x, m.y);
  float fade = smoothstep(0.3, 1.0, max(fw.x / s.x, fw.y / s.y) * 4.0);
  return mix(joint, 2.0 * j / min(s.x, s.y), fade);
}
`;

const FRAG = /* glsl */ `
{
  vec2 uv = vNnUv, xz = vNnXz;
  float k = 1.0;
#if NN_STREET == 0
  k = 0.86 + 0.14 * nnNoise(xz * 0.12) + 0.08 * nnNoise(xz * 2.3) + 0.1 * (nnHash(floor(xz * 40.0)) - 0.5);
#elif NN_STREET == 1
  vec2 cell = floor(uv / vec2(0.4, 0.4));
  k = (0.9 + 0.14 * nnHash(cell)) * (0.94 + 0.08 * nnNoise(uv * 0.5));
  k *= 1.0 - 0.45 * nnJoints(uv, vec2(0.4, 0.4), 0.008);
#elif NN_STREET == 2
  k = (0.92 + 0.08 * nnHash(vec2(floor(uv.x), 1.0))) * (1.0 - 0.4 * nnJoints(uv, vec2(1.0, 10.0), 0.006));
#elif NN_STREET == 4
  k = 0.75 + 0.3 * nnNoise(xz * 0.35) + 0.12 * nnNoise(xz * 3.0);
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.15, 1.05, 0.7), nnNoise(xz * 0.08 + 7.0) * 0.6);
#elif NN_STREET == 5
  vec2 p = vec2(xz.x + 0.1 * floor(xz.y / 0.2), xz.y);
  k = (0.9 + 0.12 * nnHash(floor(p / 0.2))) * (0.95 + 0.06 * nnNoise(xz * 0.3));
  k *= 1.0 - 0.35 * nnJoints(p, vec2(0.2, 0.2), 0.012);
#elif NN_STREET == 7
  // uv.y: metres across from the rail centre, + towards the track centre
  float a = uv.y;
  float fwa = fwidth(a);
  vec3 bed = vec3(0.035, 0.036, 0.038) * (0.8 + 0.3 * nnNoise(xz * 1.5)); // dark asphalt fill
  vec3 band = vec3(0.13, 0.13, 0.125) * (0.9 + 0.12 * nnNoise(xz * 3.0)); // worn concrete strip along the rail
  vec3 steel = vec3(0.8, 0.82, 0.85);
  vec3 groove = vec3(0.03);
  float aa = max(fwa, 0.004);
  float inBand = smoothstep(0.2 + aa, 0.2 - aa, a) * smoothstep(-0.12, -0.12 + 2.0 * aa, a);
  vec3 c = mix(bed, band, inBand);
  c = mix(c, groove, smoothstep(0.02 + aa, 0.02 - aa, abs(a - 0.065))); // groove on the inner side
  float head = smoothstep(0.045 + aa, 0.045 - aa, abs(a));
  c = mix(c, steel, head);
  // far away: blend to the mean so the thin lines do not shimmer but stay visible as a band
  float far = smoothstep(0.02, 0.08, fwa);
  c = mix(c, mix(bed, steel, 0.25 * step(abs(a), 0.25)), far);
  diffuseColor.rgb = c;
#elif NN_STREET == 6
  k = (0.92 + 0.08 * nnHash(floor(xz / 0.5))) * (0.85 + 0.2 * nnNoise(xz * 0.2));
  k *= 1.0 - 0.25 * nnJoints(xz, vec2(0.5, 0.5), 0.008);
#endif
  diffuseColor.rgb *= k;
}
`;

/** One shared material per street mesh name. */
export function createStreetMaterials(): Record<string, MeshStandardMaterial> {
  const out: Record<string, MeshStandardMaterial> = {};
  for (const [name, s] of Object.entries(SPEC) as [Kind, (typeof SPEC)[Kind]][]) {
    const mat = new MeshStandardMaterial({
      color: new Color(s.color), roughness: s.roughness, metalness: s.metalness, flatShading: true,
      polygonOffset: s.offset !== 0, polygonOffsetFactor: s.offset, polygonOffsetUnits: s.offset * 4,
    });
    mat.defines = { NN_STREET: s.id };
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vNnUv;\nvarying vec2 vNnXz;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNnUv = uv;\nvNnXz = (modelMatrix * vec4(position, 1.0)).xz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${DECL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG}`);
    };
    mat.customProgramCacheKey = () => `nn-street-${s.id}`;
    out[name] = mat;
  }
  return out;
}
