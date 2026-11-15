import { wgs84ToLocal } from '@nn/shared';
import { crossSectionFromTags, reversed, type CrossSection, type SeparateSides } from './crosssection.js';
import { separateParkingSides, type ParkingArea } from './separateparking.js';

export type Pt = { x: number; z: number };
/** width = cross.carriageway (kerb to kerb); lanes = all car lanes; cross left/right relative to `points` order. */
export type Road = { id: number; name?: string; kind: string; points: Pt[]; width: number; oneway: boolean; lanes: number; cross: CrossSection };
export type OsmFeatures = {
  boundary: Pt[];
  roads: Road[];
  tramTracks: Pt[][];
  tramStops: { pos: Pt; name: string }[];
  greens: Pt[][];
  trees: Pt[];
  lamps: Pt[];
  /** shop=* plus eateries/pubs/pharmacies (amenity=*); type = the tag value. */
  shops: Shop[];
  squares: { name: string; outline: Pt[] }[];
};

export type Shop = { pos: Pt; name?: string; type: string; street?: string; housenumber?: string };

type LL = { lat: number; lon: number };
type Tags = Record<string, string>;
type El = { type: string; id: number; lat?: number; lon?: number; geometry?: LL[]; tags?: Tags; members?: { type: string; role: string; geometry?: LL[] }[] };

const BOUNDARY_ID = 2613766;
const ROAD_KINDS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street', 'service', 'footway', 'path', 'cycleway', 'pedestrian']);
const GREEN = (t: Tags) =>
  ['grass', 'village_green', 'recreation_ground'].includes(t.landuse ?? '') || ['park', 'garden'].includes(t.leisure ?? '');

/** amenity values that are shops for the game (they get a sign and a shop name). */
const SHOP_AMENITIES = new Set(['cafe', 'restaurant', 'fast_food', 'pub', 'bar', 'biergarten', 'ice_cream', 'pharmacy']);

/** Shop from tags, or undefined if the feature is no shop. */
function shopOf(pos: Pt, t: Tags): Shop | undefined {
  const type = t.shop ?? (SHOP_AMENITIES.has(t.amenity ?? '') ? t.amenity : undefined);
  if (!type) return undefined;
  const s: Shop = { pos, type };
  if (t.name) s.name = t.name;
  if (t['addr:street']) s.street = t['addr:street'];
  if (t['addr:housenumber']) s.housenumber = t['addr:housenumber'];
  return s;
}

const toPts = (g: LL[]): Pt[] => g.map((p) => wgs84ToLocal(p.lat, p.lon));
const isClosed = (p: Pt[]) => p.length >= 4 && p[0]!.x === p[p.length - 1]!.x && p[0]!.z === p[p.length - 1]!.z;

/** Joins ways end-to-end (reversing as needed) into rings; unclosed leftovers are dropped. */
export function joinRings(ways: Pt[][]): Pt[][] {
  const same = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.z - b.z) < 0.01;
  const rest = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings: Pt[][] = [];
  while (rest.length) {
    const ring = rest.shift()!;
    let grown = true;
    while (grown && !same(ring[0]!, ring[ring.length - 1]!)) {
      grown = false;
      const end = ring[ring.length - 1]!;
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i]!;
        if (same(w[0]!, end)) ring.push(...w.slice(1));
        else if (same(w[w.length - 1]!, end)) ring.push(...w.slice(0, -1).reverse());
        else continue;
        rest.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) {
      ring[ring.length - 1] = ring[0]!;
      rings.push(ring);
    }
  }
  return rings;
}

const centroid = (p: Pt[]): Pt => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, z: p.reduce((s, q) => s + q.z, 0) / p.length });

/** Ways tagged parking:*=separate wait for the parking areas (post-pass in parseOsm). */
const hasSeparateParking = (t: Tags) => ['left', 'right', 'both'].some((s) => t[`parking:${s}`] === 'separate');
const STREET_PARKING = new Set(['street_side', 'lane', 'layby']);

function parseRoad(el: El, pts: Pt[], t: Tags, separate: SeparateSides = {}): Road | undefined {
  const base = (t.highway ?? '').replace(/_link$/, '');
  const kind = base === 'trunk' ? 'primary' : base;
  if (!ROAD_KINDS.has(kind) || t.tunnel === 'yes' || pts.length < 2) return undefined;
  const reverse = t.oneway === '-1';
  const oneway = t.oneway === 'yes' || t.oneway === '1' || reverse || t.junction === 'roundabout';
  const tagged = crossSectionFromTags(t, kind, separate); // separate: relative to the way as drawn
  const cross = reverse ? reversed(tagged) : tagged;
  const lanes = cross.lanesForward + cross.lanesBackward;
  const road: Road = { id: el.id, kind, points: reverse ? [...pts].reverse() : pts, width: cross.carriageway, oneway, lanes, cross };
  if (t.name) road.name = t.name;
  return road;
}

