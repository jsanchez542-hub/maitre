import { isAllergen, type Allergen } from './allergens.js';
import { peakUse, stayMinutes, suitableGroups, type Occupation } from './availability.js';
import {
  addDays,
  compareDates,
  daysBetween,
  fromMinutes,
  isPlainDate,
  isPlainTime,
  localNow,
  toMinutes,
  type PlainDate,
  type PlainTime,
} from './calendar.js';
import { assertValidConfig, type BusinessConfig, type Sitting, type TableGroup, type TableShape } from './config.js';
import { resolveDate, type DateSpec } from './dates.js';
import { formatBooking, formatDate, formatDateAtTime, formatTime, localize, messages, type Language } from './i18n/index.js';
import { isReference, type IdSource } from './ids.js';
import { formatPhone, isE164, normalizePhone } from './phone.js';
import { isOnGrid, isOpenOn, sittingAt, sittingsOn, slotsOf, slotsOn } from './schedule.js';
import { physicalTables, planGroup, type PhysicalTable, type Stay } from './seating.js';
import {
  isActive,
  type Booking,
  type BookingStatus,
  type BookingStore,
  type BookingTx,
  type CallbackRequest,
  type Channel,
  type HandoffReason,
  type Hold,
  type PhoneSource,
} from './store.js';

/** A phone number the channel vouches for. The language model never supplies one. */
export interface TrustedPhone {
  e164: string;
  source: PhoneSource;
}

/** One conversation with one guest. */
export interface Session {
  id: string;
  channel: Channel;
  language: Language;
  phone?: TrustedPhone;
}

export interface EngineDeps {
  now(): Date;
  ids: IdSource;
}

export type UnavailableReason = 'closed' | 'outside_hours' | 'not_a_slot' | 'too_soon' | 'too_far_ahead' | 'full';
export type InvalidReason = 'invalid_date' | 'in_the_past' | 'invalid_time' | 'invalid_party_size';

/** A date and time with the words a guest should hear for it. */
export interface SlotOffer {
  date: PlainDate;
  time: PlainTime;
  readBack: string;
}

export interface FindTableRequest {
  date: DateSpec;
  time: string;
  partySize: number;
  /** The reference of a booking being moved: its own table does not count as taken. */
  changing?: string;
}

export type FindTableResult =
  | {
      status: 'available';
      holdId: string;
      /** How long the table stays set aside for the guest. */
      heldForMinutes: number;
      date: PlainDate;
      time: PlainTime;
      partySize: number;
      service: string;
      readBack: string;
    }
  | {
      status: 'unavailable';
      reason: UnavailableReason;
      requested: SlotOffer;
      /** Times that were free when the answer was given. They are not set aside. */
      alternatives: SlotOffer[];
      /** Only when the date is too far ahead: the last day that can be booked. */
      lastBookableDay?: { date: PlainDate; readBack: string };
    }
  | { status: 'needs_staff'; reason: 'party_too_large'; maxPartySize: number }
  | { status: 'invalid'; reason: InvalidReason };

/** What the guest and the assistant may see of a booking: no phone number, no internal ids. */
export interface BookingView {
  reference: string;
  date: PlainDate;
  time: PlainTime;
  partySize: number;
  guestName: string;
  status: BookingStatus;
  notes?: string;
  allergies: Allergen[];
  readBack: string;
}

export interface BookRequest {
  holdId: string;
  guestName: string;
  notes?: string;
  allergies?: readonly string[];
}

export type BookResult =
  | { status: 'booked'; booking: BookingView }
  | { status: 'duplicate'; booking: BookingView }
  | { status: 'hold_expired' }
  | { status: 'phone_required' }
  | { status: 'invalid'; problems: string[] };

export type CancelResult =
  | { status: 'cancelled'; booking: BookingView }
  | { status: 'already_cancelled'; booking: BookingView }
  | { status: 'already_started'; booking: BookingView }
  | { status: 'not_found' }
  | { status: 'phone_required' };

export type ChangeResult =
  /** `previous` is missing when the same change is asked for twice: the first answer already said it. */
  | { status: 'changed'; booking: BookingView; previous?: SlotOffer & { partySize: number } }
  | { status: 'already_started'; booking: BookingView }
  | { status: 'hold_expired' }
  | { status: 'not_found' }
  | { status: 'phone_required' };

export type MyBookingsResult = { status: 'ok'; bookings: BookingView[] } | { status: 'phone_required' };

export type ConfirmResult =
  | { status: 'confirmed'; booking: BookingView }
  | { status: 'not_found' }
  | { status: 'phone_required' };

export const HANDOFF_REASONS: readonly HandoffReason[] = [
  'large_group',
  'allergy_question',
  'special_request',
  'complaint',
  'other',
];

export type CallbackResult =
  /** `needsPhone`: the team has the request but no number to call back on yet. */
  | { status: 'recorded'; id: string; needsPhone?: true }
  | { status: 'invalid'; problems: string[] };

export interface DayHours {
  date: PlainDate;
  readBack: string;
  open: boolean;
  sittings: { service: string; firstBooking: string; lastBooking: string }[];
  note?: string;
}

/** Where a party is in its evening, for the list and the plan. */
export type ArrivalStage = 'expected' | 'arrived' | 'seated' | 'left' | 'cancelled' | 'no_show';

/** A booking as the staff see it in the dashboard: everything, the phone number included. */
export interface StaffBookingView {
  reference: string;
  date: PlainDate;
  time: PlainTime;
  /**
   * When the table is free again, on the 24-hour clock: the time the party left,
   * if it has, and not before now while a party past its time is still at it.
   */
  endsAt: PlainTime;
  /** When the stay was planned to end: a party still at its table after it has stayed past its time. */
  plannedEndsAt: PlainTime;
  partySize: number;
  stayMinutes: number;
  tableGroup: string;
  seats: number;
  /** The table on the plan, for every booking still to come or under way. */
  table?: string;
  /** Seated, or placed by the staff: the plan will not move it. */
  tableFixed: boolean;
  stage: ArrivalStage;
  arrivedAt?: string;
  seatedAt?: string;
  leftAt?: string;
  service: string;
  guestName: string;
  status: BookingStatus;
  /** Grouped for reading: +33 6 12 34 56 78. */
  phone?: string;
  phoneSource?: PhoneSource;
  channel: Channel;
  language: Language;
  notes?: string;
  allergies: { id: Allergen; name: string }[];
  walkIn: boolean;
  /** Still to come, on a day the restaurant now closes or at a time outside its services: the staff tell the guest. */
  outsideHours?: true;
  /** Oldest first: where the booking was before each move. */
  history: { at: string; from: SlotOffer & { partySize: number }; channel: Channel }[];
  createdAt: string;
  readBack: string;
}

export interface CallbackView {
  id: string;
  createdAt: string;
  channel: Channel;
  language: Language;
  phone?: string;
  reason: HandoffReason;
  summary: string;
  status: 'open' | 'done';
}

/**
 * Everything the dashboard shows for one day, computed by the same code that
 * decides whether a table is free, so the screen and the assistant never disagree.
 */
export interface ServiceDay {
  date: PlainDate;
  readBack: string;
  open: boolean;
  note?: string;
  tables: { id: string; seats: number; count: number }[];
  /** Every real table, with its place on the plan when the restaurant drew one. */
  floor: FloorTableView[];
  zones: { id: string; name: string }[];
  /** Who looks after which tables, for each service of the day. */
  sections: { service: string; waiter: string; waiterName: string; tables: string[] }[];
  sittings: { service: string; name: string; firstBooking: PlainTime; lastBooking: PlainTime; bookings: number; covers: number }[];
  /** Every bookable time of the day: covers arriving in that slot and tables of each size in use at that moment. */
  slots: { time: PlainTime; service: string; arrivals: number; inUse: Record<string, number> }[];
  /**
   * Covers planned to be in the room through each service, on the slot grid,
   * from the first seating until the last table is due to leave: the evening
   * goes on after the last bookable time. In order; past midnight the clock
   * starts again from 00:00.
   */
  room: { service: string; time: PlainTime; covers: number }[];
  /** In order of arrival, cancelled ones included. */
  bookings: StaffBookingView[];
  /** Tables set aside while a guest finishes booking, at the table the plan would give them. */
  holds: { time: PlainTime; service: string; partySize: number; tableGroup: string; table?: string; expiresAt: string }[];
  totals: { bookings: number; covers: number; withAllergies: number; walkIns: number; cancelled: number; noShows: number };
  /** Open requests to call back, whatever their day. */
  callbacks: { open: number; largeGroups: number; list: CallbackView[] };
}

export interface StaffBookRequest {
  date: PlainDate;
  /** Defaults to now for a party on the spot. */
  time?: PlainTime;
  partySize: number;
  guestName?: string;
  phone?: string;
  notes?: string;
  allergies?: readonly string[];
  /** A party already in the restaurant ("sur place"): seated at once. */
  walkIn?: boolean;
  /** A table the staff choose, by its number. Otherwise the plan gives one. */
  table?: string;
  /** The dashboard's language: the booking it returns and the times it offers are written in it. */
  language?: Language;
  /** The guest's own language, for what is said to them later. The dashboard's when not given. */
  guestLanguage?: Language;
}

