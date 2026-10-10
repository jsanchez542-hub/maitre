import { isAllergen, type Allergen } from './allergens.js';
import { pickTableGroup, stayMinutes, type Occupation } from './availability.js';
import { addDays, daysBetween, isPlainTime, localNow, toMinutes, type PlainDate, type PlainTime } from './calendar.js';
import { assertValidConfig, type BusinessConfig, type Sitting, type TableGroup } from './config.js';
import { resolveDate, type DateSpec } from './dates.js';
import { formatBooking, formatDate, formatDateAtTime, formatTime, localize, type Language } from './i18n/index.js';
import { isReference, type IdSource } from './ids.js';
import { isE164 } from './phone.js';
import { isOnGrid, isOpenOn, sittingAt, sittingsOn, slotsOf, slotsOn } from './schedule.js';
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

export type CallbackResult = { status: 'recorded'; id: string } | { status: 'invalid'; problems: string[] };

export interface DayHours {
  date: PlainDate;
  readBack: string;
  open: boolean;
  sittings: { service: string; firstBooking: string; lastBooking: string }[];
  note?: string;
}

interface Clock {
  today: PlainDate;
  nowMinutes: number;
  nowMs: number;
}

interface Exclusions {
  sessionId: string;
  bookingId?: string;
}

type Check =
  | { ok: true; group: TableGroup; sitting: Sitting }
  | { ok: false; reason: UnavailableReason };

const NAME_MAX = 80;
const NOTES_MAX = 500;
const SUMMARY_MAX = 500;
const ALTERNATIVE_DAYS = 14;

/** Collapses whitespace and refuses control characters, empty text and anything too long. */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length > max * 4) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '' || collapsed.length > max) return undefined;
  for (const char of collapsed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return undefined;
  }
  return collapsed;
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

      const check = this.#check(tx, date, time, partySize, clock, exclusions, new Map());
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
        createdAt: stamp,
        updatedAt: stamp,
      };
      tx.saveBooking(booking);
      tx.deleteHold(hold.id);
      return { status: 'booked', booking: this.#view(booking, session.language, clock) };
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
      const moved: Booking = {
        ...booking,
        holdId: hold.id,
        date: hold.date,
        time: hold.time,
        partySize: hold.partySize,
        stayMinutes: hold.stayMinutes,
        tableGroup: hold.tableGroup,
        service: hold.service,
        // A moved booking is confirmed again, so the reminder goes out for the new time.
        status: 'booked',
        updatedAt: new Date(clock.nowMs).toISOString(),
      };
      tx.saveBooking(moved);
      tx.deleteHold(hold.id);
      return { status: 'changed', booking: this.#view(moved, session.language, clock), previous };
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

  /** Passes something the assistant cannot handle to the team, who call the guest back. */
  requestCallback(session: Session, request: { reason: string; summary: string }): CallbackResult {
    const problems: string[] = [];
    const reason = HANDOFF_REASONS.find((candidate) => candidate === request.reason);
    if (!reason) problems.push(`reason must be one of ${HANDOFF_REASONS.join(', ')}`);
    const summary = cleanText(request.summary, SUMMARY_MAX);
    if (!summary) problems.push(`summary must be 1 to ${SUMMARY_MAX} characters of plain text`);
    if (!reason || !summary) return { status: 'invalid', problems };
    const clock = this.#clock();
    const callback: CallbackRequest = {
      id: this.#deps.ids.id(),
      sessionId: session.id,
      channel: session.channel,
      language: session.language,
      ...(session.phone ? { phone: session.phone.e164 } : {}),
      reason,
      summary,
      status: 'open',
      createdAt: new Date(clock.nowMs).toISOString(),
    };
    this.#store.transaction((tx) => tx.saveCallback(callback));
    return { status: 'recorded', id: callback.id };
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

  /** Removes holds whose time has run out. The production store calls it from an alarm. */
  purgeExpiredHolds(): number {
    const { nowMs } = this.#clock();
    return this.#store.transaction((tx) => tx.deleteExpiredHolds(nowMs));
  }

  #clock(): Clock {
    const instant = this.#deps.now();
    const local = localNow(instant, this.#config.timeZone);
    return { today: local.date, nowMinutes: toMinutes(local.time), nowMs: instant.getTime() };
  }

  #check(
    tx: BookingTx,
    date: PlainDate,
    time: PlainTime,
    partySize: number,
    clock: Clock,
    exclusions: Exclusions,
    cache: Map<PlainDate, Occupation[]>,
  ): Check {
    const daysAhead = daysBetween(clock.today, date);
    if (daysAhead > this.#config.maxAdvanceDays) return { ok: false, reason: 'too_far_ahead' };
    if (!isOpenOn(this.#config, date)) return { ok: false, reason: 'closed' };
    const sitting = sittingAt(this.#config, date, time);
    if (!sitting) return { ok: false, reason: 'outside_hours' };
    if (!isOnGrid(sitting, time, this.#config.slotMinutes)) return { ok: false, reason: 'not_a_slot' };
    const minutesUntil = daysAhead * 1440 + toMinutes(time) - clock.nowMinutes;
    if (minutesUntil < this.#config.minNoticeMinutes) return { ok: false, reason: 'too_soon' };

    let occupations = cache.get(date);
    if (!occupations) {
      occupations = this.#occupations(tx, date, clock.nowMs, exclusions);
      cache.set(date, occupations);
    }
    const group = pickTableGroup(this.#config, partySize, toMinutes(time), occupations);
    return group ? { ok: true, group, sitting } : { ok: false, reason: 'full' };
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
        occupations.push({ tableGroup: booking.tableGroup, start, end: start + booking.stayMinutes });
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
  ): SlotOffer[] {
    const cache = new Map<PlainDate, Occupation[]>();
    const asked = toMinutes(time);
    const service = sittingAt(this.#config, date, time)?.service;
    const free = (day: PlainDate, slot: PlainTime): boolean =>
      this.#check(tx, day, slot, partySize, clock, exclusions, cache).ok;
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
    return daysBetween(clock.today, booking.date) * 1440 + toMinutes(booking.time) <= clock.nowMinutes;
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

  #view(booking: Booking, language: Language, clock: Clock): BookingView {
    return {
      reference: booking.reference,
      date: booking.date,
      time: booking.time,
      partySize: booking.partySize,
      guestName: booking.guestName,
      status: booking.status,
      ...(booking.notes ? { notes: booking.notes } : {}),
      allergies: [...booking.allergies],
      readBack: formatBooking(booking.partySize, booking.date, booking.time, language, clock.today),
    };
  }
}
