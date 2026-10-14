import { describe, expect, it } from 'vitest';
import { zonedInstant } from '../src/calendar.js';
import type { ChatOutcome } from '../src/demo/chat.js';
import { DEMO_EVENING_AT, DEMO_EVENING_DATE, demoEvening, demoSuggestion, serviceDayAt } from '../src/demo/evening.js';

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
    expect(day.holds).toMatchObject([{ time: '21:15', service: 'dinner', partySize: 4, expiresAt: '2026-10-16T18:08:00.000Z' }]);
    // The room of the plan: every table in a named zone, and each waiter's section on one side of it.
    expect(new Set(day.floor.map((table) => table.zone))).toEqual(new Set(['banquette', 'window', 'room']));
    expect(day.zones.map((zone) => zone.name)).toEqual(['Banquette', 'Fenêtre', 'Salle']);
    expect(day.sections.map((section) => [section.waiterName, section.tables.length])).toEqual([
      ['Léa', 8],
      ['Hugo', 5],
    ]);
    expect(day.holds[0]?.table).toBeDefined();
    expect(day.callbacks.list.map((callback) => [callback.reason, callback.channel])).toEqual([
      ['large_group', 'voice'],
      ['allergy_question', 'whatsapp'],
    ]);
    expect(day.callbacks.list[0]?.summary).toBe('Groupe de 9 pour un anniversaire, samedi 17 octobre au soir.');
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

  it('gives its guests numbers from the range ARCEP keeps for fiction, which the panel can show whole', () => {
    const { engine } = demoEvening();
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    const numbers = [...day.bookings.map((booking) => booking.phone), ...day.callbacks.list.map((callback) => callback.phone)].filter(Boolean);
    expect(numbers.length).toBeGreaterThan(20);
    // 06 39 98 00 00 to 06 39 98 99 99, as the panel writes them.
    for (const number of numbers) expect(number).toMatch(/^\+33 6 39 98 \d\d \d\d$/);
  });

  it('carries on when the dashboard moves the clock: the held table lapses and the late guest sits down', () => {
    const { engine, clock } = demoEvening();
    clock.set(new Date('2026-10-16T18:10:00Z'));
    const petit = engine.serviceDay(DEMO_EVENING_DATE, 'fr').bookings.find((booking) => booking.guestName === 'Petit');
    expect(engine.seat(petit?.reference ?? '')).toMatchObject({ status: 'done', booking: { stage: 'seated' } });
    expect(engine.serviceDay(DEMO_EVENING_DATE, 'fr').holds).toEqual([]);
  });
});

