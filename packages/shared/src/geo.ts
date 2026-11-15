import proj4 from 'proj4';

// EPSG:25832 (ETRS89 / UTM 32N). Origin is the Neusser Straße / Wilhelmplatz area.
const UTM32 = '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs';
const WGS84 = 'WGS84';

export const ORIGIN_UTM = { e: 356198, n: 5647717 } as const;

/** UTM easting/northing (m) to local world coordinates: x east, z south. */
export function utmToLocal(e: number, n: number): { x: number; z: number } {
  return { x: e - ORIGIN_UTM.e, z: -(n - ORIGIN_UTM.n) };
}

export function wgs84ToLocal(lat: number, lon: number): { x: number; z: number } {
  const [e, n] = proj4(WGS84, UTM32, [lon, lat]) as [number, number];
  return utmToLocal(e, n);
}

export function localToWgs84(x: number, z: number): { lat: number; lon: number } {
  const e = x + ORIGIN_UTM.e;
  const n = -z + ORIGIN_UTM.n;
  const [lon, lat] = proj4(UTM32, WGS84, [e, n]) as [number, number];
  return { lat, lon };
}
