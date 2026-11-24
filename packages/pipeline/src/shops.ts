/**
 * Shop sign labels. Real OSM names are never shown: a shop gets its curated, invented allusion
 * from data/shop-names.json (keyed by the OSM name) or else an invented generic name of its type.
 */

/**
 * Invented, Kölsch-flavoured names per OSM shop/amenity type (≥ 8 for the common ones), for the whole city:
 * no allusion to a single Veedel (those are in DISTRICT_NAMES).
 */
export const GENERIC_NAMES: Record<string, string[]> = {
  kiosk: ['Büdchen am Eck', 'Et Büdche', 'Büdche Sonnesching', 'Kiosk Om Eck', 'Et Bud vum Pitter', 'Büdche Jroß & Klein', 'Büdche Kölsch & Kaugummi', 'Et Nohbars-Büdche', 'Büdche Domspitz', 'Trinkhalle Rhingblick', 'Büdche Alaaf'],
  bakery: ['Bäckerei Röggelche', 'Et Bröttche', 'Bäckerei Knüppel & Co.', 'Backstuvv am Eck', 'Bäckerei Ovefrisch', 'Et Weckmännche', 'Bäckerei Sonnekruste', 'Backes Domkruste', 'Backes vum Rhing'],
  cafe: ['Café Klaaf', 'Kaffeebud', 'Café Verzäll', 'Café Fisternöllche', 'Café Om Balkon', 'Café Sonnesching', 'Kaffeeklatsch am Platz', 'Tässche Kölle', 'Café Hätzche'],
  restaurant: ['Weetschaff am Eck', 'Zum Dröppche', 'Halve-Hahn-Stuff', 'Taverna Rhing', 'Bistro Kumm erin', 'Restaurant Schäl Sick', 'Gasthaus Hätzlich', 'Trattoria Colonia', 'Himmel-un-Ääd-Stuvv', 'Restaurant Kappes & Ääpel'],
  fast_food: ['Imbiss Flönz', 'Pommesbud', 'Frittebud am Platz', 'Grillstuvv', 'Pizza Pittermann', 'Currywoosch-Eck', 'Imbiss Schnüsse', 'Döner-Eck am Ring', 'Rievkoochebud'],
  hairdresser: ['Salon Hoorschnigge', 'Frisör Krüllekopp', 'Salon Pläät', 'Schnibbelstuvv', 'Hoorstudio Löckche', 'Salon Fönix', 'Frisör Kamm eröm', 'Hoorpracht Kölle', 'Salon Schnäuzer & Söhne'],
  supermarket: ['Vürrod-Markt', 'Frischmarkt Veedel', 'Kaufhalle Kölsch', 'Allerlei-Markt', 'Einkaufsbud', 'Veedelsmarkt', 'Tante-Tünn-Markt', 'Krämerei Kölle', 'Markt Alaaf'],
  clothes: ['Fummel & Fransen', 'Plünnen am Eck', 'Mode Fisternöll', 'Jackett & Jeck', 'Et Stöffche', 'Boutique Bützche', 'Kleiderstange Kölle', 'Kleidsam am Ring', 'Boutique Kamelle'],
  pharmacy: ['Apotheke am Veedel', 'Apotheke Zum Pflästerche', 'Rhing-Apotheke', 'Apotheke Pillendöösje', 'Apotheke Hätzblatt', 'Apotheke Jesundheit!', 'Kamillen-Apotheke', 'Salbei-Apotheke', 'Apotheke Hoffnungsdröppche'],
  bar: ['Kneipe Zum Köbes', 'Et Pittermännche', 'Weetschaff Zappes', 'Bar Fisternöll', 'Zum halve Meter', 'Kneipe Kranz & Co.', 'Thekejlöck', 'Zur letzten Runde', 'Zapfhahn Kölle', 'Weetschaff Drink-doch-eine-met'],
  beauty: ['Kosmetikstuvv', 'Nagelstudio Fingerspetz', 'Schönheitsbud', 'Kosmetik Bützche', 'Lack & Lametta', 'Studio Schminkdöösje', 'Wellness-Eck am Platz', 'Glanzstück Kölle', 'Puderdöösje'],
  jewelry: ['Goldschmiede Klunker', 'Et Schmuckkästche', 'Juwelier Blinkblink', 'Ringelstuvv', 'Glitzer-Eck', 'Juwelier Funkel', 'Perlen & Pänz', 'Goldstück am Rhing', 'Juwelier Domglanz'],
  mobile_phone: ['Telefonbud', 'Akku-Eck', 'Handyklinik am Platz', 'Display-Doktor', 'Smartbud', 'Telefon-Pitter', 'Handy-Doktor Kölle', 'Funkloch am Ring', 'Akku Alaaf'],
  florist: ['Et Blömche', 'Blumen Bützche', 'Tulpenstuvv', 'Strüssjer am Eck', 'Blumen Sonnesching', 'Rusen-Eck', 'Jröne Daume', 'Blumenbud am Rhing', 'Strüssjer Alaaf'],
  vacant: ['Zu vermieten', 'Ladenlokal frei', 'Hier kütt jet Neues'],
  fallback: ['Laden am Eck', 'Krimskrams Kölle', 'Veedelsladen', 'Wundertüt', 'Kram & Klaaf', 'Lädche Sonnesching', 'Om Eck Handel', 'Allerlei vum Rhing', 'Kölsch Allerlei', 'Fundstück Kölle', 'Tünnes & Schäl Handel'],
};

