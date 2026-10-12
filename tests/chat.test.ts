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

  it('leaves nothing when it ends without a new booking', () => {
    // A request passed on to the team, and a cancellation of a booking the conversation started with.
    expect(recordingOutcome('large-group-fr').bookings).toEqual([]);
    expect(recordingOutcome('cancel-fr').bookings).toEqual([]);
  });

  it('says so when there is no such conversation', () => {
    expect(() => recordingOutcome('book-de')).toThrow(/no recorded conversation "book-de"/);
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

  it('fits every booking conversation at once, for a visitor who plays them all', () => {
    const { engine } = demoEvening({ fromChat: withBookings });
    const tonight = withBookings.flatMap((outcome) => outcome.bookings).filter((made) => made.date === DEMO_EVENING_DATE);
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    for (const made of tonight) expect(day.bookings.some((booking) => booking.guestName === made.guestName && booking.time === made.time)).toBe(true);
  });

  it('is the same evening as before when nothing was played', () => {
    const view = (evening: ReturnType<typeof demoEvening>) => JSON.stringify(evening.engine.serviceDay(DEMO_EVENING_DATE, 'fr'));
    expect(view(demoEvening({ fromChat: [] }))).toBe(view(demoEvening()));
  });

  it('refuses a conversation dated after the week of the evening began', () => {
    const late = { ...withBookings[0], at: '2026-10-15T08:00:00.000Z' } as ChatOutcome;
    expect(() => demoEvening({ fromChat: [late] })).toThrow(/took place after the evening's week began/);
  });
});
