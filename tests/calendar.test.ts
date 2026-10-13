import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertTimeZone,
  compareDates,
  daysBetween,
  fromMinutes,
  isoWeekday,
  isPlainDate,
  isPlainTime,
  localNow,
  toMinutes,
  zonedInstant,
} from '../src/calendar.js';

describe('plain dates', () => {
  it('accepts real days and rejects impossible ones', () => {
    expect(isPlainDate('2026-10-16')).toBe(true);
    expect(isPlainDate('2028-02-29')).toBe(true);
    expect(isPlainDate('2026-02-29')).toBe(false);
    expect(isPlainDate('2026-02-30')).toBe(false);
    expect(isPlainDate('2026-13-01')).toBe(false);
    expect(isPlainDate('2026-1-01')).toBe(false);
    expect(isPlainDate('16/10/2026')).toBe(false);
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is not shifted by the daylight saving change in Paris', () => {
    // Clocks go forward on 29 March 2026 and back on 25 October 2026.
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('counts the days between two dates in either direction', () => {
    expect(daysBetween('2026-10-14', '2026-10-16')).toBe(2);
    expect(daysBetween('2026-10-16', '2026-10-14')).toBe(-2);
  });

  it('numbers weekdays from Monday to Sunday', () => {
    expect(isoWeekday('2026-10-12')).toBe(1);
    expect(isoWeekday('2026-10-16')).toBe(5);
    expect(isoWeekday('2026-10-18')).toBe(7);
  });

  it('orders dates chronologically', () => {
    expect(compareDates('2026-10-14', '2026-10-16')).toBe(-1);
    expect(compareDates('2026-10-16', '2026-10-16')).toBe(0);
    expect(compareDates('2027-01-01', '2026-12-31')).toBe(1);
  });

  it('refuses to do arithmetic on something that is not a date', () => {
    expect(() => addDays('tomorrow', 1)).toThrow(RangeError);
  });
});

describe('wall-clock times', () => {
  it('accepts 24-hour times only', () => {
    expect(isPlainTime('00:00')).toBe(true);
    expect(isPlainTime('23:59')).toBe(true);
    expect(isPlainTime('24:00')).toBe(false);
    expect(isPlainTime('8:00')).toBe(false);
    expect(isPlainTime('20h00')).toBe(false);
  });

  it('converts to and from minutes', () => {
    expect(toMinutes('20:30')).toBe(1230);
    expect(fromMinutes(1230)).toBe('20:30');
    expect(fromMinutes(0)).toBe('00:00');
    expect(() => fromMinutes(1440)).toThrow(RangeError);
    expect(() => fromMinutes(12.5)).toThrow(RangeError);
  });
});

describe('local time of the business', () => {
  it('converts an instant to Paris time in summer and in winter', () => {
    expect(localNow(new Date('2026-07-01T10:00:00Z'), 'Europe/Paris')).toEqual({
      date: '2026-07-01',
      time: '12:00',
    });
    expect(localNow(new Date('2026-12-01T10:00:00Z'), 'Europe/Paris')).toEqual({
      date: '2026-12-01',
      time: '11:00',
    });
  });

  it('is already tomorrow in Paris when it is still today in UTC', () => {
    expect(localNow(new Date('2026-10-15T22:30:00Z'), 'Europe/Paris')).toEqual({
      date: '2026-10-16',
      time: '00:30',
    });
  });

  it('follows the clock change in Paris', () => {
    // 01:00 UTC on 29 March 2026 is 03:00 in Paris: 02:00 never happens that night.
    expect(localNow(new Date('2026-03-29T01:00:00Z'), 'Europe/Paris').time).toBe('03:00');
    // 01:00 UTC on 25 October 2026 is 02:00 in Paris, after the clocks went back.
    expect(localNow(new Date('2026-10-25T01:00:00Z'), 'Europe/Paris').time).toBe('02:00');
  });

  it('writes midnight as 00, not 24', () => {
    expect(localNow(new Date('2026-10-15T22:00:00Z'), 'Europe/Paris').time).toBe('00:00');
  });

  it('finds the instant a Paris wall clock shows, in summer and in winter', () => {
    expect(zonedInstant('2026-10-16', '20:05', 'Europe/Paris').toISOString()).toBe('2026-10-16T18:05:00.000Z');
    expect(zonedInstant('2026-11-03', '20:05', 'Europe/Paris').toISOString()).toBe('2026-11-03T19:05:00.000Z');
    for (const [date, time] of [
      ['2026-07-01', '00:00'],
      ['2026-10-25', '12:00'],
      ['2026-12-31', '23:59'],
    ] as const) {
      expect(localNow(zonedInstant(date, time, 'Europe/Paris'), 'Europe/Paris')).toEqual({ date, time });
    }
    // 02:30 never happens on 29 March 2026: the clocks go from 02:00 to 03:00, and it comes out an hour later.
    expect(localNow(zonedInstant('2026-03-29', '02:30', 'Europe/Paris'), 'Europe/Paris').time).toBe('03:30');
  });

  it('rejects an unknown time zone', () => {
    expect(() => assertTimeZone('Europe/Bordeaux')).toThrow(RangeError);
    expect(() => assertTimeZone('Europe/Paris')).not.toThrow();
  });
});
