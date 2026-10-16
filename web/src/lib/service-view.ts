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

export function holdsIn(day: ServiceDay, sitting: Sitting): Hold[] {
  return day.holds.filter((hold) => hold.service === sitting.service);
}

/** The day's bookings in one service. Bookings carry the service's name in the day's language, as the sittings do. */
export function bookingsIn(day: ServiceDay, sitting: Sitting): StaffBookingView[] {
  return day.bookings.filter((booking) => booking.service === sitting.name);
}

/** A name as the host types it: case and accents do not matter, so "lefevre" finds Lefèvre. */
export function matchesName(name: string, query: string): boolean {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return fold(name).includes(fold(query.trim()));
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

/** Minutes past the booked time for a party that has not arrived yet, while its table is still kept for it, or 0. */
export function minutesLate(booking: StaffBookingView, minute: number): number {
  if (booking.stage !== 'expected') return 0;
  const [start, end] = stayOf(booking);
  return minute >= start && minute < end ? minute - start : 0;
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
  const holds = holdsIn(day, sitting);
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
    const hold = holds.find(
      (candidate) => candidate.table === table.number && toMinutes(candidate.time) >= from && (!next || toMinutes(candidate.time) < toMinutes(next.time)),
    );
    const state: TableState = !present ? 'free' : present.stage === 'expected' ? 'expected' : present.stage === 'arrived' ? 'arrived' : 'seated';
    return { table, state, booking: present, next, hold, waiter };
  });
}

/**
 * The parties due at a table after its next one: the rest of the table's
 * service. The plan shows the table now, so without them a booking later in the
 * evening, opened from the list, would not be on its own table's card.
 */
export function laterAt(bookings: readonly StaffBookingView[], entry: TableNow): StaffBookingView[] {
  const { next } = entry;
  if (!next) return [];
  return bookings.filter(
    (booking) => booking.stage === 'expected' && booking.table === entry.table.number && booking !== next && toMinutes(booking.time) > toMinutes(next.time),
  );
}

export type GroupId = 'arrived' | 'due' | 'seated' | 'done';

export interface BookingGroup {
  id: GroupId;
  bookings: StaffBookingView[];
  covers: number;
}

const GROUP_OF: Record<StaffBookingView['stage'], GroupId> = {
  arrived: 'arrived',
  expected: 'due',
  seated: 'seated',
  left: 'done',
  cancelled: 'done',
  no_show: 'done',
};
const GROUP_ORDER: readonly GroupId[] = ['arrived', 'due', 'seated', 'done'];

/** A service's bookings as the host reads them: at the door, still to come, at their table, and gone. Empty groups are left out. */
export function groupsOf(bookings: readonly StaffBookingView[]): BookingGroup[] {
  return GROUP_ORDER.map((id) => {
    const members = bookings.filter((booking) => GROUP_OF[booking.stage] === id);
    return { id, bookings: members, covers: members.reduce((sum, booking) => sum + booking.partySize, 0) };
  }).filter((group) => group.bookings.length > 0);
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

/** The number as the engine writes it, "+33 6 39 98 00 22", as a link that dials it. */
export function telHref(phone: string): string {
  return `tel:${phone.replaceAll(' ', '')}`;
}
