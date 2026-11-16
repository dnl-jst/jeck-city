import { describe, expect, it } from 'vitest';
import { checkName, dedupeName, NAME_ERRORS } from './names';

describe('names', () => {
  it('names: length, chars, collapse', () => {
    expect(checkName('  Jupp   Schmitz ')).toEqual({ ok: true, name: 'Jupp Schmitz' });
    expect(checkName('J')).toEqual({ ok: false, error: 'length' });
    expect(checkName('x'.repeat(21))).toEqual({ ok: false, error: 'length' });
    expect(checkName('Jupp<3')).toEqual({ ok: false, error: 'chars' });
    expect(checkName("Jupp-O_o.'s")).toMatchObject({ ok: true });
  });

  it('names: invisible and case duplicates', () => {
    expect(checkName('​​')).toEqual({ ok: false, error: 'length' });
    expect(checkName('😀😀')).toEqual({ ok: false, error: 'chars' });
    expect(checkName('..')).toEqual({ ok: false, error: 'chars' });
    expect(dedupeName('jupp', ['Jupp'])).toBe('jupp 2');
    expect(dedupeName('Jupp', ['Jupp', 'jupp 2'])).toBe('Jupp 3');
    expect(dedupeName('Jupp', ['Hein'])).toBe('Jupp');
  });

  it('dedupeName stays within 20 characters (the base is shortened, no trailing space)', () => {
    const full = 'Jupp Schmitz vom Rhe'; // 20
    expect(dedupeName(full, [full])).toBe('Jupp Schmitz vom R 2');
    // the cut lands on a space: trimmed before the number
    expect(dedupeName('Jupp Schmitz vonn Ab', ['Jupp Schmitz vonn Ab'])).toBe('Jupp Schmitz vonn 2');
    const taken = [full];
    for (let k = 2; k <= 10; k++) taken.push(dedupeName(full, taken));
    expect(taken.at(-2)).toBe('Jupp Schmitz vom R 9');
    expect(taken.at(-1)).toBe('Jupp Schmitz vom 10'); // the cut lands on a space: trimmed
    // code points, not UTF-16 units
    const wide = 'Ö𝔄lgötzenmüllerßchen'; // 20 code points, 21 UTF-16 units
    expect(dedupeName(wide, [wide])).toBe('Ö𝔄lgötzenmüllerßch 2');
  });

  it('names: leetspeak and umlaut filter', () => {
    expect(checkName('Arschl0ch')).toEqual({ ok: false, error: 'bad' });
    expect(checkName('ARSCHLOCH')).toEqual({ ok: false, error: 'bad' });
    expect(checkName('Scheiß')).toMatchObject({ ok: true }); // "scheiss" alone is not on the list
    expect(checkName('Sch31ßer')).toEqual({ ok: false, error: 'bad' });
    for (const n of ['Jeck', 'Rheinländer', 'Kölsch', 'Marschall', 'Essex']) expect(checkName(n)).toMatchObject({ ok: true });
  });

  it('has the exact error texts', () => {
    expect(NAME_ERRORS.length).toBe('Der Name muss 2–20 Zeichen lang sein.');
    expect(NAME_ERRORS.chars).toBe("Erlaubt sind Buchstaben, Ziffern, Leerzeichen und - _ . '");
    expect(NAME_ERRORS.bad).toBe('Bitte such dir einen anderen Namen aus.');
  });
});
