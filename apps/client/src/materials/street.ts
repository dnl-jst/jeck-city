import { Color, MeshStandardMaterial } from 'three';

/**
 * Procedural street surfaces. Street meshes carry POSITION and TEXCOORD_0 in metres
 * (ribbons: u along, v across; polygons: world x/z) but no normals, hence flatShading. The exception is the
 * terrain `ground` mesh: it has normals, is smooth shaded and turns from paving to grass on slopes.
 * Asphalt, grass and squares are patterned from world x/z so overlapping ribbons look identical
 * (no visible z-fighting); sidewalk slabs and kerb joints follow the ribbon uv.
 * Markings (white / red cycle crossings by the `_mark` attribute) are plain lit paint: at night they only show
 * where lamps or headlights reach. Parking strips: lighter asphalt with a band of setts along the kerb (uv.y).
 */

type Kind = 'road' | 'sidewalk' | 'curb' | 'tram' | 'trackbed' | 'green' | 'squares' | 'ground' | 'parking' | 'markings' | 'water' | 'bridge' | 'steel';

const SPEC: Record<Kind, { id: number; color: number; roughness: number; metalness: number; offset: number }> = {
  // offset: polygonOffset factor; positive pushes back (the layers lie ≤ 5 mm apart)
  // ground plane under everything (forecourts, yards): paving
  ground: { id: 6, color: 0x8a877f, roughness: 0.95, metalness: 0, offset: 4 },
  green: { id: 4, color: 0x4f6e34, roughness: 0.95, metalness: 0, offset: 3 },
  squares: { id: 5, color: 0xa9a397, roughness: 0.85, metalness: 0, offset: 2 },
  road: { id: 0, color: 0x4a4c50, roughness: 0.9, metalness: 0, offset: 1 },
  parking: { id: 8, color: 0x4a4c50, roughness: 0.9, metalness: 0, offset: 0.8 },
  // paint colours come from the shader (_mark)
  markings: { id: 9, color: 0xffffff, roughness: 0.75, metalness: 0, offset: 0.6 },
  // track bed (built from the rails by the pipeline, see packages/pipeline/src/trackbed.ts): concrete with grooved rails
  trackbed: { id: 7, color: 0xffffff, roughness: 0.8, metalness: 0, offset: 0.5 },
  tram: { id: 3, color: 0xd4d8dd, roughness: 0.25, metalness: 0.15, offset: 0 },
  sidewalk: { id: 1, color: 0x9d9b95, roughness: 0.9, metalness: 0, offset: 0 },
  curb: { id: 2, color: 0xb9b7b0, roughness: 0.85, metalness: 0, offset: 0 },
  // the Rhine: a glossy surface with moving ripples (normals from animated noise) that mirrors the sky at grazing angles
  water: { id: 11, color: 0x23332f, roughness: 0.12, metalness: 0, offset: 0 },
  // bridge slabs, parapets and piers: concrete (uv: metres along, metres up)
  bridge: { id: 10, color: 0xa29e95, roughness: 0.9, metalness: 0, offset: 0 },
  // the truss arches of the railway bridges (Hohenzollernbrücke, Südbrücke): painted steel, grey-green
  steel: { id: 12, color: 0x6c7a72, roughness: 0.55, metalness: 0.35, offset: 0 },
};

/** Seconds for the water ripples; the game advances it every frame (shared by all water meshes). */
export const WATER_TIME = { value: 0 };

/**
 * Ground slope (degrees) where grass starts to replace the paving, and where it is all grass: the shader's grass
 * share is 1 − smoothstep(cos FULL, cos START, world normal y).
 */
export const GRASS_SLOPE_START = 15;
export const GRASS_SLOPE_FULL = 25;

/** Draw order of street meshes, back layers first. */
export const STREET_RENDER_ORDER: Record<string, number> = {
  ground: -1, water: -0.5, bridge: 0, steel: 0, green: 0, squares: 1, road: 2, parking: 2.3, markings: 2.6, trackbed: 3, tram: 4, sidewalk: 5, curb: 5,
};

