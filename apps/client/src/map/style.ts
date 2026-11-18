/** Night palette of the map (minimap and big map). */
export const MAP_STYLE = {
  bg: '#141a2b',
  building: '#252d44',
  green: '#1c3030',
  water: '#16304a',
  square: '#2c3350',
  tram: '#7f8fb8',
  boundary: 'rgba(242,196,107,0.35)',
  arrow: '#f2c46b',
  label: '#e8ecf8',
  labelHalo: 'rgba(10,12,20,0.9)',
};

export type RoadStyle = { color: string; widthPx: (scale: number) => number; rank: number };

// widthM: real-world width at high zoom; minPx: floor so roads stay visible when zoomed out.
const KINDS: Record<string, { color: string; widthM: number; minPx: number }> = {
  primary: { color: '#f2c46b', widthM: 12, minPx: 3 },
  secondary: { color: '#e0b878', widthM: 10, minPx: 2.5 },
  tertiary: { color: '#c9b497', widthM: 8, minPx: 2 },
  residential: { color: '#9aa3bd', widthM: 6, minPx: 1.5 },
  unclassified: { color: '#9aa3bd', widthM: 6, minPx: 1.5 },
  service: { color: '#6b7490', widthM: 4, minPx: 1 },
  footway: { color: '#50587a', widthM: 2, minPx: 1 },
};
const ORDER = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service', 'footway'];

/** Unknown kinds draw like residential. rank: lower = more important (drawn later, on top). */
export function roadStyle(kind: string): RoadStyle {
  const key = kind in KINDS ? kind : 'residential';
  const k = KINDS[key]!;
  return { color: k.color, rank: ORDER.indexOf(key), widthPx: (scale) => Math.max(k.minPx, k.widthM * scale) };
}
