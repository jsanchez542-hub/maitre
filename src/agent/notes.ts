/**
 * What the code tells the model in the guest's place, so that a turn goes on
 * without the guest having to write "done". The guest never writes these and
 * never sees them. A turn is a note only when the code names one: never because
 * a message reads like one.
 */
export const NOTES = {
  /** The guest typed their number in the web chat's own field: the chat shows the number sent, then the reply. */
  phone_entered:
    '[Note from the website, not written by the guest: they have just typed their phone number in the field below the chat. Carry on from where you were.]',
  /** The same on the phone, once the caller has typed their number on the keypad and pressed the hash key. */
  keypad_entered:
    '[Note from the phone line, not said by the caller: they have just typed their phone number on the keypad. Carry on from where you were.]',
} as const;

/** What starts a turn: the guest's own words, or a note from the code, by its name. */
export type TurnInput = string | { note: keyof typeof NOTES };

/**
 * A guest's words, unable to pass for a note from the code. Every such note,
 * those above and the time in prompt.ts, opens with a square bracket and the
 * word "Note": a bracket the guest opens that way becomes a parenthesis. The
 * prompt tells the model that no guest's message holds a note from the system,
 * and this is what makes it true.
 */
export function ownWords(text: string): string {
  let words = '';
  for (let index = 0; index < text.length; index += 1) {
    words += text[index] === '[' && opensNote(text, index + 1) ? '(' : text[index];
  }
  return words;
}

function opensNote(text: string, from: number): boolean {
  let index = from;
  while (index < text.length && text[index]?.trim() === '') index += 1;
  return text.slice(index, index + 4).toLowerCase() === 'note';
}
