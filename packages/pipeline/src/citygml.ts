import { XMLParser } from 'fast-xml-parser';

export type SurfaceKind = 'wall' | 'roof' | 'ground' | 'closure';
/** UTM e, n, z; without repeated closing point. */
export type Ring = [number, number, number][];
export type Surface = { kind: SurfaceKind; outer: Ring; holes: Ring[] };
export type CityBuilding = {
  id: string;
  street?: string;
  number?: string;
  roofType: string;
  measuredHeight: number;
  surfaces: Surface[];
};

const ARRAY_TAGS = new Set([
  'core:cityObjectMember',
  'gml:surfaceMember',
  'bldg:boundedBy',
  'bldg:consistsOfBuildingPart',
  'gml:interior',
  'bldg:address',
]);

const SURFACE_TAGS: [string, SurfaceKind][] = [
  ['bldg:WallSurface', 'wall'],
  ['bldg:RoofSurface', 'roof'],
  ['bldg:GroundSurface', 'ground'],
  ['bldg:ClosureSurface', 'closure'],
];

type Node = any; // parsed XML is untyped

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const text = (n: Node): string | undefined => {
  if (n == null) return undefined;
  if (typeof n === 'object') return n['#text'] != null ? String(n['#text']).trim() : undefined;
  return String(n).trim();
};

function parseRing(ringNode: Node): Ring | null {
  const s = text(ringNode?.['gml:LinearRing']?.['gml:posList']);
  if (!s) return null;
  const v = s.split(/\s+/).map(Number);
  const ring: Ring = [];
  for (let i = 0; i + 2 < v.length; i += 3) {
    const p: [number, number, number] = [v[i]!, v[i + 1]!, v[i + 2]!];
    if (p.some((c) => !Number.isFinite(c))) return null;
    const q = ring[ring.length - 1];
    if (q && q[0] === p[0] && q[1] === p[1] && q[2] === p[2]) continue; // consecutive duplicate
    ring.push(p);
  }
  while (ring.length > 1) { // drop closing point(s)
    const f = ring[0]!, l = ring[ring.length - 1]!;
    if (f[0] === l[0] && f[1] === l[1] && f[2] === l[2]) ring.pop();
    else break;
  }
  return ring.length >= 3 ? ring : null;
}

function collectSurfaces(holder: Node, out: Surface[]): void {
  for (const bb of holder['bldg:boundedBy'] ?? []) {
    for (const [tag, kind] of SURFACE_TAGS) {
      const surf = bb?.[tag];
      if (!surf) continue;
      for (const m of surf['bldg:lod2MultiSurface']?.['gml:MultiSurface']?.['gml:surfaceMember'] ?? []) {
        const poly = m?.['gml:Polygon'];
        if (!poly) continue;
        const outer = parseRing(poly['gml:exterior']);
        if (!outer) continue;
        const holes: Ring[] = [];
        for (const i of poly['gml:interior'] ?? []) {
          const h = parseRing(i);
          if (h) holes.push(h);
        }
        out.push({ kind, outer, holes });
      }
    }
  }
}

/** First Thoroughfare in the first address that has one (depth-first search of xAL tree). */
function findThoroughfare(n: Node): Node | undefined {
  if (n == null || typeof n !== 'object') return undefined;
  if (n['xal:Thoroughfare']) {
    const t = n['xal:Thoroughfare'];
    return Array.isArray(t) ? t[0] : t;
  }
  for (const k of Object.keys(n)) {
    if (k.startsWith('@_')) continue;
    const r = findThoroughfare(Array.isArray(n[k]) ? n[k][0] : n[k]);
    if (r) return r;
  }
  return undefined;
}

function parseBuilding(b: Node): CityBuilding {
  const surfaces: Surface[] = [];
  collectSurfaces(b, surfaces);

  let roofType = text(b['bldg:roofType']);
  let height = Number(text(b['bldg:measuredHeight']));
  let tallest: { h: number; roofType?: string } | undefined;
  for (const part of b['bldg:consistsOfBuildingPart'] ?? []) {
    const p = part?.['bldg:BuildingPart'];
    if (!p) continue;
    collectSurfaces(p, surfaces);
    const h = Number(text(p['bldg:measuredHeight']));
    if (Number.isFinite(h) && (!tallest || h > tallest.h)) tallest = { h, roofType: text(p['bldg:roofType']) };
  }
  if (!Number.isFinite(height) && tallest) height = tallest.h;
  if (!roofType) roofType = tallest?.roofType;

  let street: string | undefined, number: string | undefined;
  const t = findThoroughfare(b['bldg:address']?.[0]);
  if (t) {
    street = text(t['xal:ThoroughfareName']);
    number = text(t['xal:ThoroughfareNumber']);
  }
  const res: CityBuilding = {
    id: String(b['@_gml:id'] ?? ''),
    roofType: roofType ?? '',
    measuredHeight: Number.isFinite(height) ? height : 0,
    surfaces,
  };
  if (street) res.street = street;
  if (number) res.number = number;
  return res;
}

export function parseCityGml(xml: string): CityBuilding[] {
  const doc = parser.parse(xml);
  const members: Node[] = doc['core:CityModel']?.['core:cityObjectMember'] ?? [];
  const out: CityBuilding[] = [];
  for (const m of members) if (m?.['bldg:Building']) out.push(parseBuilding(m['bldg:Building']));
  return out;
}
