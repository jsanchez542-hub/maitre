import { isoWeekday, toMinutes, type PlainDate, type PlainTime } from '../calendar.js';
import { en } from './en.js';
import { es } from './es.js';
import { fr } from './fr.js';
import type { Language, LocalizedText, Messages } from './types.js';

export { LANGUAGES, isLanguage } from './types.js';
export type { CallEnd, DateParts, Errand, Language, LocalizedText, Messages } from './types.js';

const CATALOGUES: Record<Language, Messages> = { fr, en, es };

export function messages(language: Language): Messages {
  return CATALOGUES[language];
}

export function localize(text: LocalizedText, language: Language): string {
  return text[language];
}

/**
 * "vendredi 16 octobre". The year is only said when it is not this year's,
 * because that is how people say dates out loud.
 */
export function formatDate(date: PlainDate, language: Language, today: PlainDate): string {
  const year = Number(date.slice(0, 4));
  return messages(language).date({
    weekday: isoWeekday(date),
    day: Number(date.slice(8, 10)),
    month: Number(date.slice(5, 7)),
    ...(year === Number(today.slice(0, 4)) ? {} : { year }),
  });
}

export function formatTime(time: PlainTime, language: Language): string {
  const minutes = toMinutes(time);
  return messages(language).time(Math.floor(minutes / 60), minutes % 60);
}

/** "vendredi 16 octobre à 20 h": what the guest hears before anything is booked. */
export function formatDateAtTime(date: PlainDate, time: PlainTime, language: Language, today: PlainDate): string {
  return messages(language).dateAtTime(formatDate(date, language, today), formatTime(time, language));
}

/** "une table pour 4 personnes le vendredi 16 octobre à 20 h" */
export function formatBooking(
  partySize: number,
  date: PlainDate,
  time: PlainTime,
  language: Language,
  today: PlainDate,
): string {
  return messages(language).booking(partySize, formatDate(date, language, today), formatTime(time, language));
}
