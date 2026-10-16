import type { Session } from 'maitre';
import { demoEvening } from 'maitre/demo';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentSandbox, forgetSandbox, keepChat, keepSandbox, noteOfCall, recordTurn, takeNews } from './sandbox';

const OPENED = {
  id: 'abc',
  expiresAt: '2026-10-13T20:00:00.000Z',
  clock: '2026-10-16T18:05:00.000Z',
  day: '2026-10-16',
  suggestion: { date: '2026-10-17', time: '20:30', partySize: 2 },
  callsLeft: 3,
  calls: { perRestaurant: 3, maxSeconds: 240 },
};
const BOOKED = { reference: 'AB12CD', date: '2026-10-16', time: '21:30', partySize: 2 };

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the visitor’s restaurant, kept in the browser', () => {
  it('is kept until a few minutes before it expires', () => {
    keepSandbox(OPENED);
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))).toMatchObject({ id: 'abc', openedAt: OPENED.clock, booked: [] });
    expect(currentSandbox(Date.parse('2026-10-13T19:58:00.000Z'))).toBeNull();
    forgetSandbox();
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))).toBeNull();
  });

  it('remembers what the chat booked, and announces it once', () => {
    keepSandbox(OPENED);
    recordTurn('abc', { booked: [BOOKED], passedToTeam: false });
    recordTurn('abc', { booked: [], passedToTeam: false });
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))?.booked).toEqual([BOOKED]);
    expect(takeNews('abc')).toBe('booked');
    expect(takeNews('abc')).toBeUndefined();
    recordTurn('abc', { booked: [], passedToTeam: true });
    expect(takeNews('abc')).toBe('passed');
  });

  it('keeps the chat’s conversation with its restaurant, lets it go for another, and drops it with the restaurant', () => {
    const at = Date.parse('2026-10-13T12:00:00.000Z');
    const chat = {
      session: 'talk-1',
      lines: [
        { id: 0, from: 'agent' as const, text: 'Bonsoir' },
        { id: 1, from: 'guest' as const, text: 'Une table demain soir ?' },
      ],
      askingPhone: true,
      left: false,
    };
    keepSandbox(OPENED);
    keepChat('abc', chat);
    expect(currentSandbox(at)?.chat).toEqual(chat);
    // Another restaurant's changes nothing, and what the panel is told keeps it.
    keepChat('other', null);
    recordTurn('abc', { booked: [BOOKED], passedToTeam: false });
    expect(currentSandbox(at)?.chat).toEqual(chat);
    keepChat('abc', null);
    expect(currentSandbox(at)?.chat).toBeUndefined();
    // A line it cannot read is left out, not the conversation.
    localStorage.setItem('maitre.sandbox', JSON.stringify({ ...currentSandbox(at), chat: { ...chat, lines: [...chat.lines, { id: 'two', from: 'guest' }] } }));
    expect(currentSandbox(at)?.chat?.lines).toEqual(chat.lines);
    // Expired, the restaurant goes from the browser, its conversation with it.
    expect(currentSandbox(Date.parse('2026-10-13T19:58:00.000Z'))).toBeNull();
    expect(localStorage.getItem('maitre.sandbox')).toBeNull();
  });

  it('keeps the calls the restaurant takes; how many are left, the Worker counts', () => {
    keepSandbox(OPENED);
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))).toMatchObject({ calls: { perRestaurant: 3, maxSeconds: 240 } });
  });

  it('reads one kept before the demo took calls as one whose calls are unknown', () => {
    localStorage.setItem('maitre.sandbox', JSON.stringify({ id: 'abc', expiresAt: OPENED.expiresAt, openedAt: OPENED.clock, booked: [] }));
    const kept = currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'));
    expect(kept && 'calls' in kept).toBe(false);
  });

  it('ignores another restaurant’s turn, and storage it cannot read', () => {
    keepSandbox(OPENED);
    recordTurn('other', { booked: [BOOKED], passedToTeam: false });
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))?.booked).toEqual([]);
    localStorage.setItem('maitre.sandbox', '{"id": 42');
    expect(currentSandbox(Date.parse('2026-10-13T12:00:00.000Z'))).toBeNull();
  });
});

describe('what a call left in the restaurant', () => {
  it('finds the bookings made on the line since it began, tomorrow’s too, and nothing from before or from the chat', () => {
    // Friday 16 at 20:05: the caller books Saturday's dinner, and the chat books another table the same minute.
    const evening = demoEvening({ now: new Date('2026-10-16T18:05:00.000Z') });
    const book = (session: Session, guestName: string) => {
      const found = evening.engine.findTable(session, { date: { kind: 'date', date: '2026-10-17' }, time: '20:30', partySize: 2 });
      if (found.status !== 'available') throw new Error('Saturday at 20:30 is free in the seeded week');
      const made = evening.engine.book(session, { holdId: found.holdId, guestName });
      if (made.status !== 'booked') throw new Error('the table held is booked');
      return made.booking;
    };
    const called = book({ id: 'call-1', channel: 'voice', language: 'fr', phone: { e164: '+33639980051', source: 'keypad' } }, 'Garnier');
    book({ id: 'chat-1', channel: 'web', language: 'fr', phone: { e164: '+33639980052', source: 'form' } }, 'Lemoine');
    const days = ['2026-10-16', '2026-10-17'].map((date) => evening.engine.serviceDay(date, 'fr'));

    expect(noteOfCall(days, '2026-10-16T18:04:00.000Z')).toEqual({
      booked: [{ reference: called.reference, date: '2026-10-17', time: '20:30', partySize: 2 }],
      passedToTeam: false,
    });
    // A call that began after it left nothing.
    expect(noteOfCall(days, '2026-10-16T18:06:00.000Z')).toEqual({ booked: [], passedToTeam: false });
  });
});
