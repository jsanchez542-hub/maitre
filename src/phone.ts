/**
 * Phone numbers in E.164 (+33612345678), the only form stored.
 *
 * This is deliberately not a full numbering library: it understands French
 * national numbers and anything already written internationally, which covers
 * a restaurant in France and its foreign guests. A number it cannot read is
 * refused rather than guessed.
 */

const MAX_INPUT_LENGTH = 32;
const SEPARATORS = new Set([' ', ' ', ' ', '.', '-', '(', ')', '/']);

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function isE164(value: string): boolean {
  if (value.length < 9 || value.length > 16 || value[0] !== '+' || value[1] === '0') return false;
  for (const char of value.slice(1)) if (!isDigit(char)) return false;
  return true;
}

/** The number in E.164, or undefined when it cannot be read with certainty. */
export function normalizePhone(input: string): string | undefined {
  if (input.length > MAX_INPUT_LENGTH) return undefined;
  let compact = '';
  for (const char of input.trim()) {
    if (SEPARATORS.has(char)) continue;
    if (!isDigit(char) && !(char === '+' && compact === '')) return undefined;
    compact += char;
  }

  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  // "+33 (0)6 12 34 56 78" is a common way to write a French number.
  if (compact.startsWith('+330') && compact.length === 13) compact = `+33${compact.slice(4)}`;
  if (compact.length === 10 && compact.startsWith('0') && compact[1] !== '0') compact = `+33${compact.slice(1)}`;

  if (compact.startsWith('+33') && compact.length !== 12) return undefined;
  return isE164(compact) ? compact : undefined;
}

/** "+33 6 12 34 56 78" for a French number, the E.164 form otherwise. */
export function formatPhone(e164: string): string {
  if (e164.startsWith('+33') && e164.length === 12) {
    const national = e164.slice(3);
    return `+33 ${national[0]} ${national.slice(1, 3)} ${national.slice(3, 5)} ${national.slice(5, 7)} ${national.slice(7, 9)}`;
  }
  return e164;
}

/** The last two digits, the only part of a number worth saying back to a caller. */
export function phoneEnding(e164: string): string {
  return e164.slice(-2);
}
