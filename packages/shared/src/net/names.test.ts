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
