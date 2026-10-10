import { fromMinutes, isoWeekday, toMinutes, type PlainDate, type PlainTime } from './calendar.js';
import type { BusinessConfig, Sitting } from './config.js';

/** The sittings of one day: its exception if it has one, otherwise the weekly schedule. */
export function sittingsOn(config: BusinessConfig, date: PlainDate): readonly Sitting[] {
  const exception = config.exceptions.find((candidate) => candidate.date === date);
  return exception ? exception.sittings : config.weekly[isoWeekday(date)];
}

export function isOpenOn(config: BusinessConfig, date: PlainDate): boolean {
  return sittingsOn(config, date).length > 0;
}

/** Every bookable time of a sitting, from its first to its last seating. */
export function slotsOf(sitting: Sitting, slotMinutes: number): PlainTime[] {
  const slots: PlainTime[] = [];
  const last = toMinutes(sitting.lastSeating);
  for (let minute = toMinutes(sitting.firstSeating); minute <= last; minute += slotMinutes) {
    slots.push(fromMinutes(minute));
  }
  return slots;
}

/** Every bookable time of a day, in order. */
export function slotsOn(config: BusinessConfig, date: PlainDate): PlainTime[] {
  return sittingsOn(config, date)
    .flatMap((sitting) => slotsOf(sitting, config.slotMinutes))
    .sort((a, b) => toMinutes(a) - toMinutes(b));
}

/** The sitting a time falls into, between its first and last seating, if any. */
export function sittingAt(config: BusinessConfig, date: PlainDate, time: PlainTime): Sitting | undefined {
  const minute = toMinutes(time);
  return sittingsOn(config, date).find(
    (sitting) => minute >= toMinutes(sitting.firstSeating) && minute <= toMinutes(sitting.lastSeating),
  );
}

/** True when the time is one of the sitting's bookable times, not 20:10 on a quarter-hour grid. */
export function isOnGrid(sitting: Sitting, time: PlainTime, slotMinutes: number): boolean {
  return (toMinutes(time) - toMinutes(sitting.firstSeating)) % slotMinutes === 0;
}