/**
 * Names alluding to one Stadtteil, keyed by its OSM name (Shop.district) and then by type: only shops in that
 * Stadtteil draw them, in addition to GENERIC_NAMES. Further Stadtteile only need an entry here.
 */
export const DISTRICT_NAMES: Record<string, Record<string, string[]>> = {
  Nippes: {
    kiosk: ['Trinkhalle Nippesblick', 'Et Neppeser Büdche'],
    bakery: ['Backes Nippes', 'Neppeser Backstuvv'],
    cafe: ['Tässche Nippes', 'Café Neppes'],
    restaurant: ['Trattoria Nippesina', 'Weetschaff Neppes'],
    fast_food: ['Döner-Eck Nippes'],
    hairdresser: ['Haarstuvv Nippes'],
    supermarket: ['Krämerei Nippes'],
    clothes: ['Kleiderstange Nippes', 'Kleidsam Nippes'],
    pharmacy: ['Kamillen-Apotheke Nippes', 'Salbei-Apotheke Nippes'],
    bar: ['Zapfhahn Nippes', 'Neppeser Thekestuvv'],
    beauty: ['Glanzstück Nippes'],
    jewelry: ['Goldstück Nippes'],
    mobile_phone: ['Handy-Doktor Nippes', 'Funkloch Nippes'],
    florist: ['Blumenbud Nippes'],
    fallback: ['Nippeser Allerlei', 'Fundstück Nippes'],
  },
};

/** OSM types that share another type's name list. */
const ALIAS: Record<string, string> = { pub: 'bar', biergarten: 'bar', convenience: 'kiosk', ice_cream: 'cafe' };

/** Name list key of a type: its alias, itself, or the fallback list. */
const keyFor = (type: string): string => ALIAS[type] ?? (GENERIC_NAMES[type] ? type : 'fallback');

/** FNV-1a hash of a string. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** 32-bit integer mix (murmur3 finalizer). */
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Seeded Fisher–Yates permutation of 0..n-1. */
function permutation(n: number, seed: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = mix(seed + Math.imul(i, 0x9e3779b1)) % (i + 1);
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p;
}

/**
 * One label per shop, in input order: the curated name if the OSM name is in `curated`, else the next
 * name of a seeded shuffle of the type's list (so shops of one type cycle through all names before repeating).
 * Shops in a Stadtteil with DISTRICT_NAMES draw from the city-wide list plus its names, all others from the city-wide list only.
 */
export function assignShopLabels(shops: { name?: string; type: string; district?: string }[], curated: Record<string, string>, seed: number): { label: string }[] {
  const used = new Map<string, number>();
  return shops.map((s) => {
    const own = s.name !== undefined && Object.hasOwn(curated, s.name) ? curated[s.name] : undefined;
    if (own) return { label: own };
    const type = keyFor(s.type);
    const local = (s.district !== undefined && Object.hasOwn(DISTRICT_NAMES, s.district) ? DISTRICT_NAMES[s.district]![type] : undefined) ?? [];
    const list = local.length ? [...local, ...GENERIC_NAMES[type]!] : GENERIC_NAMES[type]!;
    const key = local.length ? `${s.district}:${type}` : type;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const order = permutation(list.length, (seed ^ mix(hash(key))) >>> 0);
    return { label: list[order[n % list.length]!]! };
  });
}

/** Address on Neusser Straße (OSM 'Neusser Straße', NRW 'Neusser Str.'). */
export const isNeusserAddress = (street: string | undefined): boolean => /^Neusser Str(\.|aße)$/.test(street ?? '');
