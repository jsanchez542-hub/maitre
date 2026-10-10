import { describe, expect, it } from 'vitest';
import { validateConfig, type BusinessConfig } from '../src/config.js';
import type { BookingEngine, Session, StaffBookingView } from '../src/engine.js';
import { TEST_CONFIG, guest, harness } from './fixtures.js';

const FLOOR_CONFIG: BusinessConfig = {
  ...TEST_CONFIG,
  floor: {
    zones: [{ id: 'terrace', name: { fr: 'Terrasse', en: 'Terrace', es: 'Terraza' } }],
    tables: [
      { number: '1', group: 't2', shape: 'round', x: 10, y: 20 },
      { number: '2', group: 't2', shape: 'round', x: 10, y: 60, zone: 'terrace' },
      { number: '3', group: 't4', shape: 'square', x: 40, y: 20 },
      { number: '4', group: 't4', shape: 'square', x: 40, y: 60 },
      { number: '5', group: 't6', shape: 'square', x: 80, y: 40 },
    ],
  },
  waiters: [
    { id: 'lea', name: 'Léa', tables: ['1', '2'] },
    { id: 'hugo', name: 'Hugo', tables: ['3', '4', '5'], services: ['dinner'] },
  ],
};

const TODAY = '2026-10-14';
const FRIDAY = '2026-10-16';

function guestBooks(engine: BookingEngine, session: Session, date: string, time: string, partySize: number): string {
  const found = engine.findTable(session, { date: { kind: 'date', date }, time, partySize });
  if (found.status !== 'available') throw new Error(`no table: ${found.status}`);
  const booked = engine.book(session, { holdId: found.holdId, guestName: `Guest ${session.id}` });
  if (booked.status !== 'booked') throw new Error(`not booked: ${booked.status}`);
  return booked.booking.reference;
}

function staffBooks(engine: BookingEngine, request: Parameters<BookingEngine['staffBook']>[0]): StaffBookingView {
  const result = engine.staffBook(request);
  if (result.status !== 'booked') throw new Error(`staff could not book: ${JSON.stringify(result)}`);
  return result.booking;
}

function tableOf(engine: BookingEngine, date: string, reference: string): string | undefined {
  return engine.serviceDay(date, 'fr').bookings.find((booking) => booking.reference === reference)?.table;
}

