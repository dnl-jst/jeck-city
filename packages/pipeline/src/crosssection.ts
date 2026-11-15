type Tags = Record<string, string>;
export type ParkOrientation = 'parallel' | 'diagonal' | 'perpendicular';

/** Kerb-to-kerb layout of a road; left/right relative to the way direction. All widths in metres. */
export type CrossSection = {
  lanesForward: number;
  lanesBackward: number;
  laneWidth: number;
  cycleLeft: number;
  cycleRight: number;
  parkLeft: number;
  parkRight: number;
  parkLeftOrientation: ParkOrientation | null;
  parkRightOrientation: ParkOrientation | null;
  /** Sum of all components = kerb to kerb. */
  carriageway: number;
};

const LANE_WIDTH = 3.25;
const NARROW_LANE_WIDTH = 3.0;
const NARROW = new Set(['residential', 'living_street']);
/** Ways without car lanes or kerbs: one "lane" of this width. */
const PATH_WIDTH: Record<string, number> = { service: 4, footway: 2.5, path: 2.5, cycleway: 2.5, pedestrian: 6 };
const CYCLE_LANE = 1.6;
const PARK_WIDTH: Record<ParkOrientation, number> = { parallel: 2.0, diagonal: 4.5, perpendicular: 5.0 };
const HALF_ON_KERB = 1.0;
const ORIENTATIONS = new Set<string>(['parallel', 'diagonal', 'perpendicular']);

const count = (v: string | undefined): number | undefined => {
  const n = Math.round(Number(v));
  return v !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
};

const isOneway = (t: Tags) => ['yes', '1', '-1'].includes(t.oneway ?? '') || t.junction === 'roundabout';

/** Cycle lane width on the carriageway for one side ('left' | 'right'). */
function cycleOn(t: Tags, side: 'left' | 'right'): number {
  const v = t[`cycleway:${side}`] ?? t['cycleway:both'] ?? t.cycleway;
  if (v === 'lane' || v === 'opposite_lane') {
    // a plain cycleway=opposite_lane only runs against the oneway, i.e. on the left
    if (v === 'opposite_lane' && t[`cycleway:${side}`] === undefined && t['cycleway:both'] === undefined && side === 'right') return 0;
    return CYCLE_LANE;
  }
  if (v !== undefined) return 0; // track, separate, no, shared_lane, …
  return t[`cycleway:${side}:lane`] !== undefined || t['cycleway:both:lane'] !== undefined ? CYCLE_LANE : 0;
}

/** Parking strip on the carriageway for one side: width and orientation (null without a strip). */
function parkOn(t: Tags, side: 'left' | 'right'): { width: number; orientation: ParkOrientation | null } {
  const none = { width: 0, orientation: null };
  const v = t[`parking:${side}`] ?? t['parking:both'];
  if (v !== undefined) {
    const o = t[`parking:${side}:orientation`] ?? t['parking:both:orientation'];
    const orientation: ParkOrientation = o !== undefined && ORIENTATIONS.has(o) ? (o as ParkOrientation) : 'parallel';
    if (v === 'lane' || v === 'street_side' || v === 'yes') return { width: PARK_WIDTH[orientation], orientation };
    if (v === 'half_on_kerb') return { width: HALF_ON_KERB, orientation };
    return none; // on_kerb, separate, no, …
  }
  // legacy scheme: parking:lane:<side>=<orientation>, position in parking:lane:<side>:<orientation>
  const legacy = t[`parking:lane:${side}`] ?? t['parking:lane:both'];
  if (legacy === undefined || !ORIENTATIONS.has(legacy)) return none;
  const orientation = legacy as ParkOrientation;
  const pos = t[`parking:lane:${side}:${orientation}`] ?? t[`parking:lane:both:${orientation}`];
  if (pos === 'on_kerb' || pos === 'painted_area_only' || pos === 'separate') return none;
  if (pos === 'half_on_kerb') return { width: HALF_ON_KERB, orientation };
  return { width: PARK_WIDTH[orientation], orientation };
}

