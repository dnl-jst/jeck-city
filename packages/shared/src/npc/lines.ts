/**
 * What NPCs say (speech bubbles; later voices per id). Kölsch, shown without translation. The ids go over the wire,
 * the text stays on the client: keep ids stable when adding lines.
 */
export type LineCause = 'blocked' | 'blockedCar' | 'hit' | 'getup' | 'smalltalk';
export const LINE_CAUSES: readonly LineCause[] = ['blocked', 'blockedCar', 'hit', 'getup', 'smalltalk'];

export const NPC_LINES: readonly { id: number; cause: LineCause; text: string }[] = [
  { id: 0, cause: 'blocked', text: 'Jank mer us de Föß!' }, // Geh mir aus den Füßen!
  { id: 1, cause: 'blocked', text: 'Wat steihs do eröm wie ne Ölljötz?' }, // Was stehst du da rum wie ein Ölgötze?
  { id: 2, cause: 'blocked', text: 'Maach ens Plaatz, ich han et ielich!' }, // Mach mal Platz, ich hab's eilig!
  { id: 3, cause: 'blockedCar', text: 'Fahr doch, do Dröömdüppe!' }, // Fahr doch, du Schlafmütze!
  { id: 4, cause: 'hit', text: 'Bes do jeck?!' }, // Bist du verrückt?!
  { id: 5, cause: 'getup', text: 'Et hätt noch immer jot jejange.' }, // Es ist noch immer gut gegangen.
  { id: 6, cause: 'smalltalk', text: 'Wie et kütt, kütt et.' },
  { id: 7, cause: 'smalltalk', text: 'Et es wie et es.' },
  { id: 8, cause: 'smalltalk', text: 'Drinks de ene met?' },
];

const byCause = new Map<LineCause, number[]>(LINE_CAUSES.map((c) => [c, NPC_LINES.filter((l) => l.cause === c).map((l) => l.id)]));

/** Ids of the lines for a cause. */
export const linesFor = (cause: LineCause): readonly number[] => byCause.get(cause)!;

/** The text of line `id` (undefined for an unknown id). */
export const lineText = (id: number): string | undefined => NPC_LINES.find((l) => l.id === id)?.text;