describe('the demo restaurant at the real time', () => {
  // 1 November 2026 is a Sunday, in winter time: Merrain serves lunch only on Sundays and is closed on Mondays.
  const paris = (date: string, time: string) => zonedInstant(date, time, 'Europe/Paris');
  const stages = (evening: ReturnType<typeof demoEvening>) => {
    const service = evening.engine.serviceDay(evening.day, 'fr');
    return { service, stage: (name: string) => service.bookings.find((booking) => booking.guestName === name) };
  };

  it('is about today while a service goes on, and about the next day it opens otherwise', () => {
    expect(serviceDayAt(paris('2026-11-03', '10:00'))).toBe('2026-11-03');
    expect(serviceDayAt(paris('2026-11-03', '23:30'))).toBe('2026-11-03');
    expect(serviceDayAt(paris('2026-11-03', '23:45'))).toBe('2026-11-04');
    expect(serviceDayAt(paris('2026-11-01', '11:00'))).toBe('2026-11-01');
    expect(serviceDayAt(paris('2026-11-01', '17:00'))).toBe('2026-11-03');
    expect(serviceDayAt(paris('2026-11-02', '15:00'))).toBe('2026-11-03');
  });

  it('has done by the morning what came the days before, and nothing of the day itself', () => {
    const now = paris('2026-11-03', '10:00');
    const evening = demoEvening({ now });
    expect(evening.day).toBe('2026-11-03');
    expect(evening.clock.now()).toEqual(now);
    const { service, stage } = stages(evening);
    expect(service.bookings.every((booking) => booking.stage === 'expected')).toBe(true);
    // Moved and confirmed the day before; Fournier confirms at 10:20, Bonnet cancels at 18:40.
    expect(stage('Roux')).toMatchObject({ time: '20:30', status: 'confirmed' });
    expect(stage('Fournier')).toMatchObject({ status: 'booked' });
    expect(stage('Bonnet')).toMatchObject({ status: 'booked' });
    expect(service.callbacks.list).toEqual([]);
    expect(service.holds).toEqual([]);
  });

  it('is the recorded evening at its own instant, without the table someone was booking then', () => {
    const { service, stage } = stages(demoEvening({ now: new Date(DEMO_EVENING_AT) }));
    for (const name of ['Martin', 'Lefèvre', 'Dubois', 'Garcia', 'Client sur place']) expect(stage(name)).toMatchObject({ stage: 'seated' });
    expect(stage('Moreau')).toMatchObject({ stage: 'arrived' });
    expect(stage('Petit')).toMatchObject({ stage: 'expected' });
    expect(service.callbacks.list[0]?.summary).toBe('Groupe de 9 pour un anniversaire, samedi 17 octobre au soir.');
    expect(service.holds).toEqual([]);
  });

  it('goes on through the evening: the late party sits down, and the tables empty', () => {
    const { service, stage } = stages(demoEvening({ now: paris('2026-11-03', '22:45') }));
    for (const name of ['Martin', 'Moreau', 'Petit', 'Roux', 'Bernard', 'Client sur place']) expect(stage(name)).toMatchObject({ stage: 'left' });
    for (const name of ['Fournier', 'Lambert']) expect(stage(name)).toMatchObject({ stage: 'seated' });
    // The birthday table, booked until 22:30, is still there: it keeps its table until it leaves.
    expect(stage('Girard')).toMatchObject({ stage: 'seated', endsAt: '22:46' });
    expect(service.bookings.filter((booking) => booking.service === 'déjeuner').every((booking) => booking.stage === 'left')).toBe(true);
  });

  it('opens on the next service on its day off, with nothing of it done yet', () => {
    const evening = demoEvening({ now: paris('2026-11-02', '15:00') });
    expect(evening.day).toBe('2026-11-03');
    const { service, stage } = stages(evening);
    // The day before's change and reminders come at 18:30 and 19:10: not yet.
    expect(stage('Roux')).toMatchObject({ time: '20:00', status: 'booked' });
    expect(service.bookings.every((booking) => booking.stage === 'expected')).toBe(true);
  });

  it('serves lunch alone on a Sunday', () => {
    const { service } = stages(demoEvening({ now: paris('2026-11-01', '12:25') }));
    expect(service.bookings.every((booking) => booking.service === 'déjeuner')).toBe(true);
    const seated = service.bookings.filter((booking) => booking.stage === 'seated').map((booking) => booking.guestName);
    expect(seated.sort()).toEqual(['Bertrand', 'David', 'Laurent', 'Michel']);
  });

  it('suggests a dinner a guest could still book: tonight until 19:30, then the next evening it opens', () => {
    expect(demoSuggestion(paris('2026-11-03', '10:00'))).toEqual({ date: '2026-11-03', time: '20:30', partySize: 2 });
    expect(demoSuggestion(paris('2026-11-03', '19:30'))).toEqual({ date: '2026-11-03', time: '20:30', partySize: 2 });
    expect(demoSuggestion(paris('2026-11-03', '19:31')).date).toBe('2026-11-04');
    // Saturday night: Sunday serves lunch only and Monday is closed.
    expect(demoSuggestion(paris('2026-10-31', '22:00')).date).toBe('2026-11-03');
    // The seeded evening has a table for two at 20:30.
    const evening = demoEvening({ now: paris('2026-11-03', '10:00') });
    const found = evening.engine.findTable(
      { id: 'visitor', channel: 'web', language: 'fr' },
      { date: { kind: 'date', date: '2026-11-03' }, time: '20:30', partySize: 2 },
    );
    expect(found.status).toBe('available');
  });

  it('keeps the conversations played in the chat to the recorded evening', () => {
    expect(() => demoEvening({ now: paris('2026-11-03', '10:00'), fromChat: [{} as ChatOutcome] })).toThrow(RangeError);
  });
});
