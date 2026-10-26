import { DEMO_CELLAR, DEMO_EVENING_AT, DEMO_RESTAURANT } from 'maitre/demo';
import { describe, expect, it } from 'vitest';
import { messagesFor } from '../i18n/messages';
import { CELLAR_SELECTION, clockOf, eveningOf, nextArrivals, serviceName, weekOf } from './restaurant';
import { NNBSP } from './typography';

describe('the restaurant as its site and its settings show it', () => {
  it('writes the week the way the door does: Monday closed, Tuesday to Saturday, then Sunday', () => {
    const rows = weekOf(DEMO_RESTAURANT);
    expect(rows.map((row) => [row.first, row.last, row.sittings.map((sitting) => sitting.service)])).toEqual([
      [1, 1, []],
      [2, 6, ['lunch', 'dinner']],
      [7, 7, ['lunch']],
    ]);
  });

  it('shows only wines the restaurant has, so the assistant can answer about each one', () => {
    for (const { names } of CELLAR_SELECTION) for (const name of names) expect(DEMO_CELLAR).toContain(name);
  });

  it('finds the arrival window a party at the door waits for: later today, or on the next open day', () => {
    // Friday between lunch and dinner, then after dinner's last seating.
    expect(nextArrivals(DEMO_RESTAURANT, '2026-10-16', '14:35')).toMatchObject({ date: '2026-10-16', sitting: { service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' } });
    expect(nextArrivals(DEMO_RESTAURANT, '2026-10-16', '21:45')).toMatchObject({ date: '2026-10-17', sitting: { service: 'lunch', firstSeating: '12:00' } });
    // Sunday after lunch: Monday is closed, so Tuesday's lunch.
    expect(nextArrivals(DEMO_RESTAURANT, '2026-10-18', '15:00')).toMatchObject({ date: '2026-10-20', sitting: { service: 'lunch' } });
    // A restaurant closed every day has none to offer.
    const closed = { ...DEMO_RESTAURANT, weekly: { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] }, exceptions: [] };
    expect(nextArrivals(closed, '2026-10-16', '14:35')).toBeNull();
  });

  it('names a service in the reader’s language', () => {
    expect(serviceName(DEMO_RESTAURANT, 'dinner', 'es')).toBe('cena');
  });

  it('says where the restaurant is and its own day and time, as a phone shows the callee’s, without a break inside the time', () => {
    const NBSP = '\u00A0';
    const friday = new Date(DEMO_EVENING_AT);
    expect(clockOf(DEMO_RESTAURANT, friday, 'fr', messagesFor('fr').site)).toBe(`Bordeaux, vendredi 20${NBSP}h${NBSP}05`);
    expect(clockOf(DEMO_RESTAURANT, friday, 'en', messagesFor('en').site)).toBe(`Bordeaux, Friday 8:05${NNBSP}pm`);
    expect(clockOf(DEMO_RESTAURANT, friday, 'es', messagesFor('es').site)).toBe('Burdeos, viernes 20:05');
    // In Bordeaux's time, whatever the visitor's: 23:30 in UTC is already Saturday there.
    expect(clockOf(DEMO_RESTAURANT, new Date('2026-10-16T23:30:00Z'), 'fr', messagesFor('fr').site)).toBe(`Bordeaux, samedi 1${NBSP}h${NBSP}30`);
  });

  it('names the evening a guest asks for as they would: tonight, tomorrow, or its weekday', () => {
    const today = '2026-10-13';
    expect(eveningOf('2026-10-13', today, messagesFor('fr'))).toBe('ce soir');
    expect(eveningOf('2026-10-14', today, messagesFor('fr'))).toBe('demain soir');
    expect(eveningOf('2026-10-16', today, messagesFor('fr'))).toBe('vendredi soir');
    expect(eveningOf('2026-10-13', today, messagesFor('en'))).toBe('tonight');
    expect(eveningOf('2026-10-14', today, messagesFor('en'))).toBe('tomorrow evening');
    expect(eveningOf('2026-10-16', today, messagesFor('en'))).toBe('on Friday evening');
    expect(eveningOf('2026-10-13', today, messagesFor('es'))).toBe('esta noche');
    expect(eveningOf('2026-10-14', today, messagesFor('es'))).toBe('mañana por la noche');
    expect(eveningOf('2026-10-16', today, messagesFor('es'))).toBe('el viernes por la noche');
  });
});
