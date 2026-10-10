import { describe, expect, it } from 'vitest';
import { DEMO_EVENING_AT, DEMO_EVENING_DATE, demoEvening } from '../src/demo/evening.js';

describe('the demo evening', () => {
  it('is Friday dinner at 20:05, made by the engine’s own operations', () => {
    const { engine, clock } = demoEvening();
    expect(clock.now().toISOString()).toBe(DEMO_EVENING_AT);
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    const named = (guestName: string) => day.bookings.find((booking) => booking.guestName === guestName);

    const lunch = day.bookings.filter((booking) => booking.service === 'déjeuner');
    expect(lunch).toHaveLength(9);
    expect(lunch.reduce((covers, booking) => covers + booking.partySize, 0)).toBe(24);
    expect(lunch.every((booking) => booking.stage === 'left')).toBe(true);

    for (const name of ['Martin', 'Lefèvre', 'Dubois', 'Garcia']) expect(named(name)).toMatchObject({ stage: 'seated', tableFixed: true });
    expect(named('Moreau')).toMatchObject({ stage: 'arrived', tableFixed: false });
    expect(named('Petit')).toMatchObject({ stage: 'expected', status: 'confirmed', allergies: [{ id: 'milk' }] });
    expect(named('Client sur place')).toMatchObject({ stage: 'seated', walkIn: true, partySize: 3, time: '20:00' });
    expect(named('Bernard')).toMatchObject({ stage: 'expected', status: 'booked' });
    expect(named('Roux')).toMatchObject({ time: '20:30', status: 'confirmed', channel: 'voice', history: [{ from: { time: '20:00', partySize: 2 } }] });
    expect(named('Fournier')?.allergies.map((allergen) => allergen.id)).toEqual(['gluten', 'sulphites']);
    expect(named('Girard')).toMatchObject({ notes: 'anniversaire' });
    expect(named('Bonnet')).toMatchObject({ stage: 'cancelled' });
    expect(named('Bonnet')).not.toHaveProperty('table');
    expect(named('Lambert')).toMatchObject({ language: 'en' });

    // Every party still to come or at the table has a table on the plan.
    const ongoing = day.bookings.filter((booking) => booking.stage !== 'cancelled' && booking.stage !== 'left');
    expect(ongoing.every((booking) => booking.table !== undefined)).toBe(true);
    expect(day.holds).toMatchObject([{ time: '21:15', partySize: 4, expiresAt: '2026-10-16T18:08:00.000Z' }]);
    expect(day.holds[0]?.table).toBeDefined();
    expect(day.callbacks.list.map((callback) => [callback.reason, callback.channel])).toEqual([
      ['large_group', 'voice'],
      ['allergy_question', 'whatsapp'],
    ]);
    // The evening's curve goes on after the last bookable time, 21:30, until the last two tables
    // leave at 23:00. The table held at 21:15 is nobody yet: it counts once the guest has booked.
    const dinner = day.room.filter((point) => point.service === 'dinner');
    expect(dinner.find((point) => point.time === '20:00')?.covers).toBeGreaterThan(0);
    expect(dinner.slice(-2)).toEqual([
      { service: 'dinner', time: '22:45', covers: 7 },
      { service: 'dinner', time: '23:00', covers: 0 },
    ]);
  });

  it('comes out the same on every load', () => {
    const view = () => JSON.stringify(demoEvening().engine.serviceDay(DEMO_EVENING_DATE, 'fr'));
    expect(view()).toBe(view());
  });

  it('carries on when the dashboard moves the clock: the held table lapses and the late guest sits down', () => {
    const { engine, clock } = demoEvening();
    clock.set(new Date('2026-10-16T18:10:00Z'));
    const petit = engine.serviceDay(DEMO_EVENING_DATE, 'fr').bookings.find((booking) => booking.guestName === 'Petit');
    expect(engine.seat(petit?.reference ?? '')).toMatchObject({ status: 'done', booking: { stage: 'seated' } });
    expect(engine.serviceDay(DEMO_EVENING_DATE, 'fr').holds).toEqual([]);
  });
});
