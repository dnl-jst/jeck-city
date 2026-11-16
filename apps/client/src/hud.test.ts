import { describe, expect, it, test } from 'vitest';
import { FetchError, NoWebGLError } from './errors';
import { bootErrorMessage, CONTROLS_HINT, HUD_CSS, RIDE_HINT } from './hud';

describe('bootErrorMessage', () => {
  it('names missing WebGL', () => {
    expect(bootErrorMessage(new NoWebGLError('WebGL unavailable'))).toBe(
      'Dein Browser kann leider kein 3D (WebGL). Probier es mit einem aktuellen Chrome, Firefox oder Safari.');
  });
  it('asks for a reload on network/404 errors', () => {
    expect(bootErrorMessage(new FetchError('/world/manifest.json', 404))).toBe('Nippes konnte nicht geladen werden. Bitte lade die Seite neu.');
  });
  it('treats network failures (status 0) like load errors', () => {
    expect(bootErrorMessage(new FetchError('/world/manifest.json', 0))).toBe('Nippes konnte nicht geladen werden. Bitte lade die Seite neu.');
  });
  it('falls back for anything else', () => {
    expect(bootErrorMessage(new Error('boom'))).toBe('Da ist was schiefgelaufen. Bitte lade die Seite neu.');
  });
});

test('the hidden loading box lets clicks through to the canvas (pointer lock)', () => {
  const rule = /\.nn-loading\.nn-hidden\s*\{([^}]*)\}/.exec(HUD_CSS)?.[1] ?? '';
  expect(rule).toMatch(/opacity:\s*0/);
  expect(rule).toMatch(/pointer-events:\s*none/);
});

test('controls hint names radio and mute keys', () => {
  expect(CONTROLS_HINT).toBe('WASD laufen · Shift rennen · Leertaste springen · E Auto/Rad ein-/aussteigen · H hupen · R Radio · N Ton · M Karte · Maus umsehen (klicken)');
});

test('controls hint names the map key', () => {
  expect(CONTROLS_HINT).toContain('M Karte');
});

test('riding hint names the bike keys', () => {
  expect(RIDE_HINT).toBe('W treten · Shift antreten · S bremsen · Leertaste hüpfen · H klingeln · E absteigen');
});