export interface FloorTableView {
  number: string;
  group: string;
  seats: number;
  shape?: TableShape;
  rotation?: 0 | 90;
  x?: number;
  y?: number;
  zone?: string;
}

/** The tables that would take the party instead, by number. */
export type TableTaken = { status: 'table_taken'; free: string[] };

export type StaffBookResult =
  | { status: 'booked'; booking: StaffBookingView }
  /** With the nearest times the staff could book instead, by the staff's own rules. */
  | { status: 'unavailable'; reason: UnavailableReason; alternatives: SlotOffer[] }
  | TableTaken
  | { status: 'invalid'; problems: string[] };

/**
 * What the staff change on a booking. A field left out stays as it is; an
 * empty phone or note removes it, and an empty list of allergies clears them.
 */
export interface StaffChangeRequest {
  date?: PlainDate;
  time?: PlainTime;
  partySize?: number;
  guestName?: string;
  phone?: string;
  notes?: string;
  allergies?: readonly string[];
  /** A table the staff choose, by its number: the booking is fixed there. Left out, the party keeps its table when it still fits. */
  table?: string;
  /** The dashboard's language: the booking it returns and the times it offers are written in it. */
  language?: Language;
  /** The guest's own language, for what is said to them later. */
  guestLanguage?: Language;
}

/** Answered like a booking made by the staff, or refused for a booking that cannot change any more. */
export type StaffChangeResult = StaffBookResult | { status: 'not_found' } | { status: 'not_allowed'; reason: StaffRefusal };

export type FreeTablesResult =
  | { status: 'ok'; free: string[] }
  | { status: 'not_found' }
  | { status: 'not_allowed'; reason: StaffRefusal };

export type StaffRefusal =
  | 'already_cancelled'
  | 'not_active'
  | 'not_started'
  | 'not_today'
  | 'in_the_past'
  | 'already_arrived'
  | 'not_seated'
  | 'already_left';

export type StaffActionResult =
  | { status: 'done'; booking: StaffBookingView }
  | { status: 'not_found' }
  | { status: 'not_allowed'; reason: StaffRefusal };

export type TableActionResult = StaffActionResult | TableTaken | { status: 'unknown_table' };

interface Clock {
  today: PlainDate;
  nowMinutes: number;
  nowMs: number;
}

interface Exclusions {
  sessionId: string;
  bookingId?: string;
}

/** What one request reads more than once: the stays around a day, and those of one table group. */
interface PlanCache {
  occupations: Map<PlainDate, Occupation[]>;
  stays: Map<string, Stay[]>;
}

function newCache(): PlanCache {
  return { occupations: new Map(), stays: new Map() };
}

type Check =
  | { ok: true; group: TableGroup; sitting: Sitting }
  | { ok: false; reason: UnavailableReason };

const NAME_MAX = 80;
const NOTES_MAX = 500;
const SUMMARY_MAX = 500;
const ALTERNATIVE_DAYS = 14;
const HISTORY_LENGTH = 20;
/** How long past its time a party still at its table keeps it, at most: after that, the staff forgot to see it off. */
const LONGEST_OVERSTAY_MINUTES = 120;

/** A booking without its table, to be placed again. */
function unseated(booking: Booking): Booking {
  const copy: Booking = { ...booking };
  delete copy.table;
  delete copy.tableFixed;
  return copy;
}

/**
 * Collapses whitespace and refuses control characters, empty text and anything
 * too long. The no-break spaces stay: French puts a narrow one inside « » and
 * before : ; ! ?, and without it a guillemet wraps alone onto the next line.
 */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length > max * 4) return undefined;
  const collapsed = value.replace(/[^\S  ]+/g, ' ').trim();
  if (collapsed === '' || collapsed.length > max) return undefined;
  for (const char of collapsed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return undefined;
  }
  return collapsed;
}

/** A guest's name as the staff type it: a party on the spot may stay nameless, and every view then calls it a walk-in. */
function staffName(value: string, walkIn: boolean, problems: string[]): string | undefined {
  const name = value.trim() ? cleanText(value, NAME_MAX) : '';
  if (name === undefined || (name === '' && !walkIn)) {
    problems.push(`guestName must be 1 to ${NAME_MAX} characters of plain text`);
    return undefined;
  }
  return name;
}

/** A number as the staff type it, in E.164; empty when the field was left empty. */
function staffPhone(value: string, problems: string[]): string | undefined {
  if (value.trim() === '') return '';
  const phone = normalizePhone(value);
  if (!phone) problems.push('phone cannot be read: write it like 06 12 34 56 78 or +44 7700 900123');
  return phone;
}

/** A note as the staff type it; empty when the field was left empty. */
function staffNotes(value: string, problems: string[]): string | undefined {
  if (value.trim() === '') return '';
  const notes = cleanText(value, NOTES_MAX);
  if (!notes) problems.push(`notes must be at most ${NOTES_MAX} characters of plain text`);
  return notes;
}

function staffAllergies(values: readonly string[], problems: string[]): Allergen[] {
  const allergies: Allergen[] = [];
  for (const allergen of values) {
    if (!isAllergen(allergen)) problems.push(`unknown allergen "${String(allergen).slice(0, 40)}"`);
    else if (!allergies.includes(allergen)) allergies.push(allergen);
  }
  return allergies;
}

/** "k7q f3m" and "K7Q-F3M" both mean K7QF3M. Anything else is not a reference. */
export function normalizeReference(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 20) return undefined;
  let compact = '';
  for (const char of value.toUpperCase()) if (char !== ' ' && char !== '-') compact += char;
  return isReference(compact) ? compact : undefined;
}

function overlaps(a: { time: PlainTime; stayMinutes: number }, b: { time: PlainTime; stayMinutes: number }): boolean {
  const aStart = toMinutes(a.time);
  const bStart = toMinutes(b.time);
  return aStart < bStart + b.stayMinutes && bStart < aStart + a.stayMinutes;
}

/**
 * The booking rules of one business. Every operation runs in a single store
 * transaction, so what it checks and what it writes cannot be separated by
 * another guest's request.
 */
export class BookingEngine {
  readonly #config: BusinessConfig;
  readonly #store: BookingStore;
  readonly #deps: EngineDeps;

  constructor(config: BusinessConfig, store: BookingStore, deps: EngineDeps) {
    assertValidConfig(config);
    this.#config = config;
    this.#store = store;
    this.#deps = deps;
  }

  get config(): BusinessConfig {
    return this.#config;
  }

