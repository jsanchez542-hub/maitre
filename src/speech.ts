import type { BusinessConfig } from './config.js';
import { localize, type Language } from './i18n/index.js';

/** Deepgram takes at most 100 key terms, 1,200 characters in all: a margin is kept for the line's own words. */
const MAX_TERMS = 60;
const MAX_CHARACTERS = 900;
const MAX_TERM_LENGTH = 60;

/**
 * Words speech recognition should expect on a restaurant's phone line, in the
 * call's language: the restaurant's name, which no dictionary has, and its
 * dishes, which callers ask about by name. Heard as such, "Merrain" is not
 * "merrin" and a dish's name reaches check_dish as the menu writes it.
 */
export function speechKeyterms(config: BusinessConfig, language: Language): string[] {
  const terms: string[] = [];
  let characters = 0;
  for (const term of [config.name, ...config.menu.map((dish) => localize(dish.name, language))]) {
    const clean = term.trim();
    if (clean === '' || clean.length > MAX_TERM_LENGTH || terms.includes(clean)) continue;
    if (terms.length === MAX_TERMS || characters + clean.length > MAX_CHARACTERS) break;
    terms.push(clean);
    characters += clean.length;
  }
  return terms;
}
