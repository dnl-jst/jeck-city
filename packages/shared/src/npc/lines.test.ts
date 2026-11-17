import { expect, test } from 'vitest';
import { LINE_CAUSES, linesFor, NPC_LINES } from './lines';

test('every cause has at least one line, ids unique', () => {
  for (const c of LINE_CAUSES) expect(linesFor(c).length).toBeGreaterThan(0);
  expect(new Set(NPC_LINES.map((l) => l.id)).size).toBe(NPC_LINES.length);
});

test('the three blocked lines are the agreed ones', () => {
  expect(linesFor('blocked').map((id) => NPC_LINES.find((l) => l.id === id)!.text)).toEqual([
    'Jank mer us de Föß!', 'Wat steihs do eröm wie ne Ölljötz?', 'Maach ens Plaatz, ich han et ielich!',
  ]);
});
