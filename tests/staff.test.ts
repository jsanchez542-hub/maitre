import { describe, expect, it } from 'vitest';
import { BookingEngine } from '../src/engine.js';
import { FRIDAY, TEST_CONFIG, guest, harness, sequentialIds } from './fixtures.js';

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

  it('is turned away between services, with no other time offered to a party already at the door', () => {
    // 14:35 in Paris: after the last lunch arrival, before dinner.
    const h = harness('2026-10-16T12:35:00Z');
    expect(h.engine.staffBook({ date: '2026-10-16', partySize: 2, walkIn: true })).toEqual({
      status: 'unavailable',
      reason: 'outside_hours',
      alternatives: [],
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

  it('keep the guest’s own language for what is said to them later, and answer in the dashboard’s', () => {
    const h = harness();
    const result = h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Clarke', language: 'fr', guestLanguage: 'en' });
    expect(result).toMatchObject({ status: 'booked', booking: { language: 'en', readBack: expect.stringContaining('vendredi 16 octobre') } });
    expect(h.store.snapshot().bookings[0]?.language).toBe('en');
  });

  it('keep the no-break spaces of a note, as French writes them inside « » and before : ; ! ?', () => {
    const h = harness();
    const note = `Anniversaire ! Gâteau « surprise »,  pas de bougie`;
    h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin', notes: note });
    expect(h.store.snapshot().bookings[0]?.notes).toBe(`Anniversaire ! Gâteau « surprise », pas de bougie`);
  });

  it('refuse a time already gone today, and offer only times still to come', () => {
    const h = harness(FRIDAY_EVENING);
    const result = h.engine.staffBook({ date: '2026-10-16', time: '19:30', partySize: 2, guestName: 'Martin' });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'too_soon' });
    // 19:00 and 19:15 are free but gone at 20:07: the nearest offers are 20:15 tonight and Saturday at 19:30.
    expect(result.status === 'unavailable' && result.alternatives.map((offer) => `${offer.date} ${offer.time}`)).toEqual([
      '2026-10-16 20:15',
      '2026-10-17 19:30',
    ]);
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

describe('changes made by the staff', () => {
  function staffBooks(h: ReturnType<typeof harness>, request: Parameters<BookingEngine['staffBook']>[0]): string {
    const result = h.engine.staffBook(request);
    if (result.status !== 'booked') throw new Error(`setup failed: ${JSON.stringify(result)}`);
    return result.booking.reference;
  }

  function guestBooks(h: ReturnType<typeof harness>): string {
    const held = h.engine.findTable(guest('g1'), { date: FRIDAY, time: '20:00', partySize: 2 });
    if (held.status !== 'available') throw new Error('setup failed');
    const booked = h.engine.book(guest('g1'), { holdId: held.holdId, guestName: 'Dupont' });
    if (booked.status !== 'booked') throw new Error('setup failed');
    return booked.booking.reference;
  }

  it('change the guest’s details alone, at the same table, and keep a number typed again as it came', () => {
    const h = harness();
    const reference = guestBooks(h);
    const result = h.engine.staffChange(reference, {
      guestName: 'Dupont-Moreau',
      phone: '+33 6 12 34 56 78',
      notes: 'Près de la fenêtre',
      allergies: ['gluten', 'nuts', 'gluten'],
      guestLanguage: 'en',
    });
    expect(result).toMatchObject({
      status: 'booked',
      booking: {
        guestName: 'Dupont-Moreau',
        phone: '+33 6 12 34 56 78',
        phoneSource: 'whatsapp',
        notes: 'Près de la fenêtre',
        allergies: [{ id: 'gluten' }, { id: 'nuts' }],
        language: 'en',
        channel: 'whatsapp',
        table: 't2-1',
        status: 'booked',
        history: [],
      },
    });

    // An empty note removes it, an empty list clears the allergies, and another number is the staff's.
    const cleared = h.engine.staffChange(reference, { notes: '', allergies: [] });
    expect(cleared.status === 'booked' && cleared.booking).not.toHaveProperty('notes');
    expect(cleared).toMatchObject({ booking: { allergies: [] } });
    expect(h.engine.staffChange(reference, { phone: '07 00 00 00 01' })).toMatchObject({ booking: { phone: '+33 7 00 00 00 01', phoneSource: 'staff' } });
    const withoutPhone = h.engine.staffChange(reference, { phone: '' });
    expect(withoutPhone.status === 'booked' && withoutPhone.booking).not.toHaveProperty('phone');
    expect(h.store.snapshot().bookings[0]).not.toHaveProperty('phoneSource');
  });

  it('move a booking without the notice period, keep its status, and write where it was', () => {
    const h = harness(FRIDAY_EVENING);
    const reference = staffBooks(h, { date: '2026-10-16', time: '20:30', partySize: 2, guestName: 'Martin' });
    h.engine.staffConfirm(reference);
    // 20:20 is thirteen minutes away and off the quarter-hour grid: too soon for a guest, fine for the staff.
    expect(h.engine.staffChange(reference, { time: '20:20' })).toMatchObject({
      status: 'booked',
      booking: {
        time: '20:20',
        status: 'confirmed',
        history: [{ at: '2026-10-16T18:07:00.000Z', from: { date: '2026-10-16', time: '20:30', partySize: 2 }, channel: 'staff' }],
      },
    });
    // The same change asked twice moves the booking once.
    h.engine.staffChange(reference, { time: '20:20' });
    expect(h.store.snapshot().bookings[0]?.history).toHaveLength(1);
  });

  it('do not move a booking to a time already gone, and offer only times still to come', () => {
    const h = harness(FRIDAY_EVENING);
    const reference = staffBooks(h, { date: '2026-10-16', time: '21:00', partySize: 2, guestName: 'Martin' });
    const result = h.engine.staffChange(reference, { time: '19:30' });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'too_soon' });
    expect(result.status === 'unavailable' && result.alternatives.map((offer) => `${offer.date} ${offer.time}`)).toEqual([
      '2026-10-16 20:15',
      '2026-10-17 19:30',
    ]);
    expect(h.store.snapshot().bookings[0]).toMatchObject({ time: '21:00', history: [] });
  });

  it('keep the table the staff gave the party when it still fits, and let the plan find another when it does not', () => {
    const h = harness();
    // Two people the staff put at a table for four: the plan alone would give them a table for two.
    const reference = staffBooks(h, { date: '2026-10-16', time: '21:00', partySize: 2, guestName: 'Martin', table: 't4-1' });
    expect(h.engine.staffChange(reference, { time: '21:15' })).toMatchObject({
      status: 'booked',
      booking: { time: '21:15', table: 't4-1', tableFixed: true },
    });

    staffBooks(h, { date: '2026-10-16', time: '19:00', partySize: 4, guestName: 'Durand', table: 't4-1' });
    // At 20:00 Durand still has that table, until 21:00.
    expect(h.engine.staffChange(reference, { time: '20:00' })).toMatchObject({
      status: 'booked',
      booking: { time: '20:00', tableGroup: 't2', table: 't2-1', tableFixed: false },
    });
  });

  it('give a party that grows a table that seats it, for the longer stay, and write its old size', () => {
    const h = harness();
    const reference = staffBooks(h, { date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin' });
    expect(h.engine.staffChange(reference, { partySize: 4 })).toMatchObject({
      status: 'booked',
      booking: {
        partySize: 4,
        tableGroup: 't4',
        table: 't4-1',
        stayMinutes: 120,
        endsAt: '22:00',
        history: [{ from: { date: '2026-10-16', time: '20:00', partySize: 2 }, channel: 'staff' }],
      },
    });
  });

  it('need the same capacity as a new booking, without the booking being in its own way', () => {
    const h = harness();
    // The only table for six moves with its party.
    const six = staffBooks(h, { date: '2026-10-16', time: '20:00', partySize: 6, guestName: 'Martin' });
    expect(h.engine.staffChange(six, { time: '20:30' })).toMatchObject({ status: 'booked', booking: { time: '20:30', table: 't6-1' } });

    // Six from 19:00 would stay until 21:30, and the table for six is taken from 20:30: nothing that evening fits.
    const four = staffBooks(h, { date: '2026-10-16', time: '19:00', partySize: 4, guestName: 'Durand' });
    const result = h.engine.staffChange(four, { partySize: 6 });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'full' });
    expect(result.status === 'unavailable' && result.alternatives.map((offer) => `${offer.date} ${offer.time}`)).toEqual(['2026-10-17 19:00']);
    expect(h.store.snapshot().bookings.find((booking) => booking.reference === four)).toMatchObject({ partySize: 4, history: [] });
  });

  it('put the party at the table the staff choose, or say which tables would take it', () => {
    const h = harness();
    const martin = staffBooks(h, { date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin' });
    staffBooks(h, { date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Petit', table: 't4-1' });
    // Its own table is among them: at another time or size it is a choice like the others.
    expect(h.engine.staffChange(martin, { table: 't4-1' })).toEqual({ status: 'table_taken', free: ['t2-1', 't2-2', 't4-2', 't6-1'] });
    expect(h.engine.staffChange(martin, { time: '20:15', table: 't4-2' })).toMatchObject({
      status: 'booked',
      booking: { time: '20:15', table: 't4-2', tableFixed: true },
    });
    expect(h.engine.staffChange(martin, { table: 't9-9' })).toEqual({ status: 'invalid', problems: ['there is no table "t9-9"'] });
    expect(h.engine.staffChange(martin, { partySize: 6, table: 't4-2' })).toEqual({ status: 'invalid', problems: ['table t4-2 seats 4, not 6'] });
  });

  it('let a party already in the restaurant grow or shrink at a table that seats it, but not move to another time', () => {
    const h = harness(FRIDAY_EVENING);
    const reference = staffBooks(h, { date: '2026-10-16', partySize: 2, walkIn: true });
    expect(h.engine.staffChange(reference, { time: '20:30' })).toEqual({ status: 'not_allowed', reason: 'already_arrived' });
    // Three no longer fit at the table for two they sit at: the staff say where they go.
    expect(h.engine.staffChange(reference, { partySize: 3 })).toEqual({ status: 'table_taken', free: ['t4-1', 't4-2', 't6-1'] });
    expect(h.engine.staffChange(reference, { partySize: 3, table: 't4-1' })).toMatchObject({
      status: 'booked',
      booking: { partySize: 3, table: 't4-1', tableFixed: true, stage: 'seated' },
    });
    expect(h.engine.staffChange(reference, { partySize: 1 })).toMatchObject({ status: 'booked', booking: { partySize: 1, table: 't4-1' } });
    // A party on the spot may be named, then nameless again.
    expect(h.engine.staffChange(reference, { guestName: 'Garnier' })).toMatchObject({ booking: { guestName: 'Garnier' } });
    expect(h.engine.staffChange(reference, { guestName: '' })).toMatchObject({ booking: { guestName: 'Client sur place' } });
  });

  it('refuse what cannot be read, a booking that is over, and one that is not there', () => {
    const h = harness();
    const reference = staffBooks(h, { date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin' });
    expect(
      h.engine.staffChange(reference, { date: '2026-10-13', time: '8h', partySize: 9, guestName: ' ', phone: '0612', allergies: ['plutonium'] }),
    ).toEqual({
      status: 'invalid',
      problems: [
        'date is in the past',
        'time must be written HH:mm',
        'parties larger than 6 need tables joined, which bookings do not handle',
        'guestName must be 1 to 80 characters of plain text',
        'phone cannot be read: write it like 06 12 34 56 78 or +44 7700 900123',
        'unknown allergen "plutonium"',
      ],
    });
    expect(h.engine.staffChange('AAAAAA', { time: '21:00' })).toEqual({ status: 'not_found' });
    h.engine.staffCancel(reference);
    expect(h.engine.staffChange(reference, { time: '21:00' })).toEqual({ status: 'not_allowed', reason: 'already_cancelled' });
  });
});

describe('opening hours changed after bookings were made', () => {
  it('flag the bookings still to come that the new hours leave out, until the staff move or cancel them', () => {
    const h = harness();
    const book = (date: string, time: string, guestName: string): string => {
      const result = h.engine.staffBook({ date, time, partySize: 2, guestName });
      if (result.status !== 'booked') throw new Error('setup failed');
      return result.booking.reference;
    };
    const late = book('2026-10-16', '21:15', 'Martin');
    book('2026-10-16', '19:30', 'Durand');
    const saturday = book('2026-10-17', '20:00', 'Petit');
    h.engine.staffCancel(book('2026-10-17', '19:30', 'Roux'));
    const lunch = book('2026-10-14', '12:00', 'Leroy');

    // The owner closes today and Saturday, and stops Friday's dinner bookings at 21:00.
    let now = new Date('2026-10-14T08:00:00Z');
    const engine = new BookingEngine(
      {
        ...TEST_CONFIG,
        exceptions: [
          ...TEST_CONFIG.exceptions,
          { date: '2026-10-14', sittings: [] },
          { date: '2026-10-16', sittings: [{ service: 'dinner', firstSeating: '19:00', lastSeating: '21:00' }] },
          { date: '2026-10-17', sittings: [] },
        ],
      },
      h.store,
      { now: () => now, ids: sequentialIds() },
    );
    expect(engine.bookingsOutsideHours().map((booking) => [booking.reference, booking.time, booking.outsideHours])).toEqual([
      [lunch, '12:00', true],
      [late, '21:15', true],
      [saturday, '20:00', true],
    ]);
    const friday = engine.serviceDay('2026-10-16', 'fr');
    expect(friday.bookings.map((booking) => [booking.guestName, booking.outsideHours ?? false])).toEqual([
      ['Durand', false],
      ['Martin', true],
    ]);
    // Martin is still expected for dinner, so the dinner's counts include him.
    expect(friday.sittings.map((sitting) => [sitting.service, sitting.bookings, sitting.covers])).toEqual([['dinner', 2, 4]]);

    // At 12:30 today's lunch has begun, too late to warn anyone; the others are moved or cancelled.
    now = new Date('2026-10-14T10:30:00Z');
    engine.staffChange(late, { time: '20:45' });
    engine.staffCancel(saturday);
    expect(engine.bookingsOutsideHours()).toEqual([]);
  });
});

describe('staff actions', () => {
  function booked(h: ReturnType<typeof harness>) {
    const result = h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Martin' });
    if (result.status !== 'booked') throw new Error('setup failed');
    return result.booking.reference;
  }

  it('confirm a booking the guest confirmed to them, as often as they press it', () => {
    const h = harness();
    const reference = booked(h);
    expect(h.engine.staffConfirm(reference)).toMatchObject({ status: 'done', booking: { status: 'confirmed' } });
    expect(h.engine.staffConfirm(reference)).toMatchObject({ status: 'done', booking: { status: 'confirmed' } });
    h.engine.staffCancel(reference);
    expect(h.engine.staffConfirm(reference)).toEqual({ status: 'not_allowed', reason: 'already_cancelled' });
    expect(h.engine.staffConfirm('AAAAAA')).toEqual({ status: 'not_found' });
  });

  it('say which other tables would take a booking for its whole stay, without trying one', () => {
    const h = harness();
    const reference = booked(h);
    h.engine.staffBook({ date: '2026-10-16', time: '20:00', partySize: 2, guestName: 'Petit', table: 't4-1' });
    expect(h.engine.freeTablesFor(reference)).toEqual({ status: 'ok', free: ['t2-2', 't4-2', 't6-1'] });
    h.engine.staffCancel(reference);
    expect(h.engine.freeTablesFor(reference)).toEqual({ status: 'not_allowed', reason: 'already_cancelled' });
    expect(h.engine.freeTablesFor('AAAAAA')).toEqual({ status: 'not_found' });
  });

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

    // A held table says which service it falls in, as the slots do, so the dashboard need not work it out from the time.
    expect(day.holds).toEqual([{ time: '21:30', service: 'dinner', partySize: 6, tableGroup: 't6', table: 't6-1', expiresAt: '2026-10-16T18:12:00.000Z' }]);
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
