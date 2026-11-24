/**
 * Short German/English block list, matched as substrings against a normalised name
 * (lowercase, umlauts → ae/oe/ue/ss, leetspeak undone, only a-z left). Entries are kept long enough
 * to avoid false hits in ordinary names ("Marsch", "Essex", "Jeck", "Kölsch" must pass).
 */
export const BAD_WORDS: readonly string[] = [
  'arschloch', 'arschgeige', 'arschkriecher', 'wichser', 'wixer', 'hurensohn', 'fotze', 'schlampe',
  'scheisse', 'scheisser', 'drecksau', 'dreckssau', 'hundesohn', 'missgeburt', 'schwuchtel', 'kanake',
  'spasti', 'vollidiot', 'ficken', 'ficker', 'nutte', 'vagina', 'dildo', 'porno', 'hitler', 'nazi',
  'siegheil', 'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'asshole',
  'dickhead', 'bastard', 'motherfucker', 'retard', 'tranny', 'kackbratze',
];

/** Chat filter list: the name list minus words too common or mild for free-form chat. */
const CHAT_EXEMPT = new Set(['scheisse', 'scheisser', 'shit', 'fuck']);
export const CHAT_BAD_WORDS: readonly string[] = BAD_WORDS.filter((w) => !CHAT_EXEMPT.has(w));
