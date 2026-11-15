/**
 * Shop sign labels. Real OSM names are never shown: a shop gets its curated, invented allusion
 * from data/shop-names.json (keyed by the OSM name) or else an invented generic name of its type.
 */

/** Invented, Kölsch-flavoured names per OSM shop/amenity type (≥ 8 for the common ones). */
export const GENERIC_NAMES: Record<string, string[]> = {
  kiosk: ['Büdchen am Eck', 'Et Büdche', 'Büdche Sonnesching', 'Kiosk Om Eck', 'Et Bud vum Pitter', 'Büdche Jroß & Klein', 'Trinkhalle Nippesblick', 'Büdche Kölsch & Kaugummi', 'Et Nohbars-Büdche'],
  bakery: ['Bäckerei Röggelche', 'Backes Nippes', 'Et Bröttche', 'Bäckerei Knüppel & Co.', 'Backstuvv am Eck', 'Bäckerei Ovefrisch', 'Et Weckmännche', 'Bäckerei Sonnekruste'],
  cafe: ['Café Klaaf', 'Kaffeebud', 'Café Verzäll', 'Café Fisternöllche', 'Tässche Nippes', 'Café Om Balkon', 'Café Sonnesching', 'Kaffeeklatsch am Platz'],
  restaurant: ['Weetschaff am Eck', 'Zum Dröppche', 'Trattoria Nippesina', 'Halve-Hahn-Stuff', 'Taverna Rhing', 'Bistro Kumm erin', 'Restaurant Schäl Sick', 'Gasthaus Hätzlich'],
  fast_food: ['Imbiss Flönz', 'Döner-Eck Nippes', 'Pommesbud', 'Frittebud am Platz', 'Grillstuvv', 'Pizza Pittermann', 'Currywoosch-Eck', 'Imbiss Schnüsse'],
  hairdresser: ['Salon Hoorschnigge', 'Frisör Krüllekopp', 'Salon Pläät', 'Schnibbelstuvv', 'Hoorstudio Löckche', 'Salon Fönix', 'Frisör Kamm eröm', 'Haarstuvv Nippes'],
  supermarket: ['Krämerei Nippes', 'Vürrod-Markt', 'Frischmarkt Veedel', 'Kaufhalle Kölsch', 'Allerlei-Markt', 'Einkaufsbud', 'Veedelsmarkt', 'Tante-Tünn-Markt'],
  clothes: ['Kleiderstange Nippes', 'Fummel & Fransen', 'Plünnen am Eck', 'Mode Fisternöll', 'Jackett & Jeck', 'Et Stöffche', 'Boutique Bützche', 'Kleidsam Nippes'],
  pharmacy: ['Apotheke am Veedel', 'Kamillen-Apotheke Nippes', 'Apotheke Zum Pflästerche', 'Rhing-Apotheke', 'Apotheke Pillendöösje', 'Salbei-Apotheke Nippes', 'Apotheke Hätzblatt', 'Apotheke Jesundheit!'],
  bar: ['Kneipe Zum Köbes', 'Et Pittermännche', 'Weetschaff Zappes', 'Bar Fisternöll', 'Zum halve Meter', 'Kneipe Kranz & Co.', 'Thekejlöck', 'Zur letzten Runde', 'Zapfhahn Nippes'],
  beauty: ['Kosmetikstuvv', 'Nagelstudio Fingerspetz', 'Schönheitsbud', 'Kosmetik Bützche', 'Lack & Lametta', 'Glanzstück Nippes', 'Studio Schminkdöösje', 'Wellness-Eck am Platz'],
  jewelry: ['Goldschmiede Klunker', 'Et Schmuckkästche', 'Juwelier Blinkblink', 'Ringelstuvv', 'Glitzer-Eck', 'Juwelier Funkel', 'Goldstück Nippes', 'Perlen & Pänz'],
  mobile_phone: ['Handy-Doktor Nippes', 'Telefonbud', 'Akku-Eck', 'Handyklinik am Platz', 'Funkloch Nippes', 'Display-Doktor', 'Smartbud', 'Telefon-Pitter'],
  florist: ['Et Blömche', 'Blumen Bützche', 'Blumenbud Nippes', 'Tulpenstuvv', 'Strüssjer am Eck', 'Blumen Sonnesching', 'Rusen-Eck', 'Jröne Daume'],
  vacant: ['Zu vermieten', 'Ladenlokal frei', 'Hier kütt jet Neues'],
  fallback: ['Nippeser Allerlei', 'Laden am Eck', 'Krimskrams Kölle', 'Veedelsladen', 'Wundertüt', 'Kram & Klaaf', 'Fundstück Nippes', 'Lädche Sonnesching', 'Om Eck Handel', 'Allerlei vum Rhing'],
};

/** OSM types that share another type's name list. */
const ALIAS: Record<string, string> = { pub: 'bar', biergarten: 'bar', convenience: 'kiosk', ice_cream: 'cafe' };

const listFor = (type: string): string[] => GENERIC_NAMES[ALIAS[type] ?? type] ?? GENERIC_NAMES.fallback!;

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
 */
export function assignShopLabels(shops: { name?: string; type: string }[], curated: Record<string, string>, seed: number): { label: string }[] {
  const used = new Map<string, number>();
  return shops.map((s) => {
    const own = s.name !== undefined && Object.hasOwn(curated, s.name) ? curated[s.name] : undefined;
    if (own) return { label: own };
    const list = listFor(s.type);
    const key = ALIAS[s.type] ?? (GENERIC_NAMES[s.type] ? s.type : 'fallback');
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const order = permutation(list.length, (seed ^ mix(key.length * 7919 + key.charCodeAt(0))) >>> 0);
    return { label: list[order[n % list.length]!]! };
  });
}

/** Address on Neusser Straße (OSM 'Neusser Straße', NRW 'Neusser Str.'). */
export const isNeusserAddress = (street: string | undefined): boolean => /^Neusser Str(\.|aße)$/.test(street ?? '');
