/** The narrow no-break space: it keeps a number with its unit and sets French punctuation apart. */
export const NNBSP = ' ';

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';
const isLetter = (char: string | undefined): boolean => char !== undefined && char.toLowerCase() !== char.toUpperCase();
const isSpace = (char: string | undefined): boolean => char === ' ' || char === NNBSP;
const startsUnit = (char: string | undefined): boolean => char === '€' || char === '%' || isLetter(char);

/** Whether the digits ending just before `index` are a clock time's minutes: «21:30», or «21 h 30» as French writes it. */
function endsClockTime(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && isDigit(text[start - 1])) start -= 1;
  if (index - start !== 2) return false;
  if (text[start - 1] === ':') return isDigit(text[start - 2]);
  return isSpace(text[start - 1]) && text[start - 2] === 'h' && isSpace(text[start - 3]) && isDigit(text[start - 4]);
}

/** Whether the word at `index` is «am» or «pm», which belong to the time before them. */
function isMeridiem(text: string, index: number): boolean {
  const word = text.slice(index, index + 2).toLowerCase();
  return (word === 'am' || word === 'pm') && !isLetter(text[index + 2]);
}

/**
 * Text the engine or the model writes (the agent's replies, a booking read
 * back, a request passed to the team, a day's name) set as the site's own copy
 * is. A number keeps the word after it on its line, so "20 h" never breaks into
 * "20" and "h", and "21 h 30" stays whole; after a time's minutes the next word
 * is not their unit, and keeps an ordinary space. An apostrophe inside a word is
 * the typographic one: the model writes "l'un" or "don't" as often as "l’un". A
 * loop, not a regular expression: the text comes from recordings and from the
 * engine, and a loop has no backtracking to worry about.
 */
export function typeset(text: string): string {
  let set = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const before = text[index - 1];
    const after = text[index + 1];
    if (char === ' ' && isDigit(before) && startsUnit(after) && (!endsClockTime(text, index) || isMeridiem(text, index + 1))) set += NNBSP;
    else if (char === ' ' && before === 'h' && isDigit(after) && isSpace(text[index - 2]) && isDigit(text[index - 3])) set += NNBSP;
    else if (char === "'" && isLetter(before) && isLetter(after)) set += '’';
    else set += char;
  }
  return set;
}