describe('the floor plan', () => {
  it('gives every booking the lowest-numbered free table of its size, and shows the plan to the staff', () => {
    const h = harness('2026-10-14T08:00:00Z', FLOOR_CONFIG);
    const first = guestBooks(h.engine, guest('g1', '+33611111111'), FRIDAY, '20:00', 2);
    const second = guestBooks(h.engine, guest('g2', '+33622222222'), FRIDAY, '20:00', 2);
    const day = h.engine.serviceDay(FRIDAY, 'fr');
    expect(day.bookings.map((booking) => [booking.reference, booking.table, booking.stage, booking.tableFixed])).toEqual([
      [first, '1', 'expected', false],
      [second, '2', 'expected', false],
    ]);
    expect(day.floor[1]).toEqual({ number: '2', group: 't2', seats: 2, shape: 'round', x: 10, y: 60, zone: 'terrace' });
    expect(day.zones).toEqual([{ id: 'terrace', name: 'Terrasse' }]);
    expect(day.sections).toEqual([
      { service: 'lunch', waiter: 'lea', waiterName: 'Léa', tables: ['1', '2'] },
      { service: 'dinner', waiter: 'lea', waiterName: 'Léa', tables: ['1', '2'] },
      { service: 'dinner', waiter: 'hugo', waiterName: 'Hugo', tables: ['3', '4', '5'] },
    ]);
  });

  it('numbers the tables itself for a restaurant without a plan', () => {
    const h = harness();
    const reference = guestBooks(h.engine, guest('g1'), FRIDAY, '20:00', 4);
    expect(tableOf(h.engine, FRIDAY, reference)).toBe('t4-1');
    expect(h.engine.serviceDay(FRIDAY, 'fr').floor.map((table) => table.number)).toEqual(['t2-1', 't2-2', 't4-1', 't4-2', 't6-1']);
  });

  it('lets the staff move a booking to another table, moving whoever was planned there, and keeps it there', () => {
    const h = harness('2026-10-14T08:00:00Z', FLOOR_CONFIG);
    const first = guestBooks(h.engine, guest('g1', '+33611111111'), FRIDAY, '20:00', 2);
    const second = guestBooks(h.engine, guest('g2', '+33622222222'), FRIDAY, '20:00', 2);
    expect(h.engine.moveTable(first, '2')).toMatchObject({ status: 'done', booking: { table: '2', tableFixed: true } });
    expect(tableOf(h.engine, FRIDAY, second)).toBe('1');

    // A table held by a fixed booking is refused, with the tables that would do.
    expect(h.engine.moveTable(second, '2')).toEqual({ status: 'table_taken', free: ['3', '4', '5'] });
    expect(h.engine.moveTable(second, '99')).toEqual({ status: 'unknown_table' });
    // A larger table moves the booking to that size, and its capacity with it.
    expect(h.engine.moveTable(second, '4')).toMatchObject({ status: 'done', booking: { table: '4', tableGroup: 't4', seats: 4 } });
  });

  it('refuses a booking that capacity would allow when tables fixed by hand leave no table free for all of it', () => {
    const h = harness('2026-10-14T08:00:00Z', FLOOR_CONFIG);
    // Table 1 is fixed until 20:30, table 2 from 20:45: a party of one from 20:00 to 21:30 fits on neither.
    const early = staffBooks(h.engine, { date: FRIDAY, time: '19:00', partySize: 2, guestName: 'Tôt' });
    expect(h.engine.moveTable(early.reference, '1')).toMatchObject({ status: 'done' });
    staffBooks(h.engine, { date: FRIDAY, time: '20:45', partySize: 2, guestName: 'Tard', table: '2' });

    expect(h.engine.staffBook({ date: FRIDAY, time: '20:00', partySize: 1, guestName: 'Seul' })).toMatchObject({ status: 'unavailable', reason: 'full' });
    expect(h.engine.findTable(guest('g3', '+33633333333'), { date: { kind: 'date', date: FRIDAY }, time: '20:00', partySize: 1 })).toMatchObject({
      status: 'unavailable',
    });
    // Not fixed, the later booking would simply have moved.
    const loose = harness('2026-10-14T08:00:00Z', FLOOR_CONFIG);
    staffBooks(loose.engine, { date: FRIDAY, time: '19:00', partySize: 2, guestName: 'Tôt' });
    staffBooks(loose.engine, { date: FRIDAY, time: '20:45', partySize: 2, guestName: 'Tard' });
    expect(loose.engine.staffBook({ date: FRIDAY, time: '20:00', partySize: 1, guestName: 'Seul' })).toMatchObject({ status: 'booked' });
  });
});

