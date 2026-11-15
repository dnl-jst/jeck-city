import { readFileSync } from 'node:fs';
import { parseOsm, type OsmFeatures } from './osm.js';

/** Test helper: parsed osm-small.json. */
export const loadFixture = (): OsmFeatures =>
  parseOsm(JSON.parse(readFileSync(new URL('../fixtures/osm-small.json', import.meta.url), 'utf8')));
