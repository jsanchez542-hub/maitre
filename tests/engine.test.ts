import { describe, expect, it } from 'vitest';
import type { FindTableResult } from '../src/engine.js';
import { FRIDAY, guest, harness, referenceFor } from './fixtures.js';

const NBSP = ' ';

function times(result: FindTableResult): string[] {
  if (result.status !== 'unavailable') throw new Error(`expected unavailable, got ${result.status}`);
  return result.alternatives.map((offer) => `${offer.date} ${offer.time}`);
}

function holdTable(h: ReturnType<typeof harness>, sessionId: string, time: string, partySize: number, phone?: string) {
  const result = h.engine.findTable(guest(sessionId, phone ?? `+3361234560${sessionId.length}`), {
    date: FRIDAY,
    time,
    partySize,
  });
  if (result.status !== 'available') throw new Error(`setup failed: ${sessionId} at ${time} is ${result.status}`);
  return result;
}

describe('finding a table', () => {
  it('sets a free table aside and says it back in full', () => {
    const h = harness();
    const result = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 4 });
    expect(result).toMatchObject({
      status: 'available',
      date: '2026-10-16',
      time: '20:00',
      partySize: 4,
      service: 'dîner',
      heldForMinutes: 5,
      readBack: `une table pour 4 personnes le vendredi 16 octobre à 20${NBSP}h`,
    });
    expect(h.store.snapshot().holds).toHaveLength(1);
  });

  it('speaks the guest’s language', () => {
    const h = harness();
    const result = h.engine.findTable(guest('g1', '+447700900123', 'en'), { date: FRIDAY, time: '20:30', partySize: 2 });
    expect(result).toMatchObject({ readBack: 'a table for 2 on Friday 16 October at 8:30 pm', service: 'dinner' });
  });

  it('passes large parties to a person instead of joining tables', () => {
    const h = harness();
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 7 })).toEqual({
      status: 'needs_staff',
      reason: 'party_too_large',
      maxPartySize: 6,
    });
  });

  it('refuses requests that cannot be read', () => {
    const h = harness();
    const ask = (request: Parameters<typeof h.engine.findTable>[1]) => h.engine.findTable(guest('g1'), request);
    expect(ask({ date: FRIDAY, time: '20:00', partySize: 0 })).toEqual({ status: 'invalid', reason: 'invalid_party_size' });
    expect(ask({ date: FRIDAY, time: '20:00', partySize: 2.5 })).toEqual({ status: 'invalid', reason: 'invalid_party_size' });
    expect(ask({ date: FRIDAY, time: '8pm', partySize: 2 })).toEqual({ status: 'invalid', reason: 'invalid_time' });
    expect(ask({ date: { kind: 'date', date: '2026-10-13' }, time: '20:00', partySize: 2 })).toEqual({
      status: 'invalid',
      reason: 'in_the_past',
    });
  });
});

describe('when the time asked for does not work', () => {
  it('offers the nearest times of the day when it is outside opening hours', () => {
    const h = harness();
    const result = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '16:00', partySize: 2 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'outside_hours' });
    expect(times(result)).toEqual(['2026-10-16 13:30', '2026-10-16 19:00', '2026-10-17 13:30']);
  });

  it('rounds to the grid by offering the times either side', () => {
    const h = harness();
    const result = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:10', partySize: 2 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'not_a_slot' });
    expect(times(result)).toEqual(['2026-10-16 20:15', '2026-10-16 20:00', '2026-10-17 20:15']);
  });

  it('skips a closed day and an exceptional closure', () => {
    const h = harness();
    const monday = h.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2026-10-19' }, time: '20:00', partySize: 2 });
    expect(monday).toMatchObject({ status: 'unavailable', reason: 'closed' });
    expect(times(monday)).toEqual(['2026-10-20 20:00']);

    const christmas = h.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2026-12-25' }, time: '20:00', partySize: 2 });
    expect(christmas).toMatchObject({ status: 'unavailable', reason: 'closed' });
    expect(times(christmas)).toEqual(['2026-12-26 20:00']);
  });

  it('keeps the notice period and offers the first time that respects it', () => {
    const h = harness('2026-10-14T09:30:00Z'); // 11:30 in Paris
    const result = h.engine.findTable(guest('g1'), { date: { kind: 'relative', days: 0 }, time: '12:00', partySize: 2 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'too_soon' });
    expect(times(result)).toEqual(['2026-10-14 12:30', '2026-10-15 12:00']);
    expect(result.status === 'unavailable' && result.alternatives[0]?.readBack).toBe(`mercredi 14 octobre à 12${NBSP}h${NBSP}30`);
  });

  it('says how far ahead bookings open', () => {
    const h = harness();
    const result = h.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2027-01-13' }, time: '20:00', partySize: 2 });
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'too_far_ahead',
      alternatives: [],
      lastBookableDay: { date: '2027-01-12', readBack: 'mardi 12 janvier 2027' },
    });
  });
});

