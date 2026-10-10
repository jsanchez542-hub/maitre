import { describe, expect, it } from 'vitest';
import { FRIDAY, guest, harness } from './fixtures.js';

// Friday 16 October 2026 at 20:07 in Paris.
const FRIDAY_EVENING = '2026-10-16T18:07:00Z';
const NBSP = ' ';

describe('a party on the spot', () => {
  it('is booked for now, confirmed, and needs neither a name nor a phone', () => {
    const h = harness(FRIDAY_EVENING);
    const result = h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true });
    expect(result).toMatchObject({
      status: 'booked',
      booking: { time: '20:07', status: 'confirmed', guestName: 'Client sur place', walkIn: true, channel: 'staff', tableGroup: 't2' },
    });
    expect(result.status === 'booked' && result.booking).not.toHaveProperty('phone');
  });

  it('has no name of its own: whoever reads the day sees a walk-in, in their language', () => {
    const h = harness(FRIDAY_EVENING);
    h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true, language: 'fr' });
    const names = (['fr', 'en', 'es'] as const).map((language) => h.engine.serviceDay('2026-10-16', language).bookings[0]?.guestName);
    expect(names).toEqual(['Client sur place', 'Walk-in guest', 'Cliente sin reserva']);
  });

  it('keeps a name the staff give it, and refuses one it cannot read', () => {
    const h = harness(FRIDAY_EVENING);
    expect(h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true, guestName: ' Garnier ' })).toMatchObject({
      status: 'booked',
      booking: { guestName: 'Garnier' },
    });
    expect(h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true, guestName: 'Gar\u0000nier' })).toEqual({
      status: 'invalid',
      problems: ['guestName must be 1 to 80 characters of plain text'],
    });
  });

  it('takes the table away from the assistant, which is the whole point of recording it', () => {
    const h = harness(FRIDAY_EVENING);
    h.engine.staffBook({ date: '2026-10-16', partySize: 6, walkIn: true });
    // A guest writing at the same moment asks for the only table for six at 21:15, past the
    // notice period but while the party seated at 20:07 still has it (until 22:37).
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '21:15', partySize: 6 })).toMatchObject({
      status: 'unavailable',
      reason: 'full',
    });
  });

  it('can only be booked for today', () => {
    const h = harness(FRIDAY_EVENING);
    expect(h.engine.staffBook({ date: '2026-10-17', partySize: 2, walkIn: true })).toEqual({
      status: 'invalid',
      problems: ['a party on the spot is booked for today'],
    });
  });
});

describe('bookings entered by the staff', () => {
  it('skip the notice period and the quarter-hour grid', () => {
    const h = harness(FRIDAY_EVENING);
    // 20:20 tonight: too soon and off the grid for a guest, fine for the staff.
    expect(h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:20', partySize: 2 })).toMatchObject({ status: 'unavailable' });
    expect(h.engine.staffBook({ date: '2026-10-16', time: '20:20', partySize: 2, guestName: 'Martin' })).toMatchObject({
      status: 'booked',
      booking: { time: '20:20', status: 'booked', walkIn: false },
    });
  });

  it('respect capacity like everyone else, and get the nearest free times instead', () => {
    const h = harness();
    const held = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 6 });
    expect(held.status).toBe('available');
    const result = h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 6, guestName: 'Martin' });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'full' });
    // The table for six is held from 20:00 to 22:30: before it, 19:00 would end too late (21:30),
    // so nothing fits that evening, and Saturday at 20:00 is the next offer.
    expect(result.status === 'unavailable' && result.alternatives.map((offer) => `${offer.date} ${offer.time}`)).toEqual([
      '2026-10-17 20:00',
    ]);
  });

  it('read the phone number however it is typed and show it grouped', () => {
    const h = harness();
    const result = h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin', phone: '06 12 34 56 78' });
    expect(result).toMatchObject({ status: 'booked', booking: { phone: '+33 6 12 34 56 78', phoneSource: 'staff' } });
    expect(h.store.snapshot().bookings[0]?.phone).toBe('+33612345678');
    expect(h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin', phone: '0612' })).toMatchObject({
      status: 'invalid',
    });
  });

  it('refuse a past date and a party too large for one table', () => {
    const h = harness();
    expect(h.engine.staffBook({ date: '2026-10-13', time: '20:00', partySize: 2, guestName: 'Martin' })).toMatchObject({
      status: 'invalid',
      problems: ['date is in the past'],
    });
    expect(h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 9, guestName: 'Martin' })).toMatchObject({
      status: 'invalid',
      problems: ['parties larger than 6 need tables joined, which bookings do not handle'],
    });
  });
});

describe('staff actions', () => {
  function booked(h: ReturnType<typeof harness>) {
    const result = h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin' });
    if (result.status !== 'booked') throw new Error('setup failed');
    return result.booking.reference;
  }

  it('cancel any booking, once', () => {
    const h = harness();
    const reference = booked(h);
    expect(h.engine.staffCancel(reference)).toMatchObject({ status: 'done', booking: { status: 'cancelled' } });
    expect(h.engine.staffCancel(reference)).toEqual({ status: 'not_allowed', reason: 'already_cancelled' });
    expect(h.engine.staffCancel('AAAAAA')).toEqual({ status: 'not_found' });
  });

  it('mark a no-show only once the time has passed', () => {
    const h = harness();
    const reference = booked(h);
    expect(h.engine.markNoShow(reference)).toEqual({ status: 'not_allowed', reason: 'not_started' });
    h.setNow('2026-10-16T18:45:00Z');
    expect(h.engine.markNoShow(reference)).toMatchObject({ status: 'done', booking: { status: 'no_show' } });
  });

  it('close a callback request', () => {
    const h = harness();
    const recorded = h.engine.requestCallback(guest('g1'), { reason: 'large_group', summary: 'Groupe de 12' });
    if (recorded.status !== 'recorded') throw new Error('setup failed');
    expect(h.engine.serviceDay('2026-10-16', 'fr').callbacks).toMatchObject({ open: 1, largeGroups: 1 });
    expect(h.engine.completeCallback(recorded.id)).toEqual({ status: 'done' });
    expect(h.engine.serviceDay('2026-10-16', 'fr').callbacks).toMatchObject({ open: 0, largeGroups: 0, list: [] });
    expect(h.engine.completeCallback('nope')).toEqual({ status: 'not_found' });
  });
});

