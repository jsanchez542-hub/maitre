/**
 * Calendar arithmetic on wall-clock values.
 *
 * A booking happens "on 2026-10-15 at 20:00 in Bordeaux", not at an instant, so
 * dates and times are kept as plain strings in the business's time zone. The
 * only place an instant is converted is `localNow`. Date arithmetic is done on
 * UTC midnights, where there is no daylight saving time to get wrong.
 */

/** A calendar day, written as YYYY-MM-DD. */
export type PlainDate = string;

/** A wall-clock time, written as HH:mm in 24-hour format. */
export type PlainTime = string;

/** ISO weekday: 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

function utcMidnight(date: PlainDate): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Not a calendar date: ${date}`);
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function fromUtcMidnight(ms: number): PlainDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a real calendar day, so 2026-02-30 is rejected. */
export function isPlainDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  return fromUtcMidnight(utcMidnight(value)) === value;
}

export function isPlainTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function addDays(date: PlainDate, days: number): PlainDate {
  return fromUtcMidnight(utcMidnight(date) + days * DAY_MS);
}

export function daysBetween(from: PlainDate, to: PlainDate): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / DAY_MS);
}

export function isoWeekday(date: PlainDate): Weekday {
  const sundayFirst = new Date(utcMidnight(date)).getUTCDay();
  return (sundayFirst === 0 ? 7 : sundayFirst) as Weekday;
}

/** YYYY-MM-DD strings sort chronologically, so plain comparison is enough. */
export function compareDates(a: PlainDate, b: PlainDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toMinutes(time: PlainTime): number {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new RangeError(`Not a wall-clock time: ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function fromMinutes(minutes: number): PlainTime {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new RangeError(`Minutes out of range for a single day: ${minutes}`);
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export interface LocalMoment {
  date: PlainDate;
  time: PlainTime;
}

/** The business's own date and time at a given instant. */
export function localNow(instant: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not return a ${type} part`);
    return found.value;
  };
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

/** Throws when the runtime does not know the zone, so a typo fails at startup. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch {
    throw new RangeError(`Unknown time zone: ${timeZone}`);
  }
}
