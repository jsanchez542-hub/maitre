import { addDays, compareDates, isoWeekday, isPlainDate, type PlainDate, type Weekday } from './calendar.js';

/**
 * What a guest said about the day, as the language model understood it.
 *
 * The model never works out a date itself: it says which of these shapes the
 * guest used and the code turns it into a calendar day. Every answer the guest
 * hears then repeats the full date, so a misunderstanding is caught out loud.
 */
export type DateSpec =
  /** An exact day, for "le 16 octobre 2026" or a date picked in a form. */
  | { kind: 'date'; date: PlainDate }
  /** Days from today: 0 is today, 1 tomorrow, 2 the day after tomorrow. */
  | { kind: 'relative'; days: number }
  /**
   * A weekday. `this` is the nearest one from today, today included: "vendredi"
   * or "vendredi prochain" said on a Wednesday. `next` is the same weekday in
   * the following Monday-to-Sunday week: "le vendredi de la semaine prochaine".
   */
  | { kind: 'weekday'; weekday: Weekday; week: 'this' | 'next' }
  /** A day of the month, for "le 11". Without a month, the next 11th to come. */
  | { kind: 'day_of_month'; day: number; month?: number };

export type DateResolution =
  | { ok: true; date: PlainDate }
  | { ok: false; error: 'invalid_date' | 'in_the_past' };

const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * The forms the language model may use to say which day the guest means, in
 * one short text field. A single field instead of several optional ones,
 * because some models fill every optional field with a default: one sent
 * `month: 1` for "the 24th" in a real run, which is 24 January.
 */
export const DAY_FORMS =
  '"today", "tomorrow", "day after tomorrow", "in 3 days", a weekday such as "friday" (the nearest one, today included), ' +
  '"friday next week" (only when the guest clearly means the week after), "24" for the 24th, "24/10" for 24 October, ' +
  'or "2026-10-24" when the guest gave a full date';

/** Reads one of the DAY_FORMS. Anything else is refused, never guessed. */
export function parseDay(input: string): DateSpec | undefined {
  if (input.length > 40) return undefined;
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { kind: 'date', date: text };
  if (text === 'today' || text === 'tonight') return { kind: 'relative', days: 0 };
  if (text === 'tomorrow') return { kind: 'relative', days: 1 };
  if (text === 'day after tomorrow' || text === 'the day after tomorrow') return { kind: 'relative', days: 2 };
  const inDays = /^in (\d{1,3}) days?$/.exec(text);
  if (inDays) return { kind: 'relative', days: Number(inDays[1]) };
  const weekday = /^(?:this )?([a-z]+)( next week)?$/.exec(text);
  if (weekday) {
    const index = WEEKDAY_NAMES.indexOf(weekday[1] ?? '');
    if (index >= 0) return { kind: 'weekday', weekday: (index + 1) as Weekday, week: weekday[2] ? 'next' : 'this' };
  }
  const dayOfMonth = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)?(?:\/(\d{1,2}))?$/.exec(text);
  if (dayOfMonth) {
    const day = Number(dayOfMonth[1]);
    return dayOfMonth[2] === undefined ? { kind: 'day_of_month', day } : { kind: 'day_of_month', day, month: Number(dayOfMonth[2]) };
  }
  return undefined;
}

const MAX_RELATIVE_DAYS = 3660;

function isWeekday(value: unknown): value is Weekday {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 7;
}

function datePart(date: PlainDate): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function compose(year: number, month: number, day: number): PlainDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function notInThePast(date: PlainDate, today: PlainDate): DateResolution {
  if (!isPlainDate(date)) return { ok: false, error: 'invalid_date' };
  if (compareDates(date, today) < 0) return { ok: false, error: 'in_the_past' };
  return { ok: true, date };
}

/** Turns what the guest said into a calendar day, seen from `today` in the business's time zone. */
export function resolveDate(spec: DateSpec, today: PlainDate): DateResolution {
  switch (spec.kind) {
    case 'date':
      return notInThePast(spec.date, today);

    case 'relative':
      if (!Number.isInteger(spec.days) || spec.days > MAX_RELATIVE_DAYS) {
        return { ok: false, error: 'invalid_date' };
      }
      if (spec.days < 0) return { ok: false, error: 'in_the_past' };
      return { ok: true, date: addDays(today, spec.days) };

    case 'weekday': {
      if (!isWeekday(spec.weekday)) return { ok: false, error: 'invalid_date' };
      const todayWeekday = isoWeekday(today);
      if (spec.week === 'this') {
        return { ok: true, date: addDays(today, (spec.weekday - todayWeekday + 7) % 7) };
      }
      const nextMonday = addDays(today, 8 - todayWeekday);
      return { ok: true, date: addDays(nextMonday, spec.weekday - 1) };
    }

    case 'day_of_month': {
      const { day, month } = spec;
      if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, error: 'invalid_date' };
      if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
        return { ok: false, error: 'invalid_date' };
      }
      const now = datePart(today);
      if (month === undefined) {
        // This month if the day has not passed yet, otherwise next month. A day the
        // month does not have ("le 31" in November) is refused rather than moved to
        // another month, so the agent asks instead of guessing.
        const thisMonth = compose(now.year, now.month, day);
        if (!isPlainDate(thisMonth)) return { ok: false, error: 'invalid_date' };
        if (compareDates(thisMonth, today) >= 0) return { ok: true, date: thisMonth };
        const nextMonth = now.month === 12 ? compose(now.year + 1, 1, day) : compose(now.year, now.month + 1, day);
        return isPlainDate(nextMonth) ? { ok: true, date: nextMonth } : { ok: false, error: 'invalid_date' };
      }
      const thisYear = compose(now.year, month, day);
      if (isPlainDate(thisYear) && compareDates(thisYear, today) >= 0) return { ok: true, date: thisYear };
      const nextYear = compose(now.year + 1, month, day);
      // 29 February asked in a leap year after it has passed has no "next one" a year later.
      return isPlainDate(nextYear) ? { ok: true, date: nextYear } : { ok: false, error: 'invalid_date' };
    }
  }
}
