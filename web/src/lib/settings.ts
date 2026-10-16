import { toMinutes, validateConfig, type BusinessConfig, type PlainTime, type Sitting, type StaffBookingView } from 'maitre';

/** The settings an owner changes from the panel, as the restaurant takes them: hours, closures, rules, menu, answers. */
export type EditableSettings = Partial<Pick<BusinessConfig, 'weekly' | 'exceptions' | 'menu' | 'faq' | 'minNoticeMinutes' | 'maxAdvanceDays' | 'maxPartySize'>>;

/**
 * What the restaurant answered: the settings as it keeps them now, with the bookings they leave out (a day closed,
 * a service shortened, whose guests are still coming), or why it kept nothing.
 */
export type SettingsAnswer = { status: 'ok'; config: BusinessConfig; outsideHours: readonly StaffBookingView[] } | { status: 'invalid'; problems: string[] };

/** The times a service can start and end at, on its own grid: every quarter of an hour where the restaurant books so. */
export function timesOfDay(slotMinutes: number): PlainTime[] {
  const times: PlainTime[] = [];
  for (let minute = 0; minute < 24 * 60; minute += slotMinutes) {
    times.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
  }
  return times;
}

/**
 * The times a service keeps on the days it opens, for a day it opens on anew: the restaurant's own, never invented.
 * A service open on no day yet starts on the times of the restaurant's first open service.
 */
export function usualSitting(config: Pick<BusinessConfig, 'weekly'>, service: string): Sitting {
  const week = ([1, 2, 3, 4, 5, 6, 7] as const).flatMap((day) => config.weekly[day]);
  const kept = week.find((sitting) => sitting.service === service) ?? week[0];
  return kept ? { service, firstSeating: kept.firstSeating, lastSeating: kept.lastSeating } : { service, firstSeating: '12:00', lastSeating: '14:00' };
}

/** Why a day's services cannot stand, in the panel's own terms: one ends before it starts, or two overlap. */
export type SittingsProblem = 'order' | 'overlap';

export function sittingsProblem(sittings: readonly Sitting[]): SittingsProblem | null {
  if (sittings.some((sitting) => toMinutes(sitting.lastSeating) < toMinutes(sitting.firstSeating))) return 'order';
  const ranges = sittings.map((sitting) => [toMinutes(sitting.firstSeating), toMinutes(sitting.lastSeating)] as const).sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    const before = ranges[index - 1];
    const after = ranges[index];
    if (before && after && after[0] <= before[1]) return 'overlap';
  }
  return null;
}

/**
 * Every problem the restaurant would find in its settings with these changes, checked as it checks them: the panel
 * sends nothing it would refuse. A part of the wrong kind altogether counts as one problem.
 */
export function problemsWith(config: BusinessConfig, changes: EditableSettings): string[] {
  try {
    return validateConfig({ ...config, ...changes });
  } catch {
    return ['the settings are not in the expected shape'];
  }
}

/** The largest party the restaurant can take online: one a table suits, within its rule of empty seats, and a stay covers. */
export function largestParty(config: Pick<BusinessConfig, 'tables' | 'maxEmptySeats' | 'stays'>): number {
  const longest = Math.max(0, ...config.stays.map((stay) => stay.upToPartySize));
  let largest = 0;
  for (let size = 1; size <= Math.min(30, longest); size += 1) {
    if (!config.tables.some((group) => group.seats >= size && group.seats - size <= config.maxEmptySeats)) break;
    largest = size;
  }
  return largest;
}

/** Letters a name keeps in its id once its accents are gone: «Crème brûlée» gives «creme-brulee». */
const PLAIN = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 40;

/**
 * A new id from a name, as the engine wants ids: lowercase letters, digits and dashes, unique in its list. A loop over
 * a name the panel caps at 80 characters, never a pattern. A dish keeps its id when it is renamed: only new ones get one.
 */
export function idFor(name: string, taken: ReadonlySet<string>, fallback: string): string {
  let id = '';
  for (const char of name.normalize('NFD').toLowerCase()) {
    if (PLAIN.includes(char)) id += char;
    else if (char === 'œ') id += 'oe';
    else if (char === 'æ') id += 'ae';
    else if (char.trim() === '' || char === '-' || char === '’' || char === "'") {
      if (id !== '' && !id.endsWith('-')) id += '-';
    }
    if (id.length >= ID_LENGTH) break;
  }
  id = id.slice(0, ID_LENGTH - 3);
  while (id.endsWith('-')) id = id.slice(0, -1);
  const base = id || fallback;
  let unique = base;
  for (let count = 2; taken.has(unique); count += 1) unique = `${base}-${count}`;
  return unique;
}

/** A price as the owner writes it, «12», «12,50» or «12.5», in cents; null when it reads as no price at all. */
export function centsOf(written: string): number | null | 'unreadable' {
  const text = written.trim().replace(',', '.');
  if (text === '') return null;
  if (text.length > 9) return 'unreadable';
  let euros = 0;
  let cents = 0;
  let decimals = -1;
  for (const char of text) {
    if (char === '.') {
      if (decimals >= 0) return 'unreadable';
      decimals = 0;
    } else if (char >= '0' && char <= '9') {
      if (decimals < 0) euros = euros * 10 + Number(char);
      else if (decimals < 2) {
        cents += Number(char) * (decimals === 0 ? 10 : 1);
        decimals += 1;
      } else return 'unreadable';
    } else return 'unreadable';
  }
  return euros * 100 + cents;
}
