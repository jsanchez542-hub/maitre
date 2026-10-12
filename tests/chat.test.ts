import { describe, expect, it } from 'vitest';
import { recordingOutcome, type ChatOutcome } from '../src/demo/chat.js';
import { DEMO_EVENING_DATE, demoEvening } from '../src/demo/evening.js';
import { RECORDINGS } from '../src/demo/recordings.js';

describe('a conversation played in the chat', () => {
  it('leaves the booking it made, with the guest who made it', () => {
    expect(recordingOutcome('book-fr')).toMatchObject({
      recording: 'book-fr',
      channel: 'whatsapp',
      language: 'fr',
      bookings: [{ date: DEMO_EVENING_DATE, time: '20:00', partySize: 4, guestName: 'Dupont', allergies: [] }],
    });
    expect(recordingOutcome('allergy-at-booking-fr').bookings).toMatchObject([{ guestName: 'Rousseau', allergies: ['nuts'] }]);
  });

  it('leaves no booking when it ends without one, and the request it passed to the team', () => {
    // A request passed on to the team, and a cancellation of a booking the conversation started with.
    expect(recordingOutcome('large-group-fr')).toMatchObject({ bookings: [], callbacks: [{ reason: 'large_group' }] });
    expect(recordingOutcome('cancel-fr')).toMatchObject({ bookings: [], callbacks: [] });
    expect(recordingOutcome('book-fr').callbacks).toEqual([]);
  });

  it('says so when there is no such conversation', () => {
    expect(() => recordingOutcome('book-de')).toThrow(/no recorded conversation "book-de"/);
  });
});

describe('a conversation played in the site’s chat', () => {
  const onTheSite = RECORDINGS.filter((recording) => recording.channel === 'web').map((recording) => recordingOutcome(recording.id));
  const booked = onTheSite.filter((outcome) => outcome.bookings.length > 0);

  it('books for the demo evening, in every language the site speaks', () => {
    expect(booked.map((outcome) => outcome.recording)).toEqual(['web-book-fr', 'web-allergy-at-booking-fr', 'web-book-en', 'web-book-es']);
    for (const outcome of booked) expect(outcome.bookings.map((made) => made.date), outcome.recording).toEqual([DEMO_EVENING_DATE]);
    expect(new Set(booked.map((outcome) => outcome.language))).toEqual(new Set(['fr', 'en', 'es']));
  });

  it('keeps the number the guest typed in the chat’s field, and the evening books it as the site’s', () => {
    expect(recordingOutcome('web-book-fr')).toMatchObject({ channel: 'web', phone: '+33639980021', bookings: [{ time: '20:00', partySize: 4, guestName: 'Mercier' }] });
    const { engine } = demoEvening({ fromChat: [recordingOutcome('web-book-fr')] });
    expect(engine.serviceDay(DEMO_EVENING_DATE, 'fr').bookings.find((booking) => booking.guestName === 'Mercier')).toMatchObject({ channel: 'web', time: '20:00' });
  });

  it('fits all at once in the evening, for a visitor who plays every one the site offers', () => {
    const { engine } = demoEvening({ fromChat: onTheSite });
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    for (const made of booked.flatMap((outcome) => outcome.bookings)) {
      expect(day.bookings.find((booking) => booking.guestName === made.guestName && booking.time === made.time)?.table, made.guestName).toBeDefined();
    }
  });

  it('passes a request to the team with the number typed in the field, among the evening’s calls to return', () => {
    const calls = (evening: ReturnType<typeof demoEvening>) => evening.engine.serviceDay(DEMO_EVENING_DATE, 'fr').callbacks;
    const before = calls(demoEvening());
    for (const [id, reason, phone] of [
      ['web-large-group-fr', 'large_group', '+33639980024'],
      ['web-large-group-es', 'large_group', '+33639980025'],
      ['web-allergen-unknown-en', 'allergy_question', '+447700900202'],
    ] as const) {
      const outcome = recordingOutcome(id);
      expect(outcome, id).toMatchObject({ phone, bookings: [], callbacks: [{ reason }] });
      const after = calls(demoEvening({ fromChat: [outcome] }));
      expect(after.open, id).toBe(before.open + 1);
      expect(after.list.some((callback) => callback.reason === reason && callback.channel === 'web' && callback.phone !== undefined), id).toBe(true);
    }
  });

  it('brings no name the evening already has', () => {
    const tonight = new Set(demoEvening().engine.serviceDay(DEMO_EVENING_DATE, 'fr').bookings.map((booking) => booking.guestName));
    for (const made of booked.flatMap((outcome) => outcome.bookings)) expect(tonight.has(made.guestName), made.guestName).toBe(false);
  });
});

describe('the evening with what the chat booked', () => {
  const withBookings: ChatOutcome[] = RECORDINGS.map((recording) => recordingOutcome(recording.id)).filter((outcome) => outcome.bookings.length > 0);

  it('covers every conversation that books', () => {
    expect(withBookings.map((outcome) => outcome.recording)).toEqual([
      'book-fr',
      'book-en',
      'book-es',
      'allergy-at-booking-fr',
      'day-after-tomorrow-fr',
      'day-of-month-en',
      'closed-day-en',
      'full-fr',
      'dictated-number-fr',
      'web-book-fr',
      'web-allergy-at-booking-fr',
      'web-book-en',
      'web-book-es',
    ]);
  });

  it.each(withBookings.map((outcome) => [outcome.recording, outcome] as const))(
    '%s: its booking is in the evening, with a table on the plan when it is that night',
    (_recording, outcome) => {
      const { engine } = demoEvening({ fromChat: [outcome] });
      for (const made of outcome.bookings) {
        const day = engine.serviceDay(made.date, 'fr');
        const found = day.bookings.find(
          (booking) => booking.guestName === made.guestName && booking.time === made.time && booking.partySize === made.partySize && booking.channel === outcome.channel,
        );
        expect(found, `${made.guestName} on ${made.date} at ${made.time}`).toBeDefined();
        expect(found?.allergies.map((allergen) => allergen.id)).toEqual(made.allergies);
        if (made.date === DEMO_EVENING_DATE) expect(found?.table).toBeDefined();
      }
    },
  );

  it('is the same evening as before when nothing was played', () => {
    const view = (evening: ReturnType<typeof demoEvening>) => JSON.stringify(evening.engine.serviceDay(DEMO_EVENING_DATE, 'fr'));
    expect(view(demoEvening({ fromChat: [] }))).toBe(view(demoEvening()));
  });

  it('refuses a conversation dated after the week of the evening began', () => {
    const late = { ...withBookings[0], at: '2026-10-15T08:00:00.000Z' } as ChatOutcome;
    expect(() => demoEvening({ fromChat: [late] })).toThrow(/took place after the evening's week began/);
  });
});
