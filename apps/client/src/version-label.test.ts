import { expect, it } from 'vitest';
import { versionText } from './version-label';

it('shows the plain version, and client and server versions in debug mode', () => {
  expect(versionText('1.2.3', '1.2.3', false)).toBe('v1.2.3');
  expect(versionText('1.2.3', '1.2.2', true)).toBe('Client 1.2.3 · Server 1.2.2');
  expect(versionText('1.2.3', null, true)).toBe('Client 1.2.3 · Server –');
});