const DECL = /* glsl */ `
varying vec2 vNnUv;
varying vec2 vNnXz;
varying float vNnMark;
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
#elif NN_STREET == 8
  // uv.y: metres from the kerb; setts (16 cm, running bond) in the first 0.5 m, then slightly lighter asphalt
  float kA = 1.1 * (0.86 + 0.14 * nnNoise(xz * 0.12) + 0.08 * nnNoise(xz * 2.3) + 0.1 * (nnHash(floor(xz * 40.0)) - 0.5));
  vec2 sp = vec2(uv.x + 0.08 * floor(uv.y / 0.16), uv.y);
  float kS = 1.3 * (0.85 + 0.2 * nnHash(floor(sp / 0.16))) * (1.0 - 0.45 * nnJoints(sp, vec2(0.16, 0.16), 0.012));
  float fwv = max(fwidth(uv.y), 1e-4);
  float band = smoothstep(0.5 + fwv, 0.5 - fwv, uv.y);
  k = mix(kA, kS, band);
#elif NN_STREET == 9
  // worn paint: patches and speckles where the asphalt (same pattern as the road) shows through
  float kR = 0.86 + 0.14 * nnNoise(xz * 0.12) + 0.08 * nnNoise(xz * 2.3) + 0.1 * (nnHash(floor(xz * 40.0)) - 0.5);
  vec3 asphalt = vec3(0.068, 0.072, 0.08) * kR;
  vec3 paint = mix(vec3(0.78, 0.78, 0.76), vec3(0.5, 0.06, 0.04), vNnMark);
  float wear = 0.45 * smoothstep(0.55, 0.9, nnNoise(xz * 1.3)) + 0.35 * step(0.82, nnHash(floor(xz * 25.0)));
  diffuseColor.rgb = mix(paint, asphalt, clamp(wear * (0.9 + 0.2 * nnNoise(xz * 0.07)), 0.0, 0.85));
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
#elif NN_STREET == 10
  // board-marked concrete: lifts every 0.6 m (uv.y), panels every 4 m (uv.x), weathering streaks
  float lifts = nnJoints(vec2(uv.x, uv.y), vec2(4.0, 0.6), 0.01);
  k = (0.8 + 0.14 * nnNoise(uv * vec2(0.3, 1.5)) + 0.06 * nnNoise(xz * 2.0)) * (1.0 - 0.18 * lifts);
  k *= 1.0 - 0.12 * smoothstep(0.4, 0.9, nnNoise(vec2(uv.x * 1.7, uv.y * 0.15)));
#elif NN_STREET == 11
  k = 0.9 + 0.1 * nnNoise(xz * 0.05);
#elif NN_STREET == 12
  // weathered paint: rust-tinted streaks along the members
  k = 0.85 + 0.15 * nnNoise(vec2(uv.x * 0.8, uv.y * 3.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.24, 0.18), 0.25 * smoothstep(0.6, 0.95, nnNoise(xz * 0.7 + uv.x * 0.3)));
#elif NN_STREET == 6
  k = (0.92 + 0.08 * nnHash(floor(xz / 0.5))) * (0.85 + 0.2 * nnNoise(xz * 0.2));
  k *= 1.0 - 0.25 * nnJoints(xz, vec2(0.5, 0.5), 0.008);
  // slopes (embankments, unmapped verges) turn to grass, coloured and patterned like the green areas
  float grass = 1.0 - smoothstep(NN_GRASS_COS_FULL, NN_GRASS_COS_START, normalize(vNnWorldNormal).y);
  vec3 turf = NN_GRASS_COLOR * (0.75 + 0.3 * nnNoise(xz * 0.35) + 0.12 * nnNoise(xz * 3.0));
  turf *= mix(vec3(1.0), vec3(1.15, 1.05, 0.7), nnNoise(xz * 0.08 + 7.0) * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb * k, turf, grass);
  k = 1.0;
#endif
  diffuseColor.rgb *= k;
}
`;

