import { expect, test } from 'vitest';
import { weatherPreset, type Weather } from '@nn/shared';
import { badgeText } from './badge';

function wx(kind: Weather['kind'], temperature: number, label = 'x'): Weather {
  return { ...(weatherPreset('clear', 0) as Weather), known: true, kind, temperature, label };
}

test('no text without known weather', () => {
  expect(badgeText(null, false)).toBeNull();
  expect(badgeText({ ...wx('rain', 5), known: false }, false)).toBeNull();
});

test('rain at 7.2 degrees', () => {
  expect(badgeText(wx('rain', 7.2, 'leichter Regen'), false)).toBe('☂ 7 °C · leichter Regen');
});

test('no negative zero, typographic minus', () => {
  expect(badgeText(wx('clear', -0.4), false)).toContain(' 0 °C');
  expect(badgeText(wx('clear', -0.4), false)).not.toContain('−0');
  expect(badgeText(wx('snow', -3.6), false)).toContain('−4 °C');
});

test('icons by kind', () => {
  expect(badgeText(wx('clear', 10), false)).toContain('☀');
  expect(badgeText(wx('clear', 10), true)).toContain('☾');
  expect(badgeText(wx('cloudy', 10), false)).toContain('☁');
  expect(badgeText(wx('fog', 10), false)).toContain('≋');
  expect(badgeText(wx('drizzle', 10), false)).toContain('☂');
  expect(badgeText(wx('rain', 10), false)).toContain('☂');
  expect(badgeText(wx('snow', 10), false)).toContain('❄');
});