describe('capacity', () => {
  it('moves a party to a bigger table, but never leaves more than two seats empty', () => {
    const h = harness();
    holdTable(h, 'g1', '20:00', 4);
    holdTable(h, 'g2', '20:00', 4);
    holdTable(h, 'g3', '20:00', 4);
    expect(h.store.snapshot().holds.map((hold) => hold.tableGroup).sort()).toEqual(['t4', 't4', 't6']);
    const fourth = h.engine.findTable(guest('g4', '+33612345699'), { date: FRIDAY, time: '20:00', partySize: 4 });
    expect(fourth).toMatchObject({ status: 'unavailable', reason: 'full' });
  });

  it('offers a later time once the stays before it have ended', () => {
    const h = harness();
    for (const id of ['g1', 'g2', 'g3', 'g4']) holdTable(h, id, '20:00', 2);
    const result = h.engine.findTable(guest('g5', '+33612345699'), { date: FRIDAY, time: '20:00', partySize: 2 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'full' });
    // Stays of two last 90 minutes: the tables taken at 20:00 are free again at 21:30.
    expect(times(result)).toEqual(['2026-10-16 21:30', '2026-10-17 20:00']);
  });

  it('frees a table at the very minute a stay ends, not a minute later', () => {
    const h = harness();
    for (const id of ['g1', 'g2', 'g3', 'g4']) holdTable(h, id, '20:30', 2);
    const result = h.engine.findTable(guest('g5', '+33612345699'), { date: FRIDAY, time: '20:30', partySize: 2 });
    // A stay from 19:00 ends at 20:30, exactly when the others start: no overlap.
    expect(times(result)).toEqual(['2026-10-16 19:00', '2026-10-17 20:30']);
  });

  it('counts the length of each stay, not just its start', () => {
    const h = harness();
    holdTable(h, 'g1', '19:00', 6); // the only table for six, until 21:30
    expect(h.engine.findTable(guest('g2', '+33612345699'), { date: FRIDAY, time: '21:15', partySize: 6 })).toMatchObject({
      status: 'unavailable',
      reason: 'full',
    });
    expect(h.engine.findTable(guest('g2', '+33612345699'), { date: FRIDAY, time: '21:30', partySize: 6 })).toMatchObject({
      status: 'available',
    });
  });

  it('sees a stay that runs past midnight from either side', () => {
    const lateFirst = harness('2026-12-30T10:00:00Z');
    expect(
      lateFirst.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2026-12-31' }, time: '23:30', partySize: 6 }),
    ).toMatchObject({ status: 'available' });
    expect(
      lateFirst.engine.findTable(guest('g2', '+33612345699'), { date: { kind: 'date', date: '2027-01-01' }, time: '00:30', partySize: 6 }),
    ).toMatchObject({ status: 'unavailable', reason: 'full' });

    const earlyFirst = harness('2026-12-30T10:00:00Z');
    expect(
      earlyFirst.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2027-01-01' }, time: '00:30', partySize: 6 }),
    ).toMatchObject({ status: 'available' });
    expect(
      earlyFirst.engine.findTable(guest('g2', '+33612345699'), { date: { kind: 'date', date: '2026-12-31' }, time: '23:30', partySize: 6 }),
    ).toMatchObject({ status: 'unavailable', reason: 'full' });
  });
});

