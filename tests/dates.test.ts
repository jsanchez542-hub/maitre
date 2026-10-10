import { describe, expect, it } from 'vitest';
import { resolveDate } from '../src/dates.js';

// Wednesday 14 October 2026.
const WEDNESDAY = '2026-10-14';

describe('exact dates', () => {
  it('keeps a future or present date as it is', () => {
    expect(resolveDate({ kind: 'date', date: '2026-10-16' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-16' });
    expect(resolveDate({ kind: 'date', date: WEDNESDAY }, WEDNESDAY)).toEqual({ ok: true, date: WEDNESDAY });
  });

  it('refuses a past or impossible date', () => {
    expect(resolveDate({ kind: 'date', date: '2026-10-13' }, WEDNESDAY)).toEqual({ ok: false, error: 'in_the_past' });
    expect(resolveDate({ kind: 'date', date: '2026-02-30' }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
  });
});

describe('relative days', () => {
  it('counts today, tomorrow and the day after tomorrow', () => {
    expect(resolveDate({ kind: 'relative', days: 0 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-14' });
    expect(resolveDate({ kind: 'relative', days: 1 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-15' });
    expect(resolveDate({ kind: 'relative', days: 2 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-16' });
  });

  it('crosses the end of the year', () => {
    expect(resolveDate({ kind: 'relative', days: 2 }, '2026-12-31')).toEqual({ ok: true, date: '2027-01-02' });
  });

  it('refuses negative and fractional counts', () => {
    expect(resolveDate({ kind: 'relative', days: -1 }, WEDNESDAY)).toEqual({ ok: false, error: 'in_the_past' });
    expect(resolveDate({ kind: 'relative', days: 1.5 }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
  });
});

describe('weekdays', () => {
  it('takes the nearest one for "this", today included', () => {
    expect(resolveDate({ kind: 'weekday', weekday: 5, week: 'this' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-16' });
    expect(resolveDate({ kind: 'weekday', weekday: 3, week: 'this' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-14' });
    expect(resolveDate({ kind: 'weekday', weekday: 1, week: 'this' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-19' });
  });

  it('takes the following Monday-to-Sunday week for "next"', () => {
    expect(resolveDate({ kind: 'weekday', weekday: 5, week: 'next' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-23' });
    expect(resolveDate({ kind: 'weekday', weekday: 1, week: 'next' }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-19' });
  });

  it('handles Sunday, the last day of the week', () => {
    // From Sunday 18 October, "next Monday" is the very next day.
    expect(resolveDate({ kind: 'weekday', weekday: 1, week: 'next' }, '2026-10-18')).toEqual({ ok: true, date: '2026-10-19' });
    expect(resolveDate({ kind: 'weekday', weekday: 7, week: 'this' }, '2026-10-18')).toEqual({ ok: true, date: '2026-10-18' });
  });

  it('refuses a weekday that does not exist', () => {
    expect(resolveDate({ kind: 'weekday', weekday: 8 as never, week: 'this' }, WEDNESDAY)).toEqual({
      ok: false,
      error: 'invalid_date',
    });
  });
});

describe('day of the month', () => {
  it('takes this month while the day is still to come', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 16 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-16' });
    expect(resolveDate({ kind: 'day_of_month', day: 14 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-10-14' });
  });

  it('moves to next month once the day has passed', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 11 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-11-11' });
    expect(resolveDate({ kind: 'day_of_month', day: 5 }, '2026-12-20')).toEqual({ ok: true, date: '2027-01-05' });
  });

  it('refuses a day the month does not have instead of guessing another month', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 31 }, '2026-11-10')).toEqual({ ok: false, error: 'invalid_date' });
    // On 31 January, "le 30" would be 30 February: refused, not moved to March.
    expect(resolveDate({ kind: 'day_of_month', day: 30 }, '2027-01-31')).toEqual({ ok: false, error: 'invalid_date' });
  });

  it('uses the month when the guest gives one', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 24, month: 12 }, WEDNESDAY)).toEqual({ ok: true, date: '2026-12-24' });
    expect(resolveDate({ kind: 'day_of_month', day: 14, month: 2 }, WEDNESDAY)).toEqual({ ok: true, date: '2027-02-14' });
  });

  it('refuses impossible days and months', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 0 }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
    expect(resolveDate({ kind: 'day_of_month', day: 32 }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
    expect(resolveDate({ kind: 'day_of_month', day: 30, month: 2 }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
    expect(resolveDate({ kind: 'day_of_month', day: 1, month: 13 }, WEDNESDAY)).toEqual({ ok: false, error: 'invalid_date' });
  });

  it('refuses 29 February when the next one is years away', () => {
    expect(resolveDate({ kind: 'day_of_month', day: 29, month: 2 }, '2028-03-01')).toEqual({ ok: false, error: 'invalid_date' });
    expect(resolveDate({ kind: 'day_of_month', day: 29, month: 2 }, '2028-01-10')).toEqual({ ok: true, date: '2028-02-29' });
  });
});
