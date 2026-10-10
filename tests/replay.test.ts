import { describe, expect, it } from 'vitest';
import { applySetup, Replay, ReplayError, type Recording } from '../src/demo/replay.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import { BookingEngine } from '../src/engine.js';
import { MemoryStore } from '../src/store.js';
import { sequentialIds } from './fixtures.js';

/** A conversation as the export writes it, with the identifiers of the run it came from. */
function recording(change: Partial<Recording> = {}): Recording {
  return {
    id: 'book-test',
    description: 'A booking, then a change',
    language: 'fr',
    channel: 'whatsapp',
    phone: '+33611111111',
    at: '2026-10-14T08:00:00.000Z',
    setup: [],
    refs: {},
    model: 'test/model',
    turns: [
      {
        guest: 'Une table pour 2 vendredi à 20 h, au nom de Dupont.',
        reply: 'C’est réservé au nom de Dupont, référence KKKKKK.',
        latencyMs: 2100,
        costUsd: 0.002,
        tools: [
          { name: 'find_table', input: { day: 'friday', time: '20:00', partySize: 2 }, output: { status: 'available', holdId: 'recorded-hold', date: '2026-10-16', time: '20:00', partySize: 2 } },
          { name: 'book_table', input: { holdId: 'recorded-hold', guestName: 'Dupont', allergies: [] }, output: { status: 'booked', booking: { reference: 'KKKKKK' } } },
        ],
      },
      {
        guest: 'Finalement à 21 h, c’est possible ?',
        reply: 'C’est fait : votre réservation KKKKKK est à 21 h.',
        latencyMs: 2600,
        tools: [
          { name: 'find_table', input: { day: 'friday', time: '21:00', partySize: 2, changingReference: 'KKKKKK' }, output: { status: 'available', holdId: 'second-hold', time: '21:00' } },
          { name: 'change_booking', input: { reference: 'kkk-kkk', holdId: 'second-hold' }, output: { status: 'changed', booking: { reference: 'KKKKKK' } } },
        ],
      },
    ],
    ...change,
  };
}

describe('replaying a recorded conversation', () => {
  it('runs every tool call on the real engine, with its own holds and references', () => {
    const replay = new Replay(recording());
    const first = replay.next();
    const live = replay.bookings()[0];
    expect(live).toMatchObject({ date: '2026-10-16', time: '20:00', guestName: 'Dupont', phone: '+33611111111', phoneSource: 'whatsapp' });
    expect(live?.reference).not.toBe('KKKKKK');
    expect(first?.reply).toBe(`C’est réservé au nom de Dupont, référence ${live?.reference}.`);
    expect(first?.tools.map((tool) => tool.output['status'])).toEqual(['available', 'booked']);

    // The model wrote the reference its own way; the engine reads it all the same.
    const second = replay.next();
    expect(second?.reply).toBe(`C’est fait : votre réservation ${live?.reference} est à 21 h.`);
    expect(replay.bookings()).toMatchObject([{ reference: live?.reference, time: '21:00', status: 'booked' }]);
    expect(replay.done).toBe(true);
    expect(replay.next()).toBeUndefined();
  });

  it('starts from the bookings the conversation started with, under their new references', () => {
    const replay = new Replay(
      recording({
        setup: [{ ref: 'friday', date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Lefèvre', phone: '+33611111117' }],
        refs: { friday: 'MMMMMM' },
        phone: '+33611111117',
        turns: [
          {
            guest: 'Je dois annuler ma réservation MMMMMM.',
            reply: 'La réservation MMMMMM est annulée.',
            latencyMs: 1800,
            tools: [{ name: 'cancel_booking', input: { reference: 'MMMMMM' }, output: { status: 'cancelled' } }],
          },
        ],
      }),
    );
    const reference = replay.bookings()[0]?.reference ?? '';
    expect(replay.next()?.reply).toBe(`La réservation ${reference} est annulée.`);
    expect(replay.bookings()[0]?.status).toBe('cancelled');
  });

  it('stops when the engine no longer answers as it did, rather than show a reply that is not true any more', () => {
    // Friday at 20:00 is full here, but the recorded conversation found a table.
    const full = Array.from({ length: 11 }, (_, index) => ({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: `Client ${index + 1}` }));
    const replay = new Replay(recording({ setup: full }));
    expect(() => replay.next()).toThrow(ReplayError);
  });

  it('makes the setup bookings through the staff, and refuses one that cannot be made', () => {
    const engine = new BookingEngine(DEMO_RESTAURANT, new MemoryStore(), { now: () => new Date('2026-10-14T08:00:00Z'), ids: sequentialIds() });
    expect(Object.keys(applySetup(engine, [{ ref: 'one', date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Leroy' }]))).toEqual(['one']);
    expect(() => applySetup(engine, [{ date: '2026-10-19', time: '20:00', partySize: 2, guestName: 'Lundi' }])).toThrow(/could not be made: unavailable/);
  });
});
