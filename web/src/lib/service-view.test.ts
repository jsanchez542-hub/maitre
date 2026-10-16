import { localNow } from 'maitre';
import { DEMO_EVENING_DATE, DEMO_RESTAURANT, demoEvening } from 'maitre/demo';
import { describe, expect, it } from 'vitest';
import {
  bookingsIn,
  coversCurve,
  groupsOf,
  laterAt,
  matchesName,
  minuteOn,
  minutesLate,
  onOneClock,
  seatCount,
  serviceAt,
  stageOf,
  stayUsed,
  tablesAt,
  telHref,
} from './service-view';

function evening() {
  const { engine, clock } = demoEvening();
  const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
  const dinner = day.sittings.find((sitting) => sitting.service === 'dinner');
  if (!dinner) throw new Error('The demo evening has no dinner');
  const moment = localNow(clock.now(), DEMO_RESTAURANT.timeZone);
  return { day, dinner, time: moment.time, minute: minuteOn(day, moment) };
}

function booking(name: string) {
  const { day } = evening();
  const found = day.bookings.find((candidate) => candidate.guestName === name);
  if (!found) throw new Error(`No booking for ${name} in the demo evening`);
  return found;
}

describe('the plan at 20:05 on the demo evening', () => {
  it('shows each party where the engine put it', () => {
    const { day, dinner, time, minute } = evening();
    const tables = tablesAt(day, dinner, minute);
    const at = (name: string) => tables.find((entry) => entry.booking?.guestName === name);

    expect(time).toBe('20:05');
    expect(at('Martin')?.state).toBe('seated');
    expect(at('Moreau')?.state).toBe('arrived');
    expect(at('Petit')?.state).toBe('expected');
    expect(tables).toHaveLength(day.floor.length);
  });

  it('leaves a table free until the party booked at it is due, and names that party', () => {
    const { day, dinner, minute } = evening();
    const bernard = tablesAt(day, dinner, minute).find((entry) => entry.next?.guestName === 'Bernard');
    expect(bernard?.state).toBe('free');
    expect(bernard?.booking).toBeUndefined();
    expect(bernard?.next?.time).toBe('20:15');
  });

  it('gives the table to a party that arrives ahead of its time', () => {
    const { engine, clock } = demoEvening();
    const before = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    const bernard = before.bookings.find((entry) => entry.guestName === 'Bernard');
    engine.markArrived(bernard?.reference ?? '', 'fr');
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    const dinner = day.sittings.find((sitting) => sitting.service === 'dinner');
    if (!dinner) throw new Error('The demo evening has no dinner');
    const table = tablesAt(day, dinner, minuteOn(day, localNow(clock.now(), DEMO_RESTAURANT.timeZone))).find((entry) => entry.table.number === bernard?.table);
    expect(table?.state).toBe('arrived');
    expect(table?.booking?.guestName).toBe('Bernard');
  });

  it('names the waiter of each table at dinner', () => {
    const { day, dinner, minute } = evening();
    const first = tablesAt(day, dinner, minute).find((entry) => entry.table.number === '1');
    expect(first?.waiter).toBe('Léa');
  });

  it('keeps lunch and dinner apart', () => {
    const { day, dinner } = evening();
    const names = bookingsIn(day, dinner).map((entry) => entry.guestName);
    expect(names).toContain('Bonnet');
    expect(names).not.toContain('Laurent');
  });

  it('lists who comes to a table after the party sitting there', () => {
    const { day, dinner, minute } = evening();
    const martin = tablesAt(day, dinner, minute).find((entry) => entry.booking?.guestName === 'Martin');
    expect(martin?.next?.guestName).toBe('Girard');
  });

  it('keeps a table held for dinner off the lunch plan', () => {
    const { day, minute } = evening();
    const lunch = day.sittings.find((sitting) => sitting.service === 'lunch');
    if (!lunch) throw new Error('The demo evening has no lunch');
    expect(tablesAt(day, lunch, minute).filter((entry) => entry.hold !== undefined)).toEqual([]);
  });

  it('shows a guest still booking online at the table the engine keeps for them', () => {
    const { day, dinner, minute } = evening();
    const held = tablesAt(day, dinner, minute).find((entry) => entry.hold !== undefined);
    expect(held?.table.number).toBe(day.holds[0]?.table);
    expect(held?.state).toBe('seated');
    expect(held?.hold?.time).toBe('21:15');
  });
});

describe('a table before dinner', () => {
  // Friday at 17:30 in Bordeaux: nobody is in yet, and table 1 has Martin at 19:00, then Girard at 21:00.
  function beforeDinner() {
    const now = new Date('2026-10-16T15:30:00.000Z');
    const { engine } = demoEvening({ now });
    const day = engine.serviceDay(DEMO_EVENING_DATE, 'fr');
    const dinner = day.sittings.find((sitting) => sitting.service === 'dinner');
    if (!dinner) throw new Error('The demo evening has no dinner');
    const minute = minuteOn(day, localNow(now, DEMO_RESTAURANT.timeZone));
    return { bookings: bookingsIn(day, dinner), tables: tablesAt(day, dinner, minute) };
  }

  it('lists the parties due after the next one, which the plan does not show yet', () => {
    const { bookings, tables } = beforeDinner();
    const table = tables.find((entry) => entry.next?.guestName === 'Martin');
    expect(table?.state).toBe('free');
    expect(table && laterAt(bookings, table).map((party) => `${party.time} ${party.guestName}`)).toEqual(['21:00 Girard']);
  });

  it('lists nobody after a table with no party still to come', () => {
    const { bookings, tables } = beforeDinner();
    for (const entry of tables.filter((candidate) => candidate.next === undefined)) expect(laterAt(bookings, entry)).toEqual([]);
  });
});

