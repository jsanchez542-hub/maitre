import { localNow } from 'maitre';
import { DEMO_EVENING_DATE, DEMO_RESTAURANT, demoEvening } from 'maitre/demo';
import { describe, expect, it } from 'vitest';
import { bookingsIn, coversCurve, maskedPhone, minuteOn, minutesLate, onOneClock, seatCount, serviceAt, stageOf, stayUsed, tablesAt } from './service-view';

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

  it('shows a guest still booking online at the table the engine keeps for them', () => {
    const { day, dinner, minute } = evening();
    const held = tablesAt(day, dinner, minute).find((entry) => entry.hold !== undefined);
    expect(held?.table.number).toBe(day.holds[0]?.table);
    expect(held?.state).toBe('seated');
    expect(held?.hold?.time).toBe('21:15');
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

describe('a booking as the staff read it', () => {
  it('says late only for a party that has not arrived', () => {
    const { minute } = evening();
    expect(minutesLate(booking('Petit'), minute)).toBe(5);
    expect(minutesLate(booking('Moreau'), minute)).toBe(0);
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

describe('phone numbers on the public demo', () => {
  it('hides every group but the first two and the last', () => {
    expect(maskedPhone('+33 6 00 00 12 34')).toBe('+33 6 •• •• •• 34');
  });

  it('leaves a number it cannot read as groups untouched', () => {
    expect(maskedPhone('+3360000')).toBe('+3360000');
  });
});