describe('tables set aside', () => {
  it('keeps the table from other guests until the hold runs out', () => {
    const h = harness();
    holdTable(h, 'g1', '20:00', 6);
    const other = guest('g2', '+33612345699');
    expect(h.engine.findTable(other, { date: FRIDAY, time: '20:00', partySize: 6 })).toMatchObject({ reason: 'full' });
    h.advanceMinutes(5);
    expect(h.engine.findTable(other, { date: FRIDAY, time: '20:00', partySize: 6 })).toMatchObject({ status: 'available' });
  });

  it('never blocks the guest with their own hold, and keeps only one per guest', () => {
    const h = harness();
    holdTable(h, 'g1', '20:00', 6);
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 6 })).toMatchObject({ status: 'available' });
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:15', partySize: 6 })).toMatchObject({ status: 'available' });
    const holds = h.store.snapshot().holds;
    expect(holds).toHaveLength(1);
    expect(holds[0]?.time).toBe('20:15');
  });

  it('keeps the current hold when the new time is not available', () => {
    const h = harness();
    holdTable(h, 'g2', '21:30', 6, '+33612345699');
    holdTable(h, 'g1', '19:00', 6);
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '21:15', partySize: 6 })).toMatchObject({ reason: 'full' });
    expect(h.store.snapshot().holds.filter((hold) => hold.sessionId === 'g1')).toHaveLength(1);
  });
});

describe('booking', () => {
  it('books a held table with the number the channel vouches for', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 4, '+33612345678');
    const result = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: '  Marie   Dupont ', allergies: ['nuts', 'nuts'] });
    expect(result).toMatchObject({
      status: 'booked',
      booking: { reference: referenceFor(1), guestName: 'Marie Dupont', status: 'booked', allergies: ['nuts'] },
    });
    const [stored] = h.store.snapshot().bookings;
    expect(stored).toMatchObject({ phone: '+33612345678', phoneSource: 'whatsapp', channel: 'whatsapp', stayMinutes: 120 });
    expect(h.store.snapshot().holds).toHaveLength(0);
  });

  it('never shows a phone number to the assistant', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 2, '+33612345678');
    const result = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    expect(JSON.stringify(result)).not.toContain('612345678');
  });

  it('books once when asked twice with the same hold', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 4, '+33612345678');
    const first = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    const second = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    expect(second).toEqual(first);
    expect(h.store.snapshot().bookings).toHaveLength(1);
  });

  it('will not book without a number from the channel', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 2);
    expect(h.engine.book(guest('g1', null), { holdId: held.holdId, guestName: 'Dupont' })).toEqual({
      status: 'phone_required',
    });
  });

  it('refuses a hold that ran out or belongs to someone else', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 2, '+33612345678');
    expect(h.engine.book(guest('g2', '+33612345699'), { holdId: held.holdId, guestName: 'Martin' })).toEqual({
      status: 'hold_expired',
    });
    h.advanceMinutes(5);
    expect(h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' })).toEqual({ status: 'hold_expired' });
  });

  it('does not book the same guest twice for overlapping times', () => {
    const h = harness();
    const first = holdTable(h, 'g1', '20:00', 4, '+33612345678');
    h.engine.book(guest('g1'), { holdId: first.holdId, guestName: 'Dupont' });
    const second = holdTable(h, 'g1', '20:30', 2, '+33612345678');
    expect(h.engine.book(guest('g1'), { holdId: second.holdId, guestName: 'Dupont' })).toMatchObject({
      status: 'duplicate',
      booking: { reference: referenceFor(1), time: '20:00' },
    });
  });

  it('explains what is wrong with the details', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 2, '+33612345678');
    const result = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: ' ', allergies: ['peanut'] });
    expect(result).toMatchObject({ status: 'invalid' });
    expect(result.status === 'invalid' && result.problems).toEqual([
      'guestName must be 1 to 80 characters of plain text',
      'unknown allergen "peanut"',
    ]);
    expect(h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Du\u0000pont' })).toMatchObject({ status: 'invalid' });
  });
});