describe('the evening', () => {
  it('follows a party from the door to its table and out, and frees the table the moment it leaves', () => {
    const h = harness('2026-10-14T16:30:00Z', FLOOR_CONFIG);
    const a = staffBooks(h.engine, { date: TODAY, time: '19:00', partySize: 2, guestName: 'Arnaud', phone: '06 12 34 56 78' });
    staffBooks(h.engine, { date: TODAY, time: '19:00', partySize: 2, guestName: 'Blanc' });
    // A party of one only fits a table for two, and both are taken until 20:30.
    expect(h.engine.staffBook({ date: TODAY, time: '20:00', partySize: 1, guestName: 'Seul' })).toMatchObject({ status: 'unavailable', reason: 'full' });

    expect(h.engine.markArrived(a.reference)).toMatchObject({ status: 'done', booking: { stage: 'arrived' } });
    expect(h.engine.markNoShow(a.reference)).toEqual({ status: 'not_allowed', reason: 'already_arrived' });
    // Arrived early, the party can no longer cancel from the phone.
    expect(h.engine.cancel(guest('g1'), { reference: a.reference })).toMatchObject({ status: 'already_started' });
    expect(h.engine.markLeft(a.reference)).toEqual({ status: 'not_allowed', reason: 'not_seated' });

    h.setNow('2026-10-14T17:00:00Z');
    expect(h.engine.seat(a.reference)).toMatchObject({ status: 'done', booking: { stage: 'seated', table: '1', tableFixed: true } });
    h.setNow('2026-10-14T17:45:00Z');
    expect(h.engine.markLeft(a.reference)).toMatchObject({ status: 'done', booking: { stage: 'left', endsAt: '19:45' } });
    expect(h.engine.markLeft(a.reference)).toMatchObject({ status: 'done' });
    expect(h.engine.seat(a.reference)).toEqual({ status: 'not_allowed', reason: 'already_left' });

    const alone = staffBooks(h.engine, { date: TODAY, time: '20:00', partySize: 1, guestName: 'Seul' });
    expect(alone.table).toBe('1');
  });

  it('seats a party on the spot at once, at the table the staff choose', () => {
    const h = harness('2026-10-14T17:30:00Z', FLOOR_CONFIG);
    const walkIn = staffBooks(h.engine, { date: TODAY, partySize: 2, walkIn: true, table: '3' });
    expect(walkIn).toMatchObject({ table: '3', tableGroup: 't4', tableFixed: true, stage: 'seated', time: '19:30' });
    expect(h.engine.staffBook({ date: TODAY, partySize: 5, walkIn: true, table: '1' })).toMatchObject({ status: 'invalid' });
  });

  it('only on the evening itself', () => {
    const h = harness('2026-10-14T08:00:00Z', FLOOR_CONFIG);
    const later = staffBooks(h.engine, { date: FRIDAY, time: '20:00', partySize: 2, guestName: 'Plus tard' });
    expect(h.engine.markArrived(later.reference)).toEqual({ status: 'not_allowed', reason: 'not_today' });
    expect(h.engine.seat(later.reference)).toEqual({ status: 'not_allowed', reason: 'not_today' });
  });
});

describe('a floor plan in the configuration', () => {
  it('is checked against the table groups, and the waiters against the plan', () => {
    const floor = FLOOR_CONFIG.floor as NonNullable<BusinessConfig['floor']>;
    const broken: BusinessConfig = {
      ...FLOOR_CONFIG,
      floor: {
        ...floor,
        tables: [
          ...floor.tables.slice(0, 4),
          { number: '1', group: 't6', shape: 'round', x: 120, y: 40, zone: 'garden' },
        ],
      },
      waiters: [
        { id: 'lea', name: 'Léa', tables: ['1', '9'] },
        { id: 'hugo', name: 'Hugo', tables: ['1'] },
      ],
    };
    expect(validateConfig(broken)).toEqual([
      'table number "1" is used twice',
      'table 1: x must be a number from 0 to 100',
      'table 1: unknown zone "garden"',
      'waiter "lea": unknown table "9"',
      'table 1 is in the sections of both "lea" and "hugo" at lunch',
      'table 1 is in the sections of both "lea" and "hugo" at dinner',
    ]);
    expect(validateConfig({ ...FLOOR_CONFIG, floor: { tables: floor.tables.slice(1) } })).toContain(
      'table group "t2" counts 2 tables but the plan has 1',
    );
    const odd = floor.tables.map((table) =>
      table.number === '5' ? { ...table, shape: 'oval' as unknown as 'rect', rotation: 45 as unknown as 90 } : table,
    );
    expect(validateConfig({ ...FLOOR_CONFIG, floor: { ...floor, tables: odd } })).toEqual([
      'table 5: shape must be round, square or rect',
      'table 5: rotation must be 0 or 90',
    ]);
    expect(validateConfig(FLOOR_CONFIG)).toEqual([]);
  });
});
