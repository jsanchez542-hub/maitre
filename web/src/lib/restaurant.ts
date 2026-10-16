import {
  addDays,
  formatTime,
  isoWeekday,
  localNow,
  sittingsOn,
  toMinutes,
  type BusinessConfig,
  type Language,
  type PlainDate,
  type PlainTime,
  type Sitting,
  type Weekday,
} from 'maitre';
import type { Messages } from '../i18n/messages';
import { typeset } from './typography';

/**
 * The cellar as the site shows it: a few appellations a guest knows, by where they grow, all from the restaurant's
 * own list. The whole list is the assistant's, which answers about any of them.
 */
export const CELLAR_SELECTION: readonly { group: 'left' | 'right' | 'whites'; names: readonly string[] }[] = [
  { group: 'left', names: ['Margaux', 'Pauillac', 'Pessac-Léognan'] },
  { group: 'right', names: ['Saint-Émilion', 'Pomerol', 'Fronsac'] },
  { group: 'whites', names: ['Entre-Deux-Mers', 'Sauternes', 'Barsac'] },
];

/** Consecutive days that keep the same services, as a restaurant writes its hours on the door. */
export interface WeekRow {
  first: Weekday;
  last: Weekday;
  sittings: readonly Sitting[];
}

const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

function sameServices(a: readonly Sitting[], b: readonly Sitting[]): boolean {
  return a.length === b.length && a.every((sitting, index) => {
    const other = b[index];
    return other !== undefined && sitting.service === other.service && sitting.firstSeating === other.firstSeating && sitting.lastSeating === other.lastSeating;
  });
}

/** The week from Monday, one row per run of days with the same services. A day with none is closed. */
export function weekOf(config: Pick<BusinessConfig, 'weekly'>): WeekRow[] {
  const rows: WeekRow[] = [];
  for (const day of WEEKDAYS) {
    const sittings = config.weekly[day];
    const previous = rows[rows.length - 1];
    if (previous && previous.last === day - 1 && sameServices(previous.sittings, sittings)) previous.last = day;
    else rows.push({ first: day, last: day, sittings });
  }
  return rows;
}

/**
 * The first arrival window after `time`, later that day or on the next open day within the days a booking may be made:
 * what a party at the door waits for, the engine seating one only inside a window.
 */
export function nextArrivals(config: BusinessConfig, date: PlainDate, time: PlainTime): { date: PlainDate; sitting: Sitting } | null {
  const minute = toMinutes(time);
  for (let ahead = 0; ahead <= config.maxAdvanceDays; ahead += 1) {
    const day = addDays(date, ahead);
    const sitting = [...sittingsOn(config, day)]
      .sort((a, b) => toMinutes(a.firstSeating) - toMinutes(b.firstSeating))
      .find((candidate) => ahead > 0 || toMinutes(candidate.firstSeating) > minute);
    if (sitting) return { date: day, sitting };
  }
  return null;
}

export function serviceName(config: Pick<BusinessConfig, 'services'>, id: string, language: Language): string {
  return config.services.find((service) => service.id === id)?.name[language] ?? id;
}

/**
 * Where the restaurant is, and its day and time, as a phone shows the callee's: «Bordeaux · mardi 21 h 40». The
 * visitor may be elsewhere, and the restaurant's «bonsoir» follows its own hour.
 */
export function clockOf(config: Pick<BusinessConfig, 'timeZone'>, at: Date, language: Language, t: Messages['site']): string {
  const moment = localNow(at, config.timeZone);
  return typeset(t.clock(t.weekdays[isoWeekday(moment.date) - 1] ?? '', formatTime(moment.time, language)));
}

/** The evening a guest asks for, in their own words: «ce soir», «demain soir», or its weekday further on. */
export function eveningOf(date: PlainDate, today: PlainDate, t: Messages): string {
  if (date === today) return t.chat.evening.today;
  if (date === addDays(today, 1)) return t.chat.evening.tomorrow;
  return t.chat.evening.on(t.site.weekdays[isoWeekday(date) - 1] ?? '');
}
