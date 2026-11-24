import { expect, test } from 'vitest';
import { restartSecondsLeft, restartText } from './restart-banner';

test('no announcement gives null', () => {
  expect(restartSecondsLeft(0, 100)).toBeNull();
  expect(restartSecondsLeft(undefined, 100)).toBeNull();
});

test('rounds up and never goes below 0', () => {
  expect(restartSecondsLeft(3600, 0)).toBe(60);
  expect(restartSecondsLeft(3600, 3541)).toBe(1);
  expect(restartSecondsLeft(3600, 4000)).toBe(0);
});

test('text', () => {
  expect(restartText(42)).toBe('Die Stadt wird aktualisiert – Neustart in 0:42');
  expect(restartText(75)).toBe('Die Stadt wird aktualisiert – Neustart in 1:15');
  expect(restartText(0)).toBe('Die Stadt wird aktualisiert – Neustart jetzt');
  expect(restartText(null)).toBeNull();
});
