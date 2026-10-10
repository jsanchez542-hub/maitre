import { daysBetween, toMinutes, type FloorTableView, type LocalMoment, type ServiceDay, type StaffBookingView } from 'maitre';
import type { StageLabel } from '../i18n/messages';

export type Sitting = ServiceDay['sittings'][number];
export type Hold = ServiceDay['holds'][number];
export type TableState = 'free' | 'expected' | 'arrived' | 'seated';

export interface TableNow {
  table: FloorTableView;
  state: TableState;
  /** The party holding the table now: due, at the door or seated. None when the table is free. */
  booking: StaffBookingView | undefined;
  /** The next party due at the table: after that one leaves, or from now when it is free. */
  next: StaffBookingView | undefined;
  /** A guest still booking this table online, before the next party. */
  hold: Hold | undefined;
  waiter: string | undefined;
}

const LIVE_STAGES: readonly StaffBookingView['stage'][] = ['expected', 'arrived', 'seated'];

/** Still expected, waiting at the door or at the table: not cancelled, not gone. */
export const isLive = (booking: StaffBookingView): boolean => LIVE_STAGES.includes(booking.stage);

/**
 * A moment on the service day's own clock, in minutes from its midnight. Past
 * midnight the evening goes on at 1440 and up: a party seated at 23:30 is still
 * at its table at 00:30, and 18:00 is before dinner, not after it.
 */
export function minuteOn(day: ServiceDay, moment: LocalMoment): number {
  return daysBetween(day.date, moment.date) * 1440 + toMinutes(moment.time);
}

/** A stay that runs past midnight ends on the next day's clock. */
function stayOf(booking: StaffBookingView): [start: number, end: number] {
  const start = toMinutes(booking.time);
  const end = toMinutes(booking.endsAt);
  return [start, end <= start ? end + 1440 : end];
}

/** The service the dashboard opens on: the first whose last seating is still to come, or the day's last. */
export function serviceAt(day: ServiceDay, minute: number): Sitting | undefined {
  return day.sittings.find((sitting) => toMinutes(sitting.lastBooking) >= minute) ?? day.sittings[day.sittings.length - 1];
}

/** The day's bookings in one service. Bookings carry the service's name in the day's language, as the sittings do. */
export function bookingsIn(day: ServiceDay, sitting: Sitting): StaffBookingView[] {
  return day.bookings.filter((booking) => booking.service === sitting.name);
}

export function stageOf(booking: StaffBookingView): StageLabel {
  if (booking.stage !== 'expected') return booking.stage;
  return booking.status === 'confirmed' ? 'confirmed' : 'booked';
}

/** How much of its planned stay a party has used at this moment, from 0 to 1. */
export function stayUsed(booking: StaffBookingView, minute: number): number {
  const [start, end] = stayOf(booking);
  return Math.min(1, Math.max(0, (minute - start) / (end - start)));
}

/** Minutes past the booked time for a party that has not arrived yet, or 0. */
export function minutesLate(booking: StaffBookingView, minute: number): number {
  if (booking.stage !== 'expected') return 0;
  return Math.max(0, minute - toMinutes(booking.time));
}

/**
 * Each table of the plan at one moment. A table is taken at time t by a live
 * booking of its own with time <= t < endsAt: the rule the engine gave for
 * drawing the plan, so the screen never decides on its own who sits where. A
 * table booked later is free until then, and the engine says whether a party
 * on the spot fits before it.
 */
export function tablesAt(day: ServiceDay, sitting: Sitting, minute: number): TableNow[] {
  const live = bookingsIn(day, sitting).filter(isLive);
  const waiters = new Map<string, string>();
  for (const section of day.sections) {
    if (section.service !== sitting.service) continue;
    for (const table of section.tables) waiters.set(table, section.waiterName);
  }
  return day.floor.map((table): TableNow => {
    const waiter = waiters.get(table.number);
    const mine = live.filter((booking) => booking.table === table.number);
    const present = mine.find((booking) => {
      const [start, end] = stayOf(booking);
      // A party already at the door or at its table holds it from then on, even ahead of its time.
      return (start <= minute || booking.stage !== 'expected') && minute < end;
    });
    const from = present ? stayOf(present)[1] : minute;
    const next = mine.find((booking) => booking !== present && toMinutes(booking.time) >= from);
    const hold = day.holds.find(
      (candidate) => candidate.table === table.number && toMinutes(candidate.time) >= from && (!next || toMinutes(candidate.time) < toMinutes(next.time)),
    );
    const state: TableState = !present ? 'free' : present.stage === 'expected' ? 'expected' : present.stage === 'arrived' ? 'arrived' : 'seated';
    return { table, state, booking: present, next, hold, waiter };
  });
}

export function tableLabel(entry: TableNow): StageLabel {
  return entry.booking ? stageOf(entry.booking) : 'free';
}

export interface CurvePoint {
  time: string;
  covers: number;
  /** On the service day's clock: 00:30 after 23:45 is 1470. */
  minute: number;
}

/** Covers planned in the room through one service, as the engine counts them, until its last table leaves. */
export function coversCurve(day: ServiceDay, sitting: Sitting): CurvePoint[] {
  return onOneClock(day.room.filter((point) => point.service === sitting.service));
}

/** The engine's series starts again from 00:00 past midnight; on the curve, each point comes after the one before. */
export function onOneClock(points: readonly { time: string; covers: number }[]): CurvePoint[] {
  const curve: CurvePoint[] = [];
  for (const { time, covers } of points) {
    const previous = curve[curve.length - 1];
    const minute = toMinutes(time);
    curve.push({ time, covers, minute: previous && minute < previous.minute ? minute + 1440 : minute });
  }
  return curve;
}

export function seatCount(day: ServiceDay): number {
  return day.tables.reduce((sum, group) => sum + group.seats * group.count, 0);
}

/**
 * The public demo never shows a whole phone number, even a made-up one:
 * "+33 6 00 00 12 34" becomes "+33 6 •• •• •• 34".
 */
export function maskedPhone(phone: string): string {
  const groups = phone.split(' ');
  if (groups.length < 4) return phone;
  return groups.map((group, index) => (index < 2 || index === groups.length - 1 ? group : '•'.repeat(group.length))).join(' ');
}