describe('cancelling', () => {
  function booked(h: ReturnType<typeof harness>, time = '20:00', partySize = 6) {
    const held = holdTable(h, 'g1', time, partySize, '+33612345678');
    const result = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    if (result.status !== 'booked') throw new Error('setup failed');
    return result.booking;
  }

  it('frees the table for the next guest', () => {
    const h = harness();
    const booking = booked(h);
    const other = guest('g2', '+33612345699');
    expect(h.engine.findTable(other, { date: FRIDAY, time: '20:00', partySize: 6 })).toMatchObject({ reason: 'full' });
    expect(h.engine.cancel(guest('g1'), { reference: booking.reference })).toMatchObject({ status: 'cancelled' });
    expect(h.engine.findTable(other, { date: FRIDAY, time: '20:00', partySize: 6 })).toMatchObject({ status: 'available' });
  });

  it('accepts the reference however the guest types it', () => {
    const h = harness();
    const booking = booked(h);
    const typed = `${booking.reference.slice(0, 3).toLowerCase()} ${booking.reference.slice(3)}`;
    expect(h.engine.cancel(guest('g1'), { reference: typed })).toMatchObject({ status: 'cancelled' });
  });

  it('treats someone else’s booking as not found', () => {
    const h = harness();
    const booking = booked(h);
    expect(h.engine.cancel(guest('g2', '+33612345699'), { reference: booking.reference })).toEqual({ status: 'not_found' });
  });

  it('knows a booking already cancelled or already started', () => {
    const h = harness();
    const booking = booked(h);
    h.engine.cancel(guest('g1'), { reference: booking.reference });
    expect(h.engine.cancel(guest('g1'), { reference: booking.reference })).toMatchObject({ status: 'already_cancelled' });

    const later = harness();
    const tonight = booked(later);
    later.setNow('2026-10-16T18:30:00Z'); // 20:30 in Paris, after the 20:00 booking began
    expect(later.engine.cancel(guest('g1'), { reference: tonight.reference })).toMatchObject({ status: 'already_started' });
  });
});

describe('changing a booking', () => {
  it('lets a guest move into time their own booking would otherwise block', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 4, '+33612345678');
    const booked = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    if (booked.status !== 'booked') throw new Error('setup failed');
    holdTable(h, 'g2', '20:00', 4, '+33612345611');
    holdTable(h, 'g3', '20:00', 4, '+33612345622');

    const without = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:30', partySize: 4 });
    expect(without).toMatchObject({ status: 'unavailable', reason: 'full' });

    const withChange = h.engine.findTable(guest('g1'), {
      date: FRIDAY,
      time: '20:30',
      partySize: 4,
      changing: booked.booking.reference,
    });
    if (withChange.status !== 'available') throw new Error('expected a table');
    const changed = h.engine.change(guest('g1'), { reference: booked.booking.reference, holdId: withChange.holdId });
    expect(changed).toMatchObject({
      status: 'changed',
      booking: { reference: booked.booking.reference, time: '20:30', status: 'booked' },
      previous: { time: '20:00', partySize: 4 },
    });

    const again = h.engine.change(guest('g1'), { reference: booked.booking.reference, holdId: withChange.holdId });
    expect(again).toMatchObject({ status: 'changed', booking: { time: '20:30' } });
    expect(again).not.toHaveProperty('previous');
    expect(h.store.snapshot().bookings).toHaveLength(1);
  });
});

describe('the guest’s own bookings', () => {
  it('lists only theirs, only active and still to come', () => {
    const h = harness();
    const friday = holdTable(h, 'g1', '20:00', 2, '+33612345678');
    h.engine.book(guest('g1'), { holdId: friday.holdId, guestName: 'Dupont' });
    const saturday = h.engine.findTable(guest('g1'), { date: { kind: 'date', date: '2026-10-17' }, time: '12:00', partySize: 2 });
    if (saturday.status !== 'available') throw new Error('setup failed');
    const sat = h.engine.book(guest('g1'), { holdId: saturday.holdId, guestName: 'Dupont' });
    if (sat.status !== 'booked') throw new Error('setup failed');
    h.engine.cancel(guest('g1'), { reference: sat.booking.reference });
    const other = holdTable(h, 'g2', '21:30', 2, '+33612345699');
    h.engine.book(guest('g2', '+33612345699'), { holdId: other.holdId, guestName: 'Martin' });

    const mine = h.engine.myBookings(guest('g1'));
    expect(mine.status === 'ok' && mine.bookings.map((booking) => `${booking.date} ${booking.time}`)).toEqual([
      '2026-10-16 20:00',
    ]);
    expect(h.engine.myBookings(guest('g1', null))).toEqual({ status: 'phone_required' });
  });

  it('confirms the next booking once, however many times the guest answers', () => {
    const h = harness();
    const held = holdTable(h, 'g1', '20:00', 2, '+33612345678');
    const booked = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    if (booked.status !== 'booked') throw new Error('setup failed');
    expect(h.engine.confirm(guest('g1'))).toMatchObject({ status: 'confirmed', booking: { status: 'confirmed' } });
    expect(h.engine.confirm(guest('g1'))).toMatchObject({ status: 'confirmed' });
    expect(h.engine.confirm(guest('g2', '+33612345699'), { reference: booked.booking.reference })).toEqual({
      status: 'not_found',
    });
  });
});

