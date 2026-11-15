/**
 * Gründerzeit storey layout of a facade wall, shared by the facade shader (facade.ts mirrors it in GLSL) and the
 * shop sign boards (props.ts). Heights in metres above the building's ground.
 */

/** Residential storeys: ground floor (Hochparterre), upper storey height range (per building seed), windows. */
export const STOREY = {
  ground: 4.5,
  min: 3.5,
  max: 3.9,
  /** Window opening height and parapet (Brüstung) below it. */
  window: 1.9,
  parapet: 0.9,
  /** The raised ground floor's floor level above the pavement; its windows sit a parapet above it. */
  groundFloorLevel: 0.6,
  /** Window decoration above the opening (Verdachung incl. its shadow line). */
  lintel: 0.36,
  /** Main cornice band under the eave. */
  cornice: 0.6,
  /** A ground-floor window lower than this is left out on low buildings. */
  minWindow: 1.0,
} as const;

/** Shopfront ground floor (flag bit 0): glass, sign band and ledge. */
export const SHOP = {
  ground: 4.6,
  glassTop: 3.4,
  transom: 2.8,
  signBottom: 3.6,
  signTop: 4.35,
} as const;

export type StoreyLayout = {
  /** Top of the ground floor. */
  ground: number;
  /** Upper storey height. */
  storey: number;
  /** Upper storeys: floor((eave − ground) / storey). */
  count: number;
  /** Bottom of the cornice band; above the last storey and below it lies the attic (plain plaster). */
  corniceBottom: number;
  shop: boolean;
};

/**
 * Layout of a wall with eave height `eave`; rnd ∈ [0, 1) is the building's storey jitter (3.5–3.9 m). The cornice
 * band takes the top 0.6 m but never reaches below the last window row's lintel, so no row is cut.
 */
export function storeyLayout(eave: number, rnd: number, shop: boolean): StoreyLayout {
  const ground = shop ? SHOP.ground : STOREY.ground;
  const storey = STOREY.min + (STOREY.max - STOREY.min) * rnd;
  const count = Math.max(0, Math.floor((eave - ground) / storey));
  const lastTop = count > 0 ? ground + (count - 1) * storey + STOREY.parapet + STOREY.window + STOREY.lintel : 0;
  return { ground, storey, count, corniceBottom: Math.max(eave - STOREY.cornice, lastTop), shop };
}

/** Sill height of the (non-shop) ground floor windows. */
export const GROUND_SILL = STOREY.groundFloorLevel + STOREY.parapet;

/** Window rows as drawn: ground floor (residential only, shrunk or dropped on low walls), then the upper storeys. */
export function windowRows(l: StoreyLayout): { sill: number; height: number }[] {
  const rows: { sill: number; height: number }[] = [];
  if (!l.shop) {
    const h = Math.min(STOREY.window, Math.min(l.ground, l.corniceBottom) - GROUND_SILL - STOREY.lintel);
    if (h >= STOREY.minWindow) rows.push({ sill: GROUND_SILL, height: h });
  }
  for (let s = 0; s < l.count; s++) rows.push({ sill: l.ground + s * l.storey + STOREY.parapet, height: STOREY.window });
  return rows;
}