export function parseOsm(json: unknown): OsmFeatures {
  const elements = ((json as { elements?: El[] }).elements ?? []) as El[];
  const f: OsmFeatures = { boundary: [], roads: [], tramTracks: [], tramStops: [], greens: [], trees: [], lamps: [], shops: [], squares: [] };

  const stops: { pos: Pt; name: string; prio: number }[] = [];
  const parkingAreas: ParkingArea[] = [];
  const pending: { index: number; el: El; pts: Pt[]; t: Tags }[] = [];
  for (const el of elements) {
    const t = el.tags ?? {};
    if (el.type === 'relation') {
      const outers = (el.members ?? []).filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry).map((m) => toPts(m.geometry!));
      if (el.id === BOUNDARY_ID) f.boundary = joinRings(outers).sort((a, b) => b.length - a.length)[0] ?? [];
      else if (GREEN(t)) f.greens.push(...joinRings(outers));
    } else if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const pos = wgs84ToLocal(el.lat, el.lon);
      if (t.natural === 'tree') f.trees.push(pos);
      else if (t.highway === 'street_lamp') f.lamps.push(pos);
      else if (isStopTags(t)) stops.push({ pos, name: t.name!, prio: t.public_transport === 'platform' ? 0 : 1 });
      else {
        const shop = shopOf(pos, t);
        if (shop) f.shops.push(shop);
      }
    } else if (el.type === 'way' && el.geometry) {
      const pts = toPts(el.geometry);
      const closed = isClosed(pts);
      if (t.railway === 'tram' || t.railway === 'light_rail') {
        if (t.tunnel !== 'yes' && pts.length >= 2) f.tramTracks.push(pts);
      } else if (t.public_transport === 'platform' && isStopTags(t)) {
        stops.push({ pos: centroid(closed ? pts.slice(0, -1) : pts), name: t.name!, prio: 0 });
      } else if (t.highway) {
        if (closed && (t.area === 'yes' || t.place === 'square' || t.highway === 'pedestrian')) f.squares.push({ name: t.name ?? '', outline: pts });
        else {
          const r = parseRoad(el, pts, t);
          if (r && hasSeparateParking(t)) pending.push({ index: f.roads.length, el, pts, t });
          if (r) f.roads.push(r);
        }
      } else if (closed && GREEN(t)) f.greens.push(pts);
      else if (closed && t.amenity === 'parking' && STREET_PARKING.has(t.parking ?? '')) {
        const area: ParkingArea = { ring: pts };
        const o = t.orientation ?? t['parking:orientation'];
        if (o) area.orientation = o;
        parkingAreas.push(area);
      } else {
        const shop = shopOf(centroid(closed ? pts.slice(0, -1) : pts), t);
        if (shop) f.shops.push(shop);
      }
    }
  }
  f.tramStops = dedupeStops(stops);
  // parking:*=separate becomes a strip where a street-side parking area runs alongside
  for (const p of pending) f.roads[p.index] = parseRoad(p.el, p.pts, p.t, separateParkingSides(p.pts, parkingAreas))!;
  return f;
}

/** Stadtbahn/tram stop: tram_stop node, stop_position for light rail/tram, or a named platform with rail evidence (railway=platform, tram/light_rail/train=yes); highway=bus_stop never. */
function isStopTags(t: Tags): boolean {
  if (!t.name) return false;
  if (t.railway === 'tram_stop') return true;
  if (t.highway === 'bus_stop') return false;
  const rail = t.light_rail === 'yes' || t.tram === 'yes';
  if (t.public_transport === 'stop_position') return rail;
  return t.public_transport === 'platform' && (rail || t.railway === 'platform' || t.train === 'yes');
}

/** Same-named stops within 60 m collapse to one; stop positions beat platform centres. */
function dedupeStops(stops: { pos: Pt; name: string; prio: number }[]): { pos: Pt; name: string }[] {
  const kept: { pos: Pt; name: string; prio: number }[] = [];
  for (const s of [...stops].sort((a, b) => b.prio - a.prio)) {
    if (!kept.some((k) => k.name === s.name && Math.hypot(k.pos.x - s.pos.x, k.pos.z - s.pos.z) < 60)) kept.push(s);
  }
  return kept.map(({ pos, name }) => ({ pos, name }));
}
