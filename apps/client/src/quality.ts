/**
 * Graphics quality levels. 'high' is the full look (all lights, big shadow maps, up to 2× pixel ratio); 'low' (the
 * default) and 'medium' trade the most expensive parts for frame rate: every light in the scene is evaluated in every
 * pixel of every standard material (also at intensity 0), so fewer lights is the biggest saving, then resolution and
 * shadows. Everything but antialiasing switches live (G); antialiasing is a WebGL context option, read at startup.
 */
export type QualityLevel = 'minimal' | 'low' | 'medium' | 'high';

export const QUALITY_LEVELS: readonly QualityLevel[] = ['minimal', 'low', 'medium', 'high'];

export const QUALITY_LABEL: Record<QualityLevel, string> = { minimal: 'Sehr niedrig', low: 'Niedrig', medium: 'Mittel', high: 'Hoch' };

export type Quality = {
  /** Upper bound of the renderer pixel ratio (devicePixelRatio is capped at this). */
  pixelRatio: number;
  /** MSAA (startup only). */
  antialias: boolean;
  /** Real point lights at the nearest street lamps. */
  lampLights: number;
  /** Disco ball spot lights (of 8; picked evenly round the ball). */
  discoDots: number;
  /** The own car's red tail-lamp spot lights (the lamp glass glows regardless). */
  tailLights: boolean;
  /** Shadow map size of the own car's headlight beams; 0 = the beams cast no shadows. */
  beamShadow: number;
  /** Sun shadow map size; 0 = no sun shadows at all (no shadow pass). */
  sunShadow: number;
  /** Sun shadows are cast within this radius (m) around the camera. */
  shadowRadius: number;
  /** Street trees cast shadows within this radius (m). */
  treeShadowRadius: number;
  /**
   * View distance (m) by day: the fog is opaque here (night: shorter) and the camera's far plane sits at the fog's end,
   * so everything beyond is culled instead of drawn invisibly.
   */
  viewDistance: number;
  /** World chunks are loaded when their centre is within this radius (m)… */
  loadRadius: number;
  /** …and unloaded beyond this one. */
  unloadRadius: number;
  /** Street trees are drawn within this radius (m). */
  treeRadius: number;
  /** Parked cars are drawn within this radius (m). */
  carRadius: number;
  /** Rain streaks / snow flakes around the camera at full intensity. */
  precipDrops: number;
};

export const QUALITY: Record<QualityLevel, Quality> = {
  high: {
    pixelRatio: 2, antialias: true, lampLights: 8, discoDots: 8, tailLights: true, beamShadow: 1024, sunShadow: 2048, shadowRadius: 150, treeShadowRadius: 80,
    viewDistance: 650, loadRadius: 600, unloadRadius: 800, treeRadius: 250, carRadius: 150, precipDrops: 20000,
  },
  medium: {
    pixelRatio: 1.5, antialias: true, lampLights: 5, discoDots: 4, tailLights: false, beamShadow: 512, sunShadow: 2048, shadowRadius: 100, treeShadowRadius: 50,
    viewDistance: 450, loadRadius: 420, unloadRadius: 600, treeRadius: 190, carRadius: 120, precipDrops: 12000,
  },
  // phones and tablets: no shadow pass, fewest lights, the shortest view
  minimal: {
    pixelRatio: 1, antialias: false, lampLights: 2, discoDots: 0, tailLights: false, beamShadow: 0, sunShadow: 0, shadowRadius: 0, treeShadowRadius: 0,
    viewDistance: 280, loadRadius: 250, unloadRadius: 380, treeRadius: 110, carRadius: 70, precipDrops: 3000,
  },
  low: {
    pixelRatio: 1, antialias: false, lampLights: 3, discoDots: 2, tailLights: false, beamShadow: 0, sunShadow: 1024, shadowRadius: 70, treeShadowRadius: 30,
    viewDistance: 300, loadRadius: 280, unloadRadius: 450, treeRadius: 140, carRadius: 90, precipDrops: 6000,
  },
};

/** The most of each light kind any level uses: they are all created once, the level only hides some. */
export const MAX_LAMP_LIGHTS = Math.max(...QUALITY_LEVELS.map((l) => QUALITY[l].lampLights));

export const DEFAULT_QUALITY: QualityLevel = 'low';
/** The default on phones and tablets (a coarse primary pointer). */
export const DEFAULT_TOUCH_QUALITY: QualityLevel = 'minimal';

/** localStorage key of the chosen level (a per-viewer convenience; missing storage = the default). */
const QUALITY_KEY = 'nn.quality';

/** The level from `?quality=` if valid, else the stored one, else the default (`fallback`). */
export function storedQuality(param: string | null = null, fallback: QualityLevel = DEFAULT_QUALITY): QualityLevel {
  if (param && (QUALITY_LEVELS as readonly string[]).includes(param)) return param as QualityLevel;
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v && (QUALITY_LEVELS as readonly string[]).includes(v)) return v as QualityLevel;
  } catch {
    // storage blocked: default
  }
  return fallback;
}

export function storeQuality(v: QualityLevel): void {
  try {
    localStorage.setItem(QUALITY_KEY, v);
  } catch {
    // storage blocked: the choice just is not remembered
  }
}

/** The next level for the G key: minimal → low → medium → high → minimal. */
export const nextQuality = (v: QualityLevel): QualityLevel => QUALITY_LEVELS[(QUALITY_LEVELS.indexOf(v) + 1) % QUALITY_LEVELS.length]!;

/** Which of `total` lights (fanned evenly round a circle) stay on when only `n` may: an even spread of indices. */
export function spreadIndices(total: number, n: number): Set<number> {
  const out = new Set<number>();
  const k = Math.max(0, Math.min(total, n));
  for (let i = 0; i < k; i++) out.add(Math.floor((i * total) / k));
  return out;
}
