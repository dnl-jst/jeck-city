import { describe, expect, it } from 'vitest';
import { FetchError, NoWebGLError } from './errors';
import { bootErrorMessage } from './hud';

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