describe('past midnight', () => {
  it('counts the night on from 1440, and the evening before from the date', () => {
    const { day } = evening();
    expect(minuteOn(day, { date: '2026-10-16', time: '18:00' })).toBe(1080);
    expect(minuteOn(day, { date: '2026-10-17', time: '00:30' })).toBe(1470);
  });

  it('keeps a party booked at 23:30 at its table at 00:30', () => {
    const { day, dinner } = evening();
    const late = { ...day, bookings: day.bookings.map((entry) => (entry.guestName === 'Lambert' ? { ...entry, time: '23:30', endsAt: '01:00' } : entry)) };
    const lambert = tablesAt(late, dinner, 1470).find((entry) => entry.booking?.guestName === 'Lambert');
    expect(lambert?.state).toBe('expected');
    expect(stayUsed({ ...booking('Lambert'), time: '23:30', endsAt: '01:00' }, 1470)).toBeCloseTo(2 / 3);
  });

  it('draws the covers on one clock when the room empties after midnight', () => {
    const curve = onOneClock([
      { time: '22:00', covers: 10 },
      { time: '23:45', covers: 20 },
      { time: '00:30', covers: 6 },
      { time: '01:15', covers: 0 },
    ]);
    expect(curve.map((point) => point.minute)).toEqual([1320, 1425, 1470, 1515]);
  });
});

describe('the service the dashboard opens on', () => {
  it('is the one under way, or the next one between services', () => {
    const { day } = evening();
    expect(serviceAt(day, 12 * 60 + 30)?.service).toBe('lunch');
    expect(serviceAt(day, 16 * 60)?.service).toBe('dinner');
    expect(serviceAt(day, 20 * 60 + 5)?.service).toBe('dinner');
  });

  it('stays on the last service once the last table is seated', () => {
    const { day } = evening();
    expect(serviceAt(day, 23 * 60 + 30)?.service).toBe('dinner');
    expect(serviceAt(day, 1440 + 30)?.service).toBe('dinner');
  });
});

describe('the list of a service', () => {
  it('groups the evening as the host reads it, the party at the door first', () => {
    const { day, dinner } = evening();
    const groups = groupsOf(bookingsIn(day, dinner));
    const names = (id: string) => groups.find((group) => group.id === id)?.bookings.map((entry) => entry.guestName) ?? [];

    expect(groups.map((group) => group.id)).toEqual(['arrived', 'due', 'seated', 'done']);
    expect(names('arrived')).toEqual(['Moreau']);
    expect(names('due')[0]).toBe('Petit');
    expect(names('seated')).toContain('Martin');
    expect(names('done')).toEqual(['Bonnet']);
  });

  it('counts the covers of each group', () => {
    const { day, dinner } = evening();
    const arrived = groupsOf(bookingsIn(day, dinner)).find((group) => group.id === 'arrived');
    expect(arrived?.covers).toBe(4);
  });

  it('leaves out a group with no one in it', () => {
    expect(groupsOf([])).toEqual([]);
  });
});

describe('searching a guest', () => {
  it('finds a name whatever the case and the accents', () => {
    expect(matchesName('Lefèvre', 'lefevre')).toBe(true);
    expect(matchesName('Lefèvre', ' LEF ')).toBe(true);
    expect(matchesName('Moreau', 'martin')).toBe(false);
  });
});

describe('a booking as the staff read it', () => {
  it('says late only for a party that has not arrived', () => {
    const { minute } = evening();
    expect(minutesLate(booking('Petit'), minute)).toBe(5);
    expect(minutesLate(booking('Moreau'), minute)).toBe(0);
  });

  it('stops counting once the table is no longer kept for the party', () => {
    expect(minutesLate(booking('Petit'), 1440 + 20 * 60)).toBe(0);
  });

  it('tells a confirmed booking from one still to confirm', () => {
    expect(stageOf(booking('Petit'))).toBe('confirmed');
    expect(stageOf(booking('Bernard'))).toBe('booked');
    expect(stageOf(booking('Bonnet'))).toBe('cancelled');
  });
});

describe('the evening as numbers', () => {
  it('draws covers in the room from the engine until the last table leaves', () => {
    const { day, dinner } = evening();
    const curve = coversCurve(day, dinner);
    expect(curve[0]?.time).toBe(dinner.firstBooking);
    expect(Math.max(...curve.map((point) => point.covers))).toBe(32);
    expect(curve[curve.length - 1]).toMatchObject({ time: '23:00', covers: 0 });
  });

  it('counts every seat of the restaurant', () => {
    const { day } = evening();
    expect(seatCount(day)).toBe(44);
  });
});

describe('phone numbers', () => {
  it('dials the number as the engine writes it, without its spaces', () => {
    expect(telHref('+33 6 39 98 00 22')).toBe('tel:+33639980022');
    expect(telHref('+447700900101')).toBe('tel:+447700900101');
  });
});
