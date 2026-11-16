import { describe, expect, it } from 'vitest';
import { NAME_ERRORS } from '@nn/shared';
import { validate } from './lobby';

describe('lobby validate', () => {
  it("lobby rejects 'J' with the length text", () => {
    expect(validate('J')).toBe('Der Name muss 2–20 Zeichen lang sein.');
    expect(validate('   ')).toBe(NAME_ERRORS.length);
    expect(validate('x'.repeat(21))).toBe(NAME_ERRORS.length);
  });

  it('rejects unlisted characters and accepts normal names', () => {
    expect(validate('Jupp<script>')).toBe(NAME_ERRORS.chars);
    expect(validate('Jupp')).toBeNull();
    expect(validate("  Änne-Lise_2 O'Neil. ")).toBeNull();
  });
});