describe('handing over to the team', () => {
  it('records the request with the number the channel gave', () => {
    const h = harness();
    expect(
      h.engine.requestCallback(guest('g1'), { reason: 'large_group', summary: 'Anniversaire, 12 personnes samedi soir' }),
    ).toMatchObject({ status: 'recorded' });
    expect(h.store.snapshot().callbacks[0]).toMatchObject({ phone: '+33612345678', reason: 'large_group', status: 'open' });
  });

  it('refuses an unknown reason or an empty summary', () => {
    const h = harness();
    expect(h.engine.requestCallback(guest('g1'), { reason: 'whatever', summary: 'x' })).toMatchObject({ status: 'invalid' });
    expect(h.engine.requestCallback(guest('g1'), { reason: 'other', summary: '   ' })).toMatchObject({ status: 'invalid' });
  });

  it('adds a second request of the same kind to the first, so the team calls once about both', () => {
    const h = harness();
    const first = h.engine.requestCallback(guest('g1'), { reason: 'allergy_question', summary: 'Mousse : fruits à coque ?' });
    expect(h.engine.requestCallback(guest('g1'), { reason: 'allergy_question', summary: 'Mousse : fruits à coque ?' })).toEqual(first);
    expect(h.engine.requestCallback(guest('g1'), { reason: 'allergy_question', summary: 'Soupe : sésame ?' })).toEqual(first);
    expect(h.store.snapshot().callbacks).toMatchObject([{ summary: 'Mousse : fruits à coque ? Soupe : sésame ?' }]);

    // Another reason, another conversation, or a request the team has already dealt with starts a new one.
    h.engine.requestCallback(guest('g1'), { reason: 'complaint', summary: 'Plat froid' });
    h.engine.requestCallback(guest('g2', '+33698765432'), { reason: 'allergy_question', summary: 'Mousse : fruits à coque ?' });
    if (first.status !== 'recorded') throw new Error('expected a request');
    h.engine.completeCallback(first.id);
    expect(h.engine.requestCallback(guest('g1'), { reason: 'allergy_question', summary: 'Tarte : œufs ?' })).not.toEqual(first);
    expect(h.store.snapshot().callbacks).toHaveLength(4);
  });

  it('gives a number typed later to the requests made before it', () => {
    const h = harness();
    const web = guest('w1', null, 'fr', 'web');
    expect(h.engine.requestCallback(web, { reason: 'complaint', summary: 'Plat froid' })).toMatchObject({ status: 'recorded', needsPhone: true });
    expect(h.engine.addPhoneToCallbacks(web)).toBe(0);

    const typed = { ...web, phone: { e164: '+33655555555', source: 'form' as const } };
    expect(h.engine.addPhoneToCallbacks(typed)).toBe(1);
    expect(h.store.snapshot().callbacks[0]).toMatchObject({ phone: '+33655555555' });
    expect(h.engine.addPhoneToCallbacks(typed)).toBe(0);
    expect(h.engine.requestCallback(typed, { reason: 'complaint', summary: 'Plat froid' })).not.toHaveProperty('needsPhone');
  });
});

describe('opening hours', () => {
  it('describes the next seven days, closures included', () => {
    const h = harness();
    const result = h.engine.openingHours('fr');
    if (result.status !== 'ok') throw new Error('expected hours');
    expect(result.days).toHaveLength(7);
    expect(result.days[0]).toMatchObject({
      date: '2026-10-14',
      readBack: 'mercredi 14 octobre',
      open: true,
      sittings: [
        { service: 'déjeuner', firstBooking: `12${NBSP}h`, lastBooking: `13${NBSP}h${NBSP}30` },
        { service: 'dîner', firstBooking: `19${NBSP}h`, lastBooking: `21${NBSP}h${NBSP}30` },
      ],
    });
    expect(result.days[5]).toMatchObject({ date: '2026-10-19', open: false, sittings: [] });
  });

  it('gives the reason of an exceptional closure', () => {
    const h = harness();
    expect(h.engine.openingHours('en', { kind: 'date', date: '2026-12-25' })).toMatchObject({
      status: 'ok',
      days: [{ open: false, note: 'Closed for Christmas', readBack: 'Friday 25 December' }],
    });
  });
});