const WATER_NORMAL = /* glsl */ `
#if NN_STREET == 11
{
  // ripples: gradient of drifting noise layers (the Rhine flows north, −z), tilted into the view-space normal
  float t = nnTime;
  vec2 q = vNnXz;
  vec2 g = vec2(0.0);
  const float e = 0.12;
  for (int i = 0; i < 3; i++) {
    float f = i == 0 ? 0.18 : (i == 1 ? 0.6 : 1.9);
    float a = i == 0 ? 1.0 : (i == 1 ? 0.45 : 0.18);
    vec2 drift = i == 0 ? vec2(0.02, -0.35) : (i == 1 ? vec2(-0.25, -0.5) : vec2(0.4, -0.2));
    vec2 p = q * f + drift * t * f * 3.0 + float(i) * 17.0;
    float n0 = nnNoise(p);
    g += a * vec2(nnNoise(p + vec2(e, 0.0)) - n0, nnNoise(p + vec2(0.0, e)) - n0) / e;
  }
  vec3 tilt = (viewMatrix * vec4(-g.x * 0.18, 0.0, -g.y * 0.18, 0.0)).xyz;
  normal = normalize(normal + tilt);
}
#endif
`;
const WATER_SKY = /* glsl */ `
#if NN_STREET == 11 && defined(USE_FOG)
{
  // the sky at grazing angles (Schlick fresnel, water F0 ≈ 0.02), approximated by the fog colour
  float cosV = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fres, 0.0, 0.85));
}
#endif
`;

const glslFloat = (x: number): string => x.toFixed(6);
const GRASS_LINEAR = new Color(SPEC.green.color); // three converts the sRGB hex to linear
// only the ground mesh has normals: the others would read a zero normal
const NORMAL_DECL = '#if NN_STREET == 6\nvarying vec3 vNnWorldNormal;\n#endif\n';

/** One shared material per street mesh name. */
export function createStreetMaterials(): Record<string, MeshStandardMaterial> {
  const out: Record<string, MeshStandardMaterial> = {};
  for (const [name, s] of Object.entries(SPEC) as [Kind, (typeof SPEC)[Kind]][]) {
    const mat = new MeshStandardMaterial({
      color: new Color(s.color), roughness: s.roughness, metalness: s.metalness, flatShading: name !== 'ground',
      polygonOffset: s.offset !== 0, polygonOffsetFactor: s.offset, polygonOffsetUnits: s.offset * 4,
    });
    mat.defines = { NN_STREET: s.id };
    if (name === 'ground') {
      Object.assign(mat.defines, {
        NN_GRASS_COS_FULL: glslFloat(Math.cos(GRASS_SLOPE_FULL * Math.PI / 180)),
        NN_GRASS_COS_START: glslFloat(Math.cos(GRASS_SLOPE_START * Math.PI / 180)),
        NN_GRASS_COLOR: `vec3(${glslFloat(GRASS_LINEAR.r)}, ${glslFloat(GRASS_LINEAR.g)}, ${glslFloat(GRASS_LINEAR.b)})`,
      });
    }
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec2 vNnUv;\nvarying vec2 vNnXz;\nvarying float vNnMark;\n#if NN_STREET == 9\nattribute float _mark;\n#endif\n${NORMAL_DECL}`)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNnUv = uv;\nvNnXz = (modelMatrix * vec4(position, 1.0)).xz;\n#if NN_STREET == 9\nvNnMark = _mark;\n#else\nvNnMark = 0.0;\n#endif\n'
          + '#if NN_STREET == 6\nvNnWorldNormal = mat3(modelMatrix) * objectNormal;\n#endif');
      shader.uniforms.nnTime = WATER_TIME;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float nnTime;\n${DECL}${NORMAL_DECL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${WATER_NORMAL}`)
        .replace('#include <fog_fragment>', `${WATER_SKY}\n#include <fog_fragment>`);
    };
    mat.customProgramCacheKey = () => `nn-street-${s.id}`;
    out[name] = mat;
  }
  return out;
}
