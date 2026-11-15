import { expect, test } from 'vitest';
import { assignShopLabels, GENERIC_NAMES, isNeusserAddress } from './shops.js';

test('real OSM name never shown', () => {
  const out = assignShopLabels([{ name: 'Echter Laden', type: 'bakery' }], {}, 1);
  expect(out[0]!.label).not.toContain('Echter Laden');
});

test('curated name used', () => expect(assignShopLabels([{ name: 'X', type: 'cafe' }], { X: 'Kaffee Klaaf' }, 1)[0]!.label).toBe('Kaffee Klaaf'));

test('generic name comes from the list of its type, unknown types from the fallback list', () => {
  const [bakery, odd] = assignShopLabels([{ name: 'Y', type: 'bakery' }, { type: 'hearing_aids' }], {}, 7);
  expect(GENERIC_NAMES.bakery).toContain(bakery!.label);
  expect(GENERIC_NAMES.fallback).toContain(odd!.label);
});

test('at least 8 invented names for every common type', () => {
  for (const t of ['kiosk', 'bakery', 'cafe', 'restaurant', 'hairdresser', 'supermarket', 'clothes', 'pharmacy', 'bar', 'fallback']) {
    expect(new Set(GENERIC_NAMES[t]).size, t).toBeGreaterThanOrEqual(8);
  }
});

test('same seed gives the same labels; neighbours of one type get different names', () => {
  const shops = Array.from({ length: 8 }, () => ({ type: 'kiosk' }));
  const a = assignShopLabels(shops, {}, 42).map((s) => s.label);
  expect(assignShopLabels(shops, {}, 42).map((s) => s.label)).toEqual(a);
  expect(new Set(a).size).toBe(8);
});

test('Neusser Str. addresses in OSM and NRW spelling', () => {
  expect(isNeusserAddress('Neusser Straße')).toBe(true);
  expect(isNeusserAddress('Neusser Str.')).toBe(true);
  expect(isNeusserAddress('Neusser Wall')).toBe(false);
  expect(isNeusserAddress(undefined)).toBe(false);
});