  /** Today's date and the current time in the business's own time zone. */
  today(): { date: PlainDate; time: PlainTime } {
    return localNow(this.#deps.now(), this.#config.timeZone);
  }

  /** The engine's clock, so the assistant's prompt and the bookings agree on what "now" is. */
  now(): Date {
    return this.#deps.now();
  }

  /**
   * Looks for a table and, if there is one, sets it aside for this guest.
   * A guest is never told a table is free unless it is held for them, so what
   * they hear stays true while they give their name.
   */
  findTable(session: Session, request: FindTableRequest): FindTableResult {
    const { partySize } = request;
    if (!Number.isInteger(partySize) || partySize < 1) return { status: 'invalid', reason: 'invalid_party_size' };
    if (partySize > this.#config.maxPartySize) {
      return { status: 'needs_staff', reason: 'party_too_large', maxPartySize: this.#config.maxPartySize };
    }
    const clock = this.#clock();
    const resolved = resolveDate(request.date, clock.today);
    if (!resolved.ok) return { status: 'invalid', reason: resolved.error };
    if (typeof request.time !== 'string' || !isPlainTime(request.time)) return { status: 'invalid', reason: 'invalid_time' };
    const { date } = resolved;
    const time = request.time;

    return this.#store.transaction((tx) => {
      tx.deleteExpiredHolds(clock.nowMs);
      const exclusions: Exclusions = { sessionId: session.id };
      const changing = normalizeReference(request.changing);
      if (changing && session.phone) {
        const booking = tx.bookingByReference(changing);
        if (booking && booking.phone === session.phone.e164) exclusions.bookingId = booking.id;
      }

      const check = this.#check(tx, date, time, partySize, clock, exclusions, newCache());
      if (!check.ok) {
        const requested = this.#offer(date, time, session.language, clock);
        if (check.reason === 'too_far_ahead') {
          const last = addDays(clock.today, this.#config.maxAdvanceDays);
          return {
            status: 'unavailable',
            reason: check.reason,
            requested,
            alternatives: [],
            lastBookableDay: { date: last, readBack: formatDate(last, session.language, clock.today) },
          };
        }
        return {
          status: 'unavailable',
          reason: check.reason,
          requested,
          alternatives: this.#alternatives(tx, date, time, partySize, session.language, clock, exclusions),
        };
      }

      // One table per guest at a time: taking a new one lets go of the previous.
      for (const previous of tx.holdsOfSession(session.id)) tx.deleteHold(previous.id);
      const hold: Hold = {
        id: this.#deps.ids.id(),
        sessionId: session.id,
        date,
        time,
        partySize,
        stayMinutes: stayMinutes(this.#config, partySize),
        tableGroup: check.group.id,
        service: check.sitting.service,
        expiresAt: clock.nowMs + this.#config.holdMinutes * 60_000,
      };
      tx.saveHold(hold);
      return {
        status: 'available',
        holdId: hold.id,
        heldForMinutes: this.#config.holdMinutes,
        date,
        time,
        partySize,
        service: this.#serviceName(check.sitting.service, session.language),
        readBack: formatBooking(partySize, date, time, session.language, clock.today),
      };
    });
  }

  /** Turns a held table into a booking. Asking twice with the same hold books once. */
  book(session: Session, request: BookRequest): BookResult {
    const problems: string[] = [];
    const guestName = cleanText(request.guestName, NAME_MAX);
    if (!guestName) problems.push(`guestName must be 1 to ${NAME_MAX} characters of plain text`);
    let notes: string | undefined;
    const blankNotes = typeof request.notes === 'string' && request.notes.trim() === '';
    if (request.notes !== undefined && !blankNotes) {
      notes = cleanText(request.notes, NOTES_MAX);
      if (!notes) problems.push(`notes must be at most ${NOTES_MAX} characters of plain text`);
    }
    const allergies: Allergen[] = [];
    if (request.allergies !== undefined && !Array.isArray(request.allergies)) {
      problems.push('allergies must be a list');
    } else {
      for (const allergen of request.allergies ?? []) {
        if (!isAllergen(allergen)) problems.push(`unknown allergen "${String(allergen).slice(0, 40)}"`);
        else if (!allergies.includes(allergen)) allergies.push(allergen);
      }
    }
    if (typeof request.holdId !== 'string' || request.holdId === '' || request.holdId.length > 100) {
      problems.push('holdId is missing');
    }
    if (problems.length > 0 || !guestName) return { status: 'invalid', problems };
    const phone = session.phone;
    if (!phone || !isE164(phone.e164)) return { status: 'phone_required' };
    const clock = this.#clock();

    return this.#store.transaction((tx): BookResult => {
      const already = tx.bookingByHold(request.holdId);
      if (already) {
        return already.phone === phone.e164
          ? { status: 'booked', booking: this.#view(already, session.language, clock) }
          : { status: 'hold_expired' };
      }
      const hold = tx.hold(request.holdId);
      if (!hold || hold.sessionId !== session.id || hold.expiresAt <= clock.nowMs) return { status: 'hold_expired' };

      const clash = tx
        .bookingsForPhone(phone.e164, hold.date)
        .find((booking) => isActive(booking) && booking.date === hold.date && overlaps(booking, hold));
      if (clash) return { status: 'duplicate', booking: this.#view(clash, session.language, clock) };

      const stamp = new Date(clock.nowMs).toISOString();
      const booking: Booking = {
        id: this.#deps.ids.id(),
        reference: this.#newReference(tx),
        holdId: hold.id,
        date: hold.date,
        time: hold.time,
        partySize: hold.partySize,
        stayMinutes: hold.stayMinutes,
        tableGroup: hold.tableGroup,
        service: hold.service,
        guestName,
        phone: phone.e164,
        phoneSource: phone.source,
        status: 'booked',
        channel: session.channel,
        language: session.language,
        ...(notes ? { notes } : {}),
        allergies,
        history: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      // Only tables fixed by hand since the hold was taken can stop it here.
      const seated = this.#seatAndSave(tx, booking, { sessionId: session.id }, clock.nowMs);
      if (!seated) return { status: 'hold_expired' };
      tx.deleteHold(hold.id);
      return { status: 'booked', booking: this.#view(seated, session.language, clock) };
    });
  }

  /** Cancels one of the guest's own bookings. Another guest's booking is "not found", never "not yours". */
  cancel(session: Session, request: { reference: string }): CancelResult {
    const phone = session.phone;
    if (!phone) return { status: 'phone_required' };
    const reference = normalizeReference(request.reference);
    if (!reference) return { status: 'not_found' };
    const clock = this.#clock();

    return this.#store.transaction((tx): CancelResult => {
      const booking = tx.bookingByReference(reference);
      if (!booking || booking.phone !== phone.e164) return { status: 'not_found' };
      if (booking.status === 'cancelled') return { status: 'already_cancelled', booking: this.#view(booking, session.language, clock) };
      if (!isActive(booking)) return { status: 'not_found' };
      if (this.#hasStarted(booking, clock)) return { status: 'already_started', booking: this.#view(booking, session.language, clock) };
      const cancelled: Booking = { ...booking, status: 'cancelled', updatedAt: new Date(clock.nowMs).toISOString() };
      tx.saveBooking(cancelled);
      return { status: 'cancelled', booking: this.#view(cancelled, session.language, clock) };
    });
  }

  /**
   * Moves one of the guest's bookings to a table found with `findTable` (passing
   * `changing`). The old table is freed and the new one taken in one step, so the
   * guest never ends up with both or with neither.
   */
  change(session: Session, request: { reference: string; holdId: string }): ChangeResult {
    const phone = session.phone;
    if (!phone) return { status: 'phone_required' };
    const reference = normalizeReference(request.reference);
    if (!reference) return { status: 'not_found' };
    const clock = this.#clock();

    return this.#store.transaction((tx): ChangeResult => {
      const booking = tx.bookingByReference(reference);
      if (!booking || booking.phone !== phone.e164 || !isActive(booking)) return { status: 'not_found' };
      if (booking.holdId === request.holdId) return { status: 'changed', booking: this.#view(booking, session.language, clock) };
      if (this.#hasStarted(booking, clock)) return { status: 'already_started', booking: this.#view(booking, session.language, clock) };
      const hold = tx.hold(request.holdId);
      if (!hold || hold.sessionId !== session.id || hold.expiresAt <= clock.nowMs) return { status: 'hold_expired' };

      const previous = { ...this.#offer(booking.date, booking.time, session.language, clock), partySize: booking.partySize };
      const stamp = new Date(clock.nowMs).toISOString();
      const moved: Booking = {
        // At a new time the party needs a table again, wherever the staff had put it.
        ...unseated(booking),
        holdId: hold.id,
        date: hold.date,
        time: hold.time,
        partySize: hold.partySize,
        stayMinutes: hold.stayMinutes,
        tableGroup: hold.tableGroup,
        service: hold.service,
        // A moved booking is confirmed again, so the reminder goes out for the new time.
        status: 'booked',
        history: [
          ...booking.history,
          { at: stamp, from: { date: booking.date, time: booking.time, partySize: booking.partySize }, channel: session.channel },
        ].slice(-HISTORY_LENGTH),
        updatedAt: stamp,
      };
      const seated = this.#seatAndSave(tx, moved, { sessionId: session.id }, clock.nowMs);
      if (!seated) return { status: 'hold_expired' };
      tx.deleteHold(hold.id);
      return { status: 'changed', booking: this.#view(seated, session.language, clock), previous };
    });
  }

  /** The guest's own bookings still to come, from the number the channel vouches for. */
  myBookings(session: Session): MyBookingsResult {
    const phone = session.phone;
    if (!phone) return { status: 'phone_required' };
    const clock = this.#clock();
    return this.#store.transaction((tx) => ({
      status: 'ok',
      bookings: tx
        .bookingsForPhone(phone.e164, clock.today)
        .filter((booking) => isActive(booking) && !this.#hasStarted(booking, clock))
        .map((booking) => this.#view(booking, session.language, clock)),
    }));
  }

  /** The guest confirms they are coming, usually by answering the WhatsApp reminder. */
  confirm(session: Session, request: { reference?: string } = {}): ConfirmResult {
    const phone = session.phone;
    if (!phone) return { status: 'phone_required' };
    const clock = this.#clock();
    const reference = request.reference === undefined ? undefined : normalizeReference(request.reference);
    if (request.reference !== undefined && !reference) return { status: 'not_found' };

    return this.#store.transaction((tx): ConfirmResult => {
      // Without a reference: the next booking still waiting for confirmation, or,
      // when the guest answers "yes" a second time, the one they already confirmed.
      const upcoming = reference
        ? []
        : tx.bookingsForPhone(phone.e164, clock.today).filter((booking) => isActive(booking) && !this.#hasStarted(booking, clock));
      const target = reference
        ? tx.bookingByReference(reference)
        : (upcoming.find((booking) => booking.status === 'booked') ?? upcoming[0]);
      if (!target || target.phone !== phone.e164 || !isActive(target) || this.#hasStarted(target, clock)) {
        return { status: 'not_found' };
      }
      if (target.status === 'confirmed') return { status: 'confirmed', booking: this.#view(target, session.language, clock) };
      const confirmed: Booking = { ...target, status: 'confirmed', updatedAt: new Date(clock.nowMs).toISOString() };
      tx.saveBooking(confirmed);
      return { status: 'confirmed', booking: this.#view(confirmed, session.language, clock) };
    });
  }

  /**
   * Passes something the assistant cannot handle to the team, who call the
   * guest back. A second request of the same kind in the same conversation is
   * added to the first, so the team calls once about both.
   */
  requestCallback(session: Session, request: { reason: string; summary: string }): CallbackResult {
    const problems: string[] = [];
    const reason = HANDOFF_REASONS.find((candidate) => candidate === request.reason);
    if (!reason) problems.push(`reason must be one of ${HANDOFF_REASONS.join(', ')}`);
    const summary = cleanText(request.summary, SUMMARY_MAX);
    if (!summary) problems.push(`summary must be 1 to ${SUMMARY_MAX} characters of plain text`);
    if (!reason || !summary) return { status: 'invalid', problems };
    const clock = this.#clock();
    const phone = session.phone?.e164;
    const callback = this.#store.transaction((tx): CallbackRequest => {
      const earlier = tx.openCallbacks().find((open) => open.sessionId === session.id && open.reason === reason);
      if (earlier) {
        const joined = `${earlier.summary} ${summary}`;
        const merged: CallbackRequest = {
          ...earlier,
          // When both no longer fit, the first is kept whole: the team hears the rest on the call.
          ...(earlier.summary.includes(summary) || joined.length > SUMMARY_MAX ? {} : { summary: joined }),
          ...(phone && !earlier.phone ? { phone } : {}),
        };
        tx.saveCallback(merged);
        return merged;
      }
      const created: CallbackRequest = {
        id: this.#deps.ids.id(),
        sessionId: session.id,
        channel: session.channel,
        language: session.language,
        ...(phone ? { phone } : {}),
        reason,
        summary,
        status: 'open',
        createdAt: new Date(clock.nowMs).toISOString(),
      };
      tx.saveCallback(created);
      return created;
    });
    return { status: 'recorded', id: callback.id, ...(callback.phone ? {} : { needsPhone: true as const }) };
  }

  /**
   * Gives the guest's number, once the channel has it, to the requests they
   * made before it was known: a web guest types it in the chat's field after
   * the team was already asked to call. Returns how many requests it reached.
   */
  addPhoneToCallbacks(session: Session): number {
    const phone = session.phone?.e164;
    if (!phone || !isE164(phone)) return 0;
    return this.#store.transaction((tx) => {
      let added = 0;
      for (const open of tx.openCallbacks()) {
        if (open.sessionId !== session.id || open.phone) continue;
        tx.saveCallback({ ...open, phone });
        added += 1;
      }
      return added;
    });
  }

  /** Opening hours of one day, or of the next seven when no day is given. Exceptions included. */
  openingHours(language: Language, date?: DateSpec): { status: 'ok'; days: DayHours[] } | { status: 'invalid'; reason: InvalidReason } {
    const clock = this.#clock();
    if (date) {
      const resolved = resolveDate(date, clock.today);
      if (!resolved.ok) return { status: 'invalid', reason: resolved.error };
      return { status: 'ok', days: [this.#dayHours(resolved.date, language, clock)] };
    }
    return {
      status: 'ok',
      days: Array.from({ length: 7 }, (_, offset) => this.#dayHours(addDays(clock.today, offset), language, clock)),
    };
  }

  /** The dashboard's view of one day. */
  serviceDay(date: PlainDate, language: Language): ServiceDay {
    if (!isPlainDate(date)) throw new RangeError(`Not a calendar date: ${date}`);
    const clock = this.#clock();
    return this.#store.transaction((tx) => {
      const occupations = this.#occupations(tx, date, clock.nowMs, { sessionId: '' });
      const all = tx
        .bookingsOn(date)
        .sort((a, b) => toMinutes(a.time) - toMinutes(b.time) || a.createdAt.localeCompare(b.createdAt));
      const active = all.filter(isActive);
      const sittings = sittingsOn(this.#config, date);
      const covers = (bookings: Booking[]): number => bookings.reduce((sum, booking) => sum + booking.partySize, 0);
      const exception = this.#config.exceptions.find((candidate) => candidate.date === date);
      const open = tx.openCallbacks();
      const holds = tx.holdsOn(date, clock.nowMs);
      // Held tables, and bookings saved before tables were planned, get the table the plan
      // would give them, for the view only: nothing is written.
      const unplaced = new Map<string, string>();
      const groupsToPlan = new Set([
        ...active.filter((booking) => booking.table === undefined).map((booking) => booking.tableGroup),
        ...holds.map((hold) => hold.tableGroup),
      ]);
      for (const group of groupsToPlan) {
        const plan = planGroup(this.#stays(tx, date, group, { sessionId: '' }, clock.nowMs), this.#tableNumbers(group));
        for (const [id, table] of plan ?? []) unplaced.set(id, table);
      }
      // Who is in the room at each moment, the late parties of the evening before included.
      const present = [
        ...tx
          .bookingsOn(addDays(date, -1))
          .filter(isActive)
          .map((booking) => ({ booking, shift: -1440 })),
        ...active.map((booking) => ({ booking, shift: 0 })),
      ].map(({ booking, shift }) => ({
        // Only today's parties belong to one of today's services.
        service: shift === 0 ? booking.service : undefined,
        covers: booking.partySize,
        start: toMinutes(booking.time) + shift,
        end: this.#stayEnd(booking, clock.nowMs) + shift,
      }));
      const coversInRoom = (minute: number): number =>
        present.filter((stay) => stay.start <= minute && minute < stay.end).reduce((sum, stay) => sum + stay.covers, 0);
      const step = this.#config.slotMinutes;

      return {
        date,
        readBack: formatDate(date, language, clock.today),
        open: sittings.length > 0,
        ...(exception?.reason ? { note: localize(exception.reason, language) } : {}),
        tables: this.#config.tables.map(({ id, seats, count }) => ({ id, seats, count })),
        floor: this.#floorView(),
        zones: (this.#config.floor?.zones ?? []).map((zone) => ({ id: zone.id, name: localize(zone.name, language) })),
        sections: sittings.flatMap((sitting) =>
          (this.#config.waiters ?? [])
            .filter((waiter) => waiter.services === undefined || waiter.services.includes(sitting.service))
            .map((waiter) => ({ service: sitting.service, waiter: waiter.id, waiterName: waiter.name, tables: [...waiter.tables] })),
        ),
        sittings: sittings.map((sitting) => {
          const first = toMinutes(sitting.firstSeating);
          const last = toMinutes(sitting.lastSeating);
          const inSitting = active.filter((booking) => toMinutes(booking.time) >= first && toMinutes(booking.time) <= last);
          return {
            service: sitting.service,
            name: this.#serviceName(sitting.service, language),
            firstBooking: sitting.firstSeating,
            lastBooking: sitting.lastSeating,
            bookings: inSitting.length,
            covers: covers(inSitting),
          };
        }),
        slots: slotsOn(this.#config, date).map((time) => {
          const minute = toMinutes(time);
          return {
            time,
            service: sittingAt(this.#config, date, time)?.service ?? '',
            // A party seated at 20:07 counts in the 20:00 slot.
            arrivals: covers(active.filter((booking) => toMinutes(booking.time) >= minute && toMinutes(booking.time) < minute + step)),
            inUse: Object.fromEntries(this.#config.tables.map((group) => [group.id, peakUse(occupations, group.id, minute, minute + 1)])),
          };
        }),
        room: sittings.flatMap((sitting) => {
          // The room empties when the service's last table is due to leave, and never before its last seating.
          const empty = Math.max(
            toMinutes(sitting.lastSeating),
            ...present.filter((stay) => stay.service === sitting.service).map((stay) => stay.end),
          );
          const points: { service: string; time: PlainTime; covers: number }[] = [];
          // Up to the first time on the grid with everyone gone, so the series comes back down.
          for (let minute = toMinutes(sitting.firstSeating); minute < empty + step; minute += step) {
            points.push({ service: sitting.service, time: fromMinutes(minute % 1440), covers: coversInRoom(minute) });
          }
          return points;
        }),
        bookings: all.map((booking) => this.#staffView(booking, language, clock, unplaced.get(booking.id))),
        holds: holds.map((hold) => {
          const table = unplaced.get(`hold ${hold.id}`);
          return {
            time: hold.time,
            service: sittingAt(this.#config, date, hold.time)?.service ?? '',
            partySize: hold.partySize,
            tableGroup: hold.tableGroup,
            ...(table === undefined ? {} : { table }),
            expiresAt: new Date(hold.expiresAt).toISOString(),
          };
        }),
        totals: {
          bookings: active.length,
          covers: covers(active),
          withAllergies: active.filter((booking) => booking.allergies.length > 0).length,
          walkIns: active.filter((booking) => booking.walkIn === true).length,
          cancelled: all.filter((booking) => booking.status === 'cancelled').length,
          noShows: all.filter((booking) => booking.status === 'no_show').length,
        },
        callbacks: {
          open: open.length,
          largeGroups: open.filter((callback) => callback.reason === 'large_group').length,
          list: open.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((callback) => this.#callbackView(callback)),
        },
      };
    });
  }

  /**
   * A booking entered by the staff: a phone call taken by hand or a party at
   * the door. No notice period and no phone number required, but the same
   * capacity as everyone else: a party seated without being recorded is a table
   * the assistant would offer to someone else.
   */
  staffBook(request: StaffBookRequest): StaffBookResult {
    const clock = this.#clock();
    const language = request.language ?? this.#config.defaultLanguage;
    const walkIn = request.walkIn === true;
    const problems: string[] = [];

    const date = request.date;
    if (!isPlainDate(date)) problems.push('date must be a calendar date written YYYY-MM-DD');
    else if (compareDates(date, clock.today) < 0) problems.push('date is in the past');
    else if (walkIn && date !== clock.today) problems.push('a party on the spot is booked for today');

    const time = request.time ?? (walkIn ? fromMinutes(clock.nowMinutes) : undefined);
    if (time === undefined || !isPlainTime(time)) problems.push('time must be written HH:mm');

    const { partySize } = request;
    this.#checkPartySize(partySize, problems);
    const guestName = staffName(request.guestName ?? '', walkIn, problems);
    const phone = request.phone === undefined ? undefined : staffPhone(request.phone, problems);
    const notes = request.notes === undefined ? undefined : staffNotes(request.notes, problems);
    const allergies = staffAllergies(request.allergies ?? [], problems);
    const chosen = this.#chosenTable(request.table, partySize, problems);
    if (problems.length > 0 || time === undefined || guestName === undefined) return { status: 'invalid', problems };

    return this.#store.transaction((tx): StaffBookResult => {
      const exclusions: Exclusions = { sessionId: '' };
      const check = this.#check(tx, date, time, partySize, clock, exclusions, newCache(), true, chosen?.group);
      if (!check.ok) {
        if (chosen && check.reason === 'full') return { status: 'table_taken', free: this.#freeTablesAt(tx, date, time, partySize, clock.nowMs) };
        const alternatives =
          check.reason === 'too_far_ahead' ? [] : this.#alternatives(tx, date, time, partySize, language, clock, exclusions, true);
        return { status: 'unavailable', reason: check.reason, alternatives };
      }
      const id = this.#deps.ids.id();
      const stamp = new Date(clock.nowMs).toISOString();
      const booking: Booking = {
        id,
        reference: this.#newReference(tx),
        holdId: `staff-${id}`,
        date,
        time,
        partySize,
        stayMinutes: stayMinutes(this.#config, partySize),
        tableGroup: check.group.id,
        ...(chosen ? { table: chosen.number } : {}),
        // A table chosen by the staff, or a party already sitting down, stays where it is.
        ...(chosen || walkIn ? { tableFixed: true } : {}),
        service: check.sitting.service,
        guestName,
        ...(phone ? { phone, phoneSource: 'staff' as const } : {}),
        // A party standing in the restaurant has nothing left to confirm.
        status: walkIn ? 'confirmed' : 'booked',
        channel: 'staff',
        language: request.guestLanguage ?? language,
        ...(notes ? { notes } : {}),
        allergies,
        ...(walkIn ? { walkIn: true, arrivedAt: stamp, seatedAt: stamp } : {}),
        history: [],
        createdAt: stamp,
        updatedAt: stamp,
      };
      const seated = this.#seatAndSave(tx, booking, exclusions, clock.nowMs);
      if (!seated) return { status: 'table_taken', free: this.#freeTablesAt(tx, date, time, partySize, clock.nowMs) };
      return { status: 'booked', booking: this.#staffView(seated, language, clock) };
    });
  }

  /**
   * The staff change a booking, usually with the guest on the phone: its day,
   * time or size, its table, or the guest's details. A new time or size needs a
   * table as a new booking does, without the notice period, and the party keeps
   * its table when it still fits. A party already in the restaurant can grow or
   * shrink but not move to another time. The status stays as it was: the staff
   * know what they agreed with the guest.
   */
  staffChange(reference: string, request: StaffChangeRequest): StaffChangeResult {
    const normalized = normalizeReference(reference);
    if (!normalized) return { status: 'not_found' };
    const clock = this.#clock();
    const language = request.language ?? this.#config.defaultLanguage;

    return this.#store.transaction((tx): StaffChangeResult => {
      const booking = tx.bookingByReference(normalized);
      if (!booking) return { status: 'not_found' };
      const refusal = this.#movingRefusal(booking, clock);
      if (refusal) return { status: 'not_allowed', reason: refusal };

      const problems: string[] = [];
      const date = request.date ?? booking.date;
      if (date !== booking.date) {
        if (!isPlainDate(date)) problems.push('date must be a calendar date written YYYY-MM-DD');
        else if (compareDates(date, clock.today) < 0) problems.push('date is in the past');
      }
      const time = request.time ?? booking.time;
      if (!isPlainTime(time)) problems.push('time must be written HH:mm');
      const partySize = request.partySize ?? booking.partySize;
      // A size the restaurant no longer takes stays on the bookings it took before.
      if (partySize !== booking.partySize) this.#checkPartySize(partySize, problems);
      const guestName = request.guestName === undefined ? booking.guestName : staffName(request.guestName, booking.walkIn === true, problems);
      const phone = request.phone === undefined ? (booking.phone ?? '') : staffPhone(request.phone, problems);
      const notes = request.notes === undefined ? (booking.notes ?? '') : staffNotes(request.notes, problems);
      const allergies = request.allergies === undefined ? booking.allergies : staffAllergies(request.allergies, problems);
      const chosen = this.#chosenTable(request.table, partySize, problems);
      if (problems.length > 0 || guestName === undefined || phone === undefined || notes === undefined) return { status: 'invalid', problems };

      const moving = date !== booking.date || time !== booking.time;
      const resizing = partySize !== booking.partySize;
      if (moving && booking.arrivedAt) return { status: 'not_allowed', reason: 'already_arrived' };

      const stamp = new Date(clock.nowMs).toISOString();
      const changed: Booking = { ...booking, guestName, allergies, language: request.guestLanguage ?? booking.language, updatedAt: stamp };
      if (phone === '') {
        delete changed.phone;
        delete changed.phoneSource;
      } else if (phone !== booking.phone) {
        // The same number typed again keeps where it came from: a caller ID is worth more than a number read aloud.
        changed.phone = phone;
        changed.phoneSource = 'staff';
      }
      if (notes === '') delete changed.notes;
      else changed.notes = notes;
      if (!moving && !resizing && !chosen) {
        tx.saveBooking(changed);
        return { status: 'booked', booking: this.#staffView(changed, language, clock) };
      }

      const moved: Booking = {
        ...changed,
        date,
        time,
        partySize,
        ...(moving || resizing
          ? {
              stayMinutes: stayMinutes(this.#config, partySize),
              history: [
                ...booking.history,
                { at: stamp, from: { date: booking.date, time: booking.time, partySize: booking.partySize }, channel: 'staff' as const },
              ].slice(-HISTORY_LENGTH),
            }
          : {}),
      };
      const exclusions: Exclusions = { sessionId: '', bookingId: booking.id };
      const cache = newCache();
      const placed = (saved: Booking): StaffChangeResult => ({ status: 'booked', booking: this.#staffView(saved, language, clock) });
      const taken = (): StaffChangeResult => ({ status: 'table_taken', free: this.#freeTablesAt(tx, date, time, partySize, clock.nowMs, unseated(moved)) });
      const unavailable = (reason: UnavailableReason): StaffChangeResult => ({
        status: 'unavailable',
        reason,
        alternatives: reason === 'too_far_ahead' ? [] : this.#alternatives(tx, date, time, partySize, language, clock, exclusions, true),
      });

      // A table the staff chose: there or nowhere.
      if (chosen) {
        const check = this.#check(tx, date, time, partySize, clock, exclusions, cache, true, chosen.group);
        if (!check.ok) return check.reason === 'full' ? taken() : unavailable(check.reason);
        const fixed: Booking = { ...moved, tableGroup: chosen.group, table: chosen.number, tableFixed: true, service: check.sitting.service };
        const saved = this.#seatAndSave(tx, fixed, exclusions, clock.nowMs);
        return saved ? placed(saved) : taken();
      }

      // Its own table first, when the party still fits it: the staff may have put it there on purpose.
      const own = booking.table === undefined ? undefined : this.#physicalTable(booking.table);
      if (own && own.seats >= partySize) {
        const check = this.#check(tx, date, time, partySize, clock, exclusions, cache, true, own.group);
        if (!check.ok && check.reason !== 'full') return unavailable(check.reason);
        if (check.ok) {
          const saved = this.#seatAndSave(tx, { ...moved, tableGroup: own.group, service: check.sitting.service }, exclusions, clock.nowMs);
          if (saved) return placed(saved);
        }
      }
      // A party sitting at its table moves only to a table the staff choose.
      if (booking.seatedAt) return taken();

      const check = this.#check(tx, date, time, partySize, clock, exclusions, cache, true);
      if (!check.ok) return unavailable(check.reason);
      const saved = this.#seatAndSave(tx, { ...unseated(moved), tableGroup: check.group.id, service: check.sitting.service }, exclusions, clock.nowMs);
      return saved ? placed(saved) : taken();
    });
  }

  /** The guest told the staff they are coming: the booking no longer waits for confirmation. */
  staffConfirm(reference: string, language: Language = this.#config.defaultLanguage): StaffActionResult {
    return this.#staffUpdate(reference, language, (booking, clock) => {
      if (booking.status === 'confirmed') return { update: {} };
      const refusal = this.#movingRefusal(booking, clock);
      if (refusal) return { reason: refusal };
      return { update: { status: 'confirmed' } };
    });
  }

  /** The other tables that would take a booking for its whole stay, the rest of the plan still working: where the staff can move it. */
  freeTablesFor(reference: string): FreeTablesResult {
    const normalized = normalizeReference(reference);
    if (!normalized) return { status: 'not_found' };
    const clock = this.#clock();
    return this.#store.transaction((tx): FreeTablesResult => {
      const booking = tx.bookingByReference(normalized);
      if (!booking) return { status: 'not_found' };
      const refusal = this.#movingRefusal(booking, clock);
      if (refusal) return { status: 'not_allowed', reason: refusal };
      return { status: 'ok', free: this.#freeTables(tx, booking, clock.nowMs) };
    });
  }

  /**
   * The bookings still to come that the opening hours no longer cover, in
   * order: a day the restaurant now closes, or a time outside its services.
   * They stay booked, so no guest is dropped without a word: the staff call
   * them, then move or cancel each one.
   */
  bookingsOutsideHours(language: Language = this.#config.defaultLanguage): StaffBookingView[] {
    const clock = this.#clock();
    return this.#store.transaction((tx) =>
      tx
        .bookingsFrom(clock.today)
        .filter((booking) => this.#outsideHours(booking, clock))
        .map((booking) => this.#staffView(booking, language, clock)),
    );
  }

  /** The staff cancel any booking, whoever made it. */
  staffCancel(reference: string, language: Language = this.#config.defaultLanguage): StaffActionResult {
    return this.#staffUpdate(reference, language, (booking) => {
      if (booking.status === 'cancelled') return { reason: 'already_cancelled' };
      if (!isActive(booking)) return { reason: 'not_active' };
      return { update: { status: 'cancelled' } };
    });
  }

  /** A guest who did not come. Only once their time has passed, and never once they arrived. */
  markNoShow(reference: string, language: Language = this.#config.defaultLanguage): StaffActionResult {
    return this.#staffUpdate(reference, language, (booking, clock) => {
      if (!isActive(booking)) return { reason: 'not_active' };
      if (booking.arrivedAt) return { reason: 'already_arrived' };
      if (!this.#hasStarted(booking, clock)) return { reason: 'not_started' };
      return { update: { status: 'no_show' } };
    });
  }

  /** The party is at the door. Saying it twice changes nothing. */
  markArrived(reference: string, language: Language = this.#config.defaultLanguage): StaffActionResult {
    return this.#staffUpdate(reference, language, (booking, clock, stamp) => {
      const refusal = this.#eveningRefusal(booking, clock);
      if (refusal) return { reason: refusal };
      return { update: { arrivedAt: booking.arrivedAt ?? stamp } };
    });
  }

  /** The party has gone: its table is free again from now, for the assistant as for the staff. */
  markLeft(reference: string, language: Language = this.#config.defaultLanguage): StaffActionResult {
    return this.#staffUpdate(reference, language, (booking, clock, stamp) => {
      if (booking.leftAt) return { update: {} };
      const refusal = this.#eveningRefusal(booking, clock);
      if (refusal) return { reason: refusal };
      if (!booking.seatedAt) return { reason: 'not_seated' };
      return { update: { leftAt: stamp } };
    });
  }

  /** The party sits down, at the table the plan gave them or at one the staff choose, and is fixed there. */
  seat(reference: string, table?: string, language: Language = this.#config.defaultLanguage): TableActionResult {
    return this.#placeByStaff(reference, table, language, true);
  }

  /** The staff put a booking at another table, for tonight or a day to come. The plan leaves it there. */
  moveTable(reference: string, table: string, language: Language = this.#config.defaultLanguage): TableActionResult {
    return this.#placeByStaff(reference, table, language, false);
  }

  #placeByStaff(reference: string, tableNumber: string | undefined, language: Language, seating: boolean): TableActionResult {
    const normalized = normalizeReference(reference);
    if (!normalized) return { status: 'not_found' };
    const wanted = tableNumber === undefined ? undefined : this.#physicalTable(tableNumber);
    if (tableNumber !== undefined && !wanted) return { status: 'unknown_table' };
    const clock = this.#clock();
    const stamp = new Date(clock.nowMs).toISOString();
    return this.#store.transaction((tx): TableActionResult => {
      const booking = tx.bookingByReference(normalized);
      if (!booking) return { status: 'not_found' };
      const refusal = seating ? this.#eveningRefusal(booking, clock) : this.#movingRefusal(booking, clock);
      if (refusal) return { status: 'not_allowed', reason: refusal };
      if (wanted && wanted.seats < booking.partySize) return { status: 'table_taken', free: this.#freeTables(tx, booking, clock.nowMs) };
      const placed: Booking = {
        ...booking,
        ...(wanted ? { tableGroup: wanted.group, table: wanted.number } : {}),
        tableFixed: true,
        ...(seating ? { arrivedAt: booking.arrivedAt ?? stamp, seatedAt: booking.seatedAt ?? stamp } : {}),
        updatedAt: stamp,
      };
      const saved = this.#seatAndSave(tx, placed, { sessionId: '' }, clock.nowMs);
      if (!saved) return { status: 'table_taken', free: this.#freeTables(tx, booking, clock.nowMs) };
      return { status: 'done', booking: this.#staffView(saved, language, clock) };
    });
  }

  /** What stops an arrival, a seating or a departure: only on the evening itself, which may run past midnight. */
  #eveningRefusal(booking: Booking, clock: Clock): StaffRefusal | undefined {
    if (booking.status === 'cancelled') return 'already_cancelled';
    if (!isActive(booking)) return 'not_active';
    if (booking.date !== clock.today && addDays(booking.date, 1) !== clock.today) return 'not_today';
    if (booking.leftAt) return 'already_left';
    return undefined;
  }

  #movingRefusal(booking: Booking, clock: Clock): StaffRefusal | undefined {
    if (booking.status === 'cancelled') return 'already_cancelled';
    if (!isActive(booking)) return 'not_active';
    if (compareDates(booking.date, clock.today) < 0 && addDays(booking.date, 1) !== clock.today) return 'in_the_past';
    if (booking.leftAt) return 'already_left';
    return undefined;
  }

  /** The team has called the guest back. */
  completeCallback(id: string): { status: 'done' } | { status: 'not_found' } {
    if (typeof id !== 'string' || id.length > 100) return { status: 'not_found' };
    return this.#store.transaction((tx) => {
      const callback = tx.callback(id);
      if (!callback) return { status: 'not_found' as const };
      if (callback.status !== 'done') tx.saveCallback({ ...callback, status: 'done' });
      return { status: 'done' as const };
    });
  }

  /** Removes holds whose time has run out. The production store calls it from an alarm. */
  purgeExpiredHolds(): number {
    const { nowMs } = this.#clock();
    return this.#store.transaction((tx) => tx.deleteExpiredHolds(nowMs));
  }

  /**
   * Deletes bookings for days more than `days` days ago, and requests to call
   * back made before then: names, numbers and allergies are kept no longer than
   * the service needs them. The production store calls it from an alarm.
   */
  purgeOlderThan(days: number): { bookings: number; callbacks: number } {
    if (!Number.isInteger(days) || days < 1) throw new RangeError('The retention period must be a whole number of days, at least one');
    const cutoff = addDays(this.#clock().today, -days);
    return this.#store.transaction((tx) => ({ bookings: tx.deleteBookingsBefore(cutoff), callbacks: tx.deleteCallbacksBefore(cutoff) }));
  }

  #clock(): Clock {
    const instant = this.#deps.now();
    const local = localNow(instant, this.#config.timeZone);
    return { today: local.date, nowMinutes: toMinutes(local.time), nowMs: instant.getTime() };
  }

  /**
   * Whether a party can have a table at this time. The staff skip the notice
   * period and the grid, because a party standing at the door does not arrive
   * on the quarter hour, but never the capacity: nobody can book a table twice.
   */
  #check(
    tx: BookingTx,
    date: PlainDate,
    time: PlainTime,
    partySize: number,
    clock: Clock,
    exclusions: Exclusions,
    cache: PlanCache,
    staff = false,
    /** For a table the staff chose: its group, whatever its size. */
    onlyGroup?: string,
  ): Check {
    const daysAhead = daysBetween(clock.today, date);
    if (daysAhead > this.#config.maxAdvanceDays) return { ok: false, reason: 'too_far_ahead' };
    if (!isOpenOn(this.#config, date)) return { ok: false, reason: 'closed' };
    const sitting = sittingAt(this.#config, date, time);
    if (!sitting) return { ok: false, reason: 'outside_hours' };
    if (!staff && !isOnGrid(sitting, time, this.#config.slotMinutes)) return { ok: false, reason: 'not_a_slot' };
    const minutesUntil = daysAhead * 1440 + toMinutes(time) - clock.nowMinutes;
    if (!staff && minutesUntil < this.#config.minNoticeMinutes) return { ok: false, reason: 'too_soon' };

    let occupations = cache.occupations.get(date);
    if (!occupations) {
      occupations = this.#occupations(tx, date, clock.nowMs, exclusions);
      cache.occupations.set(date, occupations);
    }
    const start = toMinutes(time);
    const end = start + stayMinutes(this.#config, partySize);
    const groups =
      onlyGroup === undefined
        ? suitableGroups(this.#config, partySize)
        : this.#config.tables.filter((group) => group.id === onlyGroup && group.seats >= partySize);
    const group = groups.find(
      (candidate) =>
        peakUse(occupations, candidate.id, start, end) < candidate.count &&
        this.#seatable(tx, date, candidate.id, start, end, exclusions, clock.nowMs, cache),
    );
    return group ? { ok: true, group, sitting } : { ok: false, reason: 'full' };
  }

  /**
   * Whether a new stay of one group still fits on its real tables. Capacity
   * already answers that while no table is fixed: stays placed in order of
   * arrival always fit. Tables the staff fixed by hand are the one case it
   * cannot see, so only then is the plan worked out.
   */
  #seatable(tx: BookingTx, date: PlainDate, group: string, start: number, end: number, exclusions: Exclusions, nowMs: number, cache: PlanCache): boolean {
    const key = `${date} ${group}`;
    let stays = cache.stays.get(key);
    if (!stays) {
      stays = this.#stays(tx, date, group, exclusions, nowMs);
      cache.stays.set(key, stays);
    }
    if (!stays.some((stay) => stay.fixed)) return true;
    return planGroup([...stays, { id: 'candidate', start, end, fixed: false, order: '~' }], this.#tableNumbers(group)) !== undefined;
  }

  /**
   * When a booking's table is free again, in minutes from midnight of its day:
   * early if the party has left, and not before now while it is still there. A
   * party that stays past its time keeps its table until the staff see it off,
   * so nobody is given a table with people at it; past two hours over its time,
   * the staff are taken to have forgotten to mark it gone.
   */
  #stayEnd(booking: Booking, nowMs: number): number {
    const start = toMinutes(booking.time);
    const planned = start + booking.stayMinutes;
    if (booking.leftAt) {
      const left = localNow(new Date(booking.leftAt), this.#config.timeZone);
      const leftMinute = daysBetween(booking.date, left.date) * 1440 + toMinutes(left.time);
      return Math.min(planned, Math.max(start, leftMinute));
    }
    if (booking.arrivedAt === undefined && booking.seatedAt === undefined) return planned;
    const now = localNow(new Date(nowMs), this.#config.timeZone);
    const nowMinute = daysBetween(booking.date, now.date) * 1440 + toMinutes(now.time);
    return Math.max(planned, Math.min(nowMinute + 1, planned + LONGEST_OVERSTAY_MINUTES));
  }

  /** The stays of one table group around a day, as the plan sees them, held tables included. */
  #stays(tx: BookingTx, date: PlainDate, group: string, exclusions: Exclusions, nowMs: number): Stay[] {
    const stays: Stay[] = [];
    const days: [PlainDate, number][] = [
      [addDays(date, -1), -1440],
      [date, 0],
      [addDays(date, 1), 1440],
    ];
    for (const [day, shift] of days) {
      for (const booking of tx.bookingsOn(day)) {
        if (!isActive(booking) || booking.tableGroup !== group || booking.id === exclusions.bookingId) continue;
        const start = toMinutes(booking.time) + shift;
        const end = this.#stayEnd(booking, nowMs) + shift;
        if (end <= start) continue;
        stays.push({
          id: booking.id,
          start,
          end,
          ...(booking.table === undefined ? {} : { table: booking.table }),
          // A neighbouring day's booking keeps its table: one day's plan never rearranges another's.
          fixed: booking.tableFixed === true || (day !== date && booking.table !== undefined),
          order: booking.createdAt,
        });
      }
      for (const hold of tx.holdsOn(day, nowMs)) {
        if (hold.tableGroup !== group || hold.sessionId === exclusions.sessionId) continue;
        const start = toMinutes(hold.time) + shift;
        stays.push({ id: `hold ${hold.id}`, start, end: start + hold.stayMinutes, fixed: false, order: `hold ${hold.expiresAt}` });
      }
    }
    return stays;
  }

  #tableNumbers(group: string): string[] {
    return physicalTables(this.#config)
      .filter((table) => table.group === group)
      .map((table) => table.number);
  }

  #physicalTable(number: string): PhysicalTable | undefined {
    if (typeof number !== 'string') return undefined;
    return physicalTables(this.#config).find((table) => table.number.toLowerCase() === number.trim().toLowerCase());
  }

  #checkPartySize(partySize: number, problems: string[]): void {
    if (!Number.isInteger(partySize) || partySize < 1) problems.push('partySize must be a whole number from 1');
    else if (partySize > this.#config.maxPartySize) {
      problems.push(`parties larger than ${this.#config.maxPartySize} need tables joined, which bookings do not handle`);
    }
  }

  /** A table the staff chose by its number, if there is one and it seats the party. */
  #chosenTable(number: string | undefined, partySize: number, problems: string[]): PhysicalTable | undefined {
    if (number === undefined) return undefined;
    const chosen = this.#physicalTable(number);
    if (!chosen) problems.push(`there is no table "${String(number).slice(0, 20)}"`);
    else if (Number.isInteger(partySize) && chosen.seats < partySize) problems.push(`table ${chosen.number} seats ${chosen.seats}, not ${partySize}`);
    return chosen;
  }

  /**
   * Gives a booking its table and saves it, moving bookings that are not fixed
   * when it only fits that way; they are saved too. Undefined when it cannot
   * be seated, which only happens around tables fixed by hand.
   */
  #seatAndSave(tx: BookingTx, booking: Booking, exclusions: Exclusions, nowMs: number): Booking | undefined {
    const others = this.#stays(tx, booking.date, booking.tableGroup, { ...exclusions, bookingId: booking.id }, nowMs);
    const own: Stay = {
      id: booking.id,
      start: toMinutes(booking.time),
      end: this.#stayEnd(booking, nowMs),
      ...(booking.table === undefined ? {} : { table: booking.table }),
      // A party seated without a table chosen takes the one the plan gives, then keeps it.
      fixed: booking.tableFixed === true && booking.table !== undefined,
      order: booking.createdAt,
    };
    const plan = planGroup([...others, own], this.#tableNumbers(booking.tableGroup));
    const table = plan?.get(booking.id);
    if (!plan || table === undefined) return undefined;
    for (const stay of others) {
      const moved = plan.get(stay.id);
      if (stay.id.startsWith('hold ') || moved === undefined || moved === stay.table) continue;
      const other = this.#bookingById(tx, booking.date, stay.id);
      if (other) tx.saveBooking({ ...other, table: moved, updatedAt: new Date(nowMs).toISOString() });
    }
    const seated: Booking = { ...booking, table };
    tx.saveBooking(seated);
    return seated;
  }

  #bookingById(tx: BookingTx, date: PlainDate, id: string): Booking | undefined {
    for (const day of [date, addDays(date, -1), addDays(date, 1)]) {
      const found = tx.bookingsOn(day).find((booking) => booking.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** Every other table where the party could sit for its stay, with the rest of the plan still working. */
  #freeTables(tx: BookingTx, booking: Booking, nowMs: number): string[] {
    return this.#freeTablesAt(tx, booking.date, booking.time, booking.partySize, nowMs, booking);
  }

  #freeTablesAt(tx: BookingTx, date: PlainDate, time: PlainTime, partySize: number, nowMs: number, booking?: Booking): string[] {
    const start = toMinutes(time);
    const end = booking ? this.#stayEnd(booking, nowMs) : start + stayMinutes(this.#config, partySize);
    return physicalTables(this.#config)
      .filter((table) => table.seats >= partySize && table.number !== booking?.table)
      .filter((table) => {
        const others = this.#stays(tx, date, table.group, { sessionId: '', ...(booking ? { bookingId: booking.id } : {}) }, nowMs);
        const own: Stay = { id: booking?.id ?? 'candidate', start, end, table: table.number, fixed: true, order: booking?.createdAt ?? '~' };
        return planGroup([...others, own], this.#tableNumbers(table.group)) !== undefined;
      })
      .map((table) => table.number);
  }

  /** Every table taken around a day, including stays that cross midnight from either side. */
  #occupations(tx: BookingTx, date: PlainDate, nowMs: number, exclusions: Exclusions): Occupation[] {
    const occupations: Occupation[] = [];
    const days: [PlainDate, number][] = [
      [addDays(date, -1), -1440],
      [date, 0],
      [addDays(date, 1), 1440],
    ];
    for (const [day, shift] of days) {
      for (const booking of tx.bookingsOn(day)) {
        if (!isActive(booking) || booking.id === exclusions.bookingId) continue;
        const start = toMinutes(booking.time) + shift;
        // A party that has left frees its table there and then.
        const end = this.#stayEnd(booking, nowMs) + shift;
        if (end > start) occupations.push({ tableGroup: booking.tableGroup, start, end });
      }
      for (const hold of tx.holdsOn(day, nowMs)) {
        if (hold.sessionId === exclusions.sessionId) continue;
        const start = toMinutes(hold.time) + shift;
        occupations.push({ tableGroup: hold.tableGroup, start, end: start + hold.stayMinutes });
      }
    }
    return occupations;
  }

  /**
   * What a good maître d' would offer instead: the nearest free time before and
   * after in the same service, then the closest time in that service on the next
   * day that has room. Someone asking for dinner is not offered lunch. When the
   * time asked is outside every service, any service of the day will do.
   */
  #alternatives(
    tx: BookingTx,
    date: PlainDate,
    time: PlainTime,
    partySize: number,
    language: Language,
    clock: Clock,
    exclusions: Exclusions,
    staff = false,
  ): SlotOffer[] {
    const cache = newCache();
    const asked = toMinutes(time);
    const service = sittingAt(this.#config, date, time)?.service;
    const free = (day: PlainDate, slot: PlainTime): boolean =>
      this.#check(tx, day, slot, partySize, clock, exclusions, cache, staff).ok;
    const byCloseness = (a: PlainTime, b: PlainTime): number =>
      Math.abs(toMinutes(a) - asked) - Math.abs(toMinutes(b) - asked) || toMinutes(a) - toMinutes(b);
    const slotsOfDay = (day: PlainDate): PlainTime[] =>
      service === undefined
        ? slotsOn(this.#config, day)
        : sittingsOn(this.#config, day)
            .filter((sitting) => sitting.service === service)
            .flatMap((sitting) => slotsOf(sitting, this.#config.slotMinutes));
    const offers: { date: PlainDate; time: PlainTime }[] = [];

    const sameDay = slotsOfDay(date).sort((a, b) => toMinutes(a) - toMinutes(b));
    const before = sameDay.filter((slot) => toMinutes(slot) < asked).reverse().find((slot) => free(date, slot));
    const after = sameDay.filter((slot) => toMinutes(slot) > asked).find((slot) => free(date, slot));
    for (const slot of [before, after].filter((slot): slot is PlainTime => slot !== undefined).sort(byCloseness)) {
      offers.push({ date, time: slot });
    }

    for (let offset = 1; offset <= ALTERNATIVE_DAYS; offset += 1) {
      const day = addDays(date, offset);
      if (daysBetween(clock.today, day) > this.#config.maxAdvanceDays) break;
      const closest = slotsOfDay(day).sort(byCloseness).find((slot) => free(day, slot));
      if (closest) {
        offers.push({ date: day, time: closest });
        break;
      }
    }
    return offers.map((offer) => this.#offer(offer.date, offer.time, language, clock));
  }

  #dayHours(date: PlainDate, language: Language, clock: Clock): DayHours {
    const sittings = sittingsOn(this.#config, date);
    const exception = this.#config.exceptions.find((candidate) => candidate.date === date);
    return {
      date,
      readBack: formatDate(date, language, clock.today),
      open: sittings.length > 0,
      sittings: sittings.map((sitting) => ({
        service: this.#serviceName(sitting.service, language),
        firstBooking: formatTime(sitting.firstSeating, language),
        lastBooking: formatTime(sitting.lastSeating, language),
      })),
      ...(exception?.reason ? { note: localize(exception.reason, language) } : {}),
    };
  }

  #hasStarted(booking: Booking, clock: Clock): boolean {
    // A party that arrived early has started too: it can no longer be cancelled from a phone.
    if (booking.arrivedAt) return true;
    return daysBetween(clock.today, booking.date) * 1440 + toMinutes(booking.time) <= clock.nowMinutes;
  }

  /** A booking still to come that the opening hours, changed since it was made, no longer cover. */
  #outsideHours(booking: Booking, clock: Clock): boolean {
    if (!isActive(booking) || this.#hasStarted(booking, clock)) return false;
    return !isOpenOn(this.#config, booking.date) || sittingAt(this.#config, booking.date, booking.time) === undefined;
  }

  #newReference(tx: BookingTx): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reference = this.#deps.ids.reference();
      if (!tx.referenceTaken(reference)) return reference;
    }
    throw new Error('Could not find a free booking reference');
  }

  #offer(date: PlainDate, time: PlainTime, language: Language, clock: Clock): SlotOffer {
    return { date, time, readBack: formatDateAtTime(date, time, language, clock.today) };
  }

  #serviceName(serviceId: string, language: Language): string {
    const service = this.#config.services.find((candidate) => candidate.id === serviceId);
    return service ? localize(service.name, language) : serviceId;
  }

  #staffUpdate(
    reference: string,
    language: Language,
    decide: (booking: Booking, clock: Clock, stamp: string) => { update: Partial<Booking> } | { reason: StaffRefusal },
  ): StaffActionResult {
    const normalized = normalizeReference(reference);
    if (!normalized) return { status: 'not_found' };
    const clock = this.#clock();
    const stamp = new Date(clock.nowMs).toISOString();
    return this.#store.transaction((tx): StaffActionResult => {
      const booking = tx.bookingByReference(normalized);
      if (!booking) return { status: 'not_found' };
      const decision = decide(booking, clock, stamp);
      if ('reason' in decision) return { status: 'not_allowed', reason: decision.reason };
      const updated: Booking = { ...booking, ...decision.update, updatedAt: stamp };
      tx.saveBooking(updated);
      return { status: 'done', booking: this.#staffView(updated, language, clock) };
    });
  }

  #stage(booking: Booking): ArrivalStage {
    if (booking.status === 'cancelled') return 'cancelled';
    if (booking.status === 'no_show') return 'no_show';
    if (booking.leftAt) return 'left';
    if (booking.seatedAt) return 'seated';
    if (booking.arrivedAt) return 'arrived';
    return 'expected';
  }

  #floorView(): FloorTableView[] {
    return physicalTables(this.#config).map((table) => {
      const drawn = this.#config.floor?.tables.find((candidate) => candidate.number === table.number);
      return {
        number: table.number,
        group: table.group,
        seats: table.seats,
        ...(drawn
          ? {
              shape: drawn.shape,
              ...(drawn.rotation === undefined ? {} : { rotation: drawn.rotation }),
              x: drawn.x,
              y: drawn.y,
              ...(drawn.zone === undefined ? {} : { zone: drawn.zone }),
            }
          : {}),
      };
    });
  }

  #staffView(booking: Booking, language: Language, clock: Clock, plannedTable?: string): StaffBookingView {
    const group = this.#config.tables.find((candidate) => candidate.id === booking.tableGroup);
    const words = messages(language);
    // A cancelled booking or a no-show holds no table, whatever it was planned at.
    const table = isActive(booking) ? (booking.table ?? plannedTable) : undefined;
    return {
      reference: booking.reference,
      date: booking.date,
      time: booking.time,
      endsAt: fromMinutes(((this.#stayEnd(booking, clock.nowMs) % 1440) + 1440) % 1440),
      plannedEndsAt: fromMinutes((toMinutes(booking.time) + booking.stayMinutes) % 1440),
      partySize: booking.partySize,
      stayMinutes: booking.stayMinutes,
      tableGroup: booking.tableGroup,
      seats: group?.seats ?? 0,
      ...(table === undefined ? {} : { table }),
      tableFixed: booking.tableFixed === true,
      stage: this.#stage(booking),
      ...(booking.arrivedAt ? { arrivedAt: booking.arrivedAt } : {}),
      ...(booking.seatedAt ? { seatedAt: booking.seatedAt } : {}),
      ...(booking.leftAt ? { leftAt: booking.leftAt } : {}),
      service: this.#serviceName(booking.service, language),
      guestName: this.#guestName(booking, language),
      status: booking.status,
      ...(booking.phone ? { phone: formatPhone(booking.phone) } : {}),
      ...(booking.phoneSource ? { phoneSource: booking.phoneSource } : {}),
      channel: booking.channel,
      language: booking.language,
      ...(booking.notes ? { notes: booking.notes } : {}),
      allergies: booking.allergies.map((id) => ({ id, name: words.allergen(id) })),
      walkIn: booking.walkIn === true,
      ...(this.#outsideHours(booking, clock) ? { outsideHours: true as const } : {}),
      history: booking.history.map((change) => ({
        at: change.at,
        from: { ...this.#offer(change.from.date, change.from.time, language, clock), partySize: change.from.partySize },
        channel: change.channel,
      })),
      createdAt: booking.createdAt,
      readBack: formatBooking(booking.partySize, booking.date, booking.time, language, clock.today),
    };
  }

  #callbackView(callback: CallbackRequest): CallbackView {
    return {
      id: callback.id,
      createdAt: callback.createdAt,
      channel: callback.channel,
      language: callback.language,
      ...(callback.phone ? { phone: formatPhone(callback.phone) } : {}),
      reason: callback.reason,
      summary: callback.summary,
      status: callback.status,
    };
  }

  /** A party on the spot booked without a name is called a walk-in in the language of whoever reads it. */
  #guestName(booking: Booking, language: Language): string {
    return booking.guestName === '' ? messages(language).walkInGuest() : booking.guestName;
  }

  #view(booking: Booking, language: Language, clock: Clock): BookingView {
    return {
      reference: booking.reference,
      date: booking.date,
      time: booking.time,
      partySize: booking.partySize,
      guestName: this.#guestName(booking, language),
      status: booking.status,
      ...(booking.notes ? { notes: booking.notes } : {}),
      allergies: [...booking.allergies],
      readBack: formatBooking(booking.partySize, booking.date, booking.time, language, clock.today),
    };
  }
}