describe('the service of the day', () => {
  it('counts covers, tables in use and arrivals with the same rules as the booking engine', () => {
    const h = harness(FRIDAY_EVENING);
    h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true, allergies: ['nuts'] }); // 20:07
    h.engine.staffBook({ date: '2026-10-16', time: '21:00', partySize: 4, guestName: 'Durand' });
    const cancelled = h.engine.staffBook({ date: '2026-10-16', time: '21:30', partySize: 2, guestName: 'Petit' });
    if (cancelled.status === 'booked') h.engine.staffCancel(cancelled.booking.reference);
    h.engine.findTable(guest('g9', '+33612345699'), { date: FRIDAY, time: '21:30', partySize: 6 });

    const day = h.engine.serviceDay('2026-10-16', 'fr');
    expect(day).toMatchObject({ readBack: 'vendredi 16 octobre', open: true });
    expect(day.totals).toEqual({ bookings: 2, covers: 6, withAllergies: 1, walkIns: 1, cancelled: 1, noShows: 0 });
    expect(day.sittings.map((sitting) => [sitting.service, sitting.bookings, sitting.covers])).toEqual([
      ['lunch', 0, 0],
      ['dinner', 2, 6],
    ]);

    const slot = (time: string) => day.slots.find((candidate) => candidate.time === time);
    // The party seated at 20:07 arrives in the 20:00 slot and holds a table for two from 20:07 to 21:37.
    expect(slot('20:00')).toEqual({ time: '20:00', service: 'dinner', arrivals: 2, inUse: { t2: 0, t4: 0, t6: 0 } });
    expect(slot('21:30')).toEqual({ time: '21:30', service: 'dinner', arrivals: 0, inUse: { t2: 1, t4: 1, t6: 1 } });

    // At 21:30 the two of 20:07 are still there, with the four of 21:00; a held table is nobody yet.
    // The room stays busy after the last bookable time, until the four of 21:00 leave at 23:00.
    const room = (time: string) => day.room.find((point) => point.service === 'dinner' && point.time === time)?.covers;
    expect(['19:00', '20:00', '20:15', '21:30', '21:45', '22:45', '23:00'].map(room)).toEqual([0, 0, 2, 6, 4, 4, 0]);
    expect(day.room.at(-1)).toEqual({ service: 'dinner', time: '23:00', covers: 0 });
    // With nobody booked, lunch runs from its first to its last seating, empty.
    const lunch = day.room.filter((point) => point.service === 'lunch');
    expect([lunch[0]?.time, lunch.at(-1)?.time, lunch.every((point) => point.covers === 0)]).toEqual(['12:00', '13:30', true]);

    expect(day.holds).toEqual([{ time: '21:30', partySize: 6, tableGroup: 't6', table: 't6-1', expiresAt: '2026-10-16T18:12:00.000Z' }]);
    expect(day.bookings.map((booking) => [booking.time, booking.status])).toEqual([
      ['20:07', 'confirmed'],
      ['21:00', 'booked'],
      ['21:30', 'cancelled'],
    ]);
    expect(day.bookings[0]).toMatchObject({ endsAt: '21:37', allergies: [{ id: 'nuts', name: 'fruits à coque' }], seats: 2 });
  });

  it('follows the room past midnight on a late night, the clock starting again from 00:00', () => {
    const h = harness(FRIDAY_EVENING);
    h.engine.staffBook({ date: '2026-12-31', time: '23:30', partySize: 2, guestName: 'Réveillon' });
    expect(h.engine.serviceDay('2026-12-31', 'fr').room.slice(-4)).toEqual([
      { service: 'dinner', time: '00:15', covers: 2 },
      { service: 'dinner', time: '00:30', covers: 2 },
      { service: 'dinner', time: '00:45', covers: 2 },
      { service: 'dinner', time: '01:00', covers: 0 },
    ]);
  });

  it('keeps the history of a moved booking for "20 h 30 (avant 20 h)"', () => {
    const h = harness();
    const held = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 2 });
    if (held.status !== 'available') throw new Error('setup failed');
    const booked = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    if (booked.status !== 'booked') throw new Error('setup failed');
    const moved = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:30', partySize: 2, changing: booked.booking.reference });
    if (moved.status !== 'available') throw new Error('setup failed');
    h.engine.change(guest('g1'), { reference: booked.booking.reference, holdId: moved.holdId });

    const [booking] = h.engine.serviceDay('2026-10-16', 'fr').bookings;
    expect(booking?.time).toBe('20:30');
    expect(booking?.history).toEqual([
      {
        at: '2026-10-14T08:00:00.000Z',
        from: { date: '2026-10-16', time: '20:00', partySize: 2, readBack: `vendredi 16 octobre à 20${NBSP}h` },
        channel: 'whatsapp',
      },
    ]);
  });

  it('describes a closed day with its reason', () => {
    const h = harness();
    expect(h.engine.serviceDay('2026-12-25', 'en')).toMatchObject({ open: false, note: 'Closed for Christmas', slots: [], sittings: [] });
    expect(() => h.engine.serviceDay('25/12/2026', 'en')).toThrow(RangeError);
  });
});
