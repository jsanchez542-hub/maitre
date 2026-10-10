import type { Allergen } from '../allergens.js';

export const LANGUAGES = ['fr', 'en', 'es'] as const;

export type Language = (typeof LANGUAGES)[number];

/** Text a business writes once per language: a dish, a service, an answer to a question. */
export type LocalizedText = Readonly<Record<Language, string>>;

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export interface DateParts {
  /** ISO weekday, 1 is Monday. */
  weekday: number;
  day: number;
  /** 1 is January. */
  month: number;
  /** Only given when the date is not in the current year. */
  year?: number;
}

/**
 * Everything the engine says in words. `fr` and `es` are typed as `Messages`,
 * so a key missing from one language fails to compile.
 */
export interface Messages {
  date(parts: DateParts): string;
  time(hours: number, minutes: number): string;
  /** "vendredi 16 octobre à 20 h" */
  dateAtTime(date: string, time: string): string;
  /** "une table pour 4 personnes le vendredi 16 octobre à 20 h" */
  booking(partySize: number, date: string, time: string): string;
  allergen(allergen: Allergen): string;
  dishContains(dish: string, allergen: Allergen): string;
  dishMayContain(dish: string, allergen: Allergen): string;
  dishFree(dish: string, allergen: Allergen): string;
  dishUnknown(dish: string, allergen: Allergen): string;
}