/**
 * Cross-section from OSM tags. Lanes: lanes:forward/backward, else `lanes` (split ceil/floor on two-way roads),
 * else 2 (oneway 1); 3.25 m each (residential/living_street 3.0). Cycle lanes 1.6 m and parking strips
 * (parallel 2.0, diagonal 4.5, perpendicular 5.0, half_on_kerb 1.0) per side. A `width` tag sets the carriageway:
 * components scale proportionally, but the lanes never get narrower than their nominal width.
 * Paths and service roads are one lane of their class width.
 */
export function crossSectionFromTags(tags: Tags, kind: string): CrossSection {
  const width = Number.parseFloat(tags.width ?? '');
  if (kind in PATH_WIDTH) {
    const w = width > 0 ? width : PATH_WIDTH[kind]!;
    return { lanesForward: 1, lanesBackward: 0, laneWidth: w, cycleLeft: 0, cycleRight: 0, parkLeft: 0, parkRight: 0, parkLeftOrientation: null, parkRightOrientation: null, carriageway: w };
  }
  const oneway = isOneway(tags);
  const total = count(tags.lanes);
  let fwd = count(tags['lanes:forward']);
  let bwd = count(tags['lanes:backward']);
  if (fwd === undefined && bwd === undefined) {
    const n = total ?? (oneway ? 1 : 2);
    fwd = tags.oneway === '-1' ? 0 : oneway ? n : Math.ceil(n / 2); // oneway=-1: traffic runs against the way
    bwd = n - fwd;
  } else if (fwd === undefined) fwd = Math.max(oneway ? 1 : 0, (total ?? bwd! + 1) - bwd!);
  else if (bwd === undefined) bwd = oneway ? 0 : Math.max(0, (total ?? fwd + 1) - fwd);
  if (fwd! + bwd! === 0) fwd = 1;
  let laneWidth = NARROW.has(kind) ? NARROW_LANE_WIDTH : LANE_WIDTH;
  let cycleLeft = cycleOn(tags, 'left');
  let cycleRight = cycleOn(tags, 'right');
  const pl = parkOn(tags, 'left');
  const pr = parkOn(tags, 'right');
  let parkLeft = pl.width;
  let parkRight = pr.width;

  const lanes = (fwd! + bwd!) * laneWidth;
  const extras = cycleLeft + cycleRight + parkLeft + parkRight;
  if (width > 0) {
    const target = Math.max(width, lanes);
    if (target >= lanes + extras) {
      const k = target / (lanes + extras);
      laneWidth *= k; cycleLeft *= k; cycleRight *= k; parkLeft *= k; parkRight *= k;
    } else {
      const k = (target - lanes) / extras; // extras > 0 here
      cycleLeft *= k; cycleRight *= k; parkLeft *= k; parkRight *= k;
    }
  }
  const carriageway = (fwd! + bwd!) * laneWidth + cycleLeft + cycleRight + parkLeft + parkRight;
  return {
    lanesForward: fwd!, lanesBackward: bwd!, laneWidth, cycleLeft, cycleRight, parkLeft, parkRight,
    parkLeftOrientation: parkLeft > 0 ? pl.orientation : null, parkRightOrientation: parkRight > 0 ? pr.orientation : null, carriageway,
  };
}

/** The same cross-section seen against the way direction (for ways drawn backwards, oneway=-1). */
export function reversed(c: CrossSection): CrossSection {
  return {
    ...c, lanesForward: c.lanesBackward, lanesBackward: c.lanesForward, cycleLeft: c.cycleRight, cycleRight: c.cycleLeft,
    parkLeft: c.parkRight, parkRight: c.parkLeft, parkLeftOrientation: c.parkRightOrientation, parkRightOrientation: c.parkLeftOrientation,
  };
}
