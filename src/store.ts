import type { Allergen } from './allergens.js';
import { compareDates, type PlainDate, type PlainTime } from './calendar.js';
import type { Language } from './i18n/index.js';

export type Channel = 'web' | 'whatsapp' | 'voice' | 'staff';

/**
 * Where a guest's phone number came from. Every source is one the guest did not
 * have to say out loud: a number misheard by speech recognition is how the
 * reference video booked a table for the wrong person.
 */
export type PhoneSource = 'caller_id' | 'whatsapp' | 'keypad' | 'form' | 'staff';

export type BookingStatus = 'booked' | 'confirmed' | 'cancelled' | 'no_show';

/** One move of a booking, kept so "20 h 30 (avant 20 h)" can be shown and a dispute settled. */
export interface BookingChange {
  /** ISO 8601 instant of the change. */
  at: string;
  from: { date: PlainDate; time: PlainTime; partySize: number };
  channel: Channel;
}

export interface Booking {
  id: string;
  /** Short code the guest can quote, without letters that look like digits. */
  reference: string;
  /** The hold this booking came from, so the same request twice books once. */
  holdId: string;
  date: PlainDate;
  time: PlainTime;
  partySize: number;
  /** Fixed when the booking is made, so changing the stay rules later never stretches a booking already promised. */
  stayMinutes: number;
  tableGroup: string;
  service: string;
  guestName: string;
  /**
   * E.164, such as +33612345678. Every booking made by a guest has one; only a
   * party the staff seat on the spot ("sur place") may have none.
   */
  phone?: string;
  phoneSource?: PhoneSource;
  status: BookingStatus;
  channel: Channel;
  language: Language;
  notes?: string;
  allergies: readonly Allergen[];
  /** Entered by the staff for a party already in the restaurant. */
  walkIn?: boolean;
  /** Oldest first, the most recent twenty. */
  history: readonly BookingChange[];
  /** ISO 8601 instants. */
  createdAt: string;
  updatedAt: string;
}

/** A table set aside for a guest while they finish booking. It expires on its own. */
export interface Hold {
  id: string;
  sessionId: string;
  date: PlainDate;
  time: PlainTime;
  partySize: number;
  stayMinutes: number;
  tableGroup: string;
  service: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export type HandoffReason = 'large_group' | 'allergy_question' | 'special_request' | 'complaint' | 'other';

/** Something the assistant could not handle and passed to the team. */
export interface CallbackRequest {
  id: string;
  sessionId: string;
  channel: Channel;
  language: Language;
  phone?: string;
  reason: HandoffReason;
  summary: string;
  status: 'open' | 'done';
  createdAt: string;
}

const ACTIVE: readonly BookingStatus[] = ['booked', 'confirmed'];

export function isActive(booking: Booking): boolean {
  return ACTIVE.includes(booking.status);
}

/** Reads and writes inside one transaction. Everything is synchronous on purpose: see `BookingStore`. */
export interface BookingTx {
  bookingsOn(date: PlainDate): Booking[];
  bookingByReference(reference: string): Booking | undefined;
  bookingByHold(holdId: string): Booking | undefined;
  bookingsForPhone(phone: string, fromDate: PlainDate): Booking[];
  saveBooking(booking: Booking): void;
  referenceTaken(reference: string): boolean;

  /** Holds that have not expired at `nowMs`. */
  holdsOn(date: PlainDate, nowMs: number): Hold[];
  hold(id: string): Hold | undefined;
  holdsOfSession(sessionId: string): Hold[];
  saveHold(hold: Hold): void;
  deleteHold(id: string): void;
  deleteExpiredHolds(nowMs: number): number;

  saveCallback(request: CallbackRequest): void;
  callback(id: string): CallbackRequest | undefined;
  /** Requests the team has not dealt with yet, oldest first. */
  openCallbacks(): CallbackRequest[];

  /** For the retention period: bookings for days before `date`. */
  deleteBookingsBefore(date: PlainDate): number;
  /** For the retention period: requests made before `date` began, in UTC. */
  deleteCallbacksBefore(date: PlainDate): number;
}

/**
 * One business's bookings. `transaction` runs its function with nothing else
 * reading or writing until it returns, and undoes every write if it throws.
 *
 * The function is synchronous because the production store is a Cloudflare
 * Durable Object, whose SQLite API is synchronous and which handles one request
 * at a time: checking for a free table and taking it can never be interleaved
 * with another call. An `await` inside would break that guarantee, so the type
 * does not allow one.
 */
export interface BookingStore {
  transaction<T>(work: (tx: BookingTx) => T): T;
}

interface MemoryState {
  bookings: Map<string, Booking>;
  holds: Map<string, Hold>;
  callbacks: Map<string, CallbackRequest>;
}

function cloneState(state: MemoryState): MemoryState {
  return {
    bookings: new Map(state.bookings),
    holds: new Map(state.holds),
    callbacks: new Map(state.callbacks),
  };
}

/** The store used by the tests and by the demo that runs in the browser. */
export class MemoryStore implements BookingStore {
  #state: MemoryState = { bookings: new Map(), holds: new Map(), callbacks: new Map() };
  #inTransaction = false;

  transaction<T>(work: (tx: BookingTx) => T): T {
    if (this.#inTransaction) throw new Error('Transactions cannot be nested');
    // Records are replaced, never mutated, so a shallow copy is a full snapshot.
    const snapshot = cloneState(this.#state);
    this.#inTransaction = true;
    try {
      const result = work(this.#tx());
      if (result instanceof Promise) throw new Error('A transaction must not be asynchronous');
      return result;
    } catch (error) {
      this.#state = snapshot;
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  /** Everything stored, for the panel and the tests. */
  snapshot(): { bookings: Booking[]; holds: Hold[]; callbacks: CallbackRequest[] } {
    return {
      bookings: [...this.#state.bookings.values()],
      holds: [...this.#state.holds.values()],
      callbacks: [...this.#state.callbacks.values()],
    };
  }

  #tx(): BookingTx {
    const state = (): MemoryState => this.#state;
    return {
      bookingsOn: (date) => [...state().bookings.values()].filter((b) => b.date === date),
      bookingByReference: (reference) => [...state().bookings.values()].find((b) => b.reference === reference),
      bookingByHold: (holdId) => [...state().bookings.values()].find((b) => b.holdId === holdId),
      bookingsForPhone: (phone, fromDate) =>
        [...state().bookings.values()]
          .filter((b) => b.phone === phone && compareDates(b.date, fromDate) >= 0)
          .sort((a, b) => compareDates(a.date, b.date) || a.time.localeCompare(b.time)),
      saveBooking: (booking) => {
        state().bookings.set(
          booking.id,
          Object.freeze({ ...booking, allergies: [...booking.allergies], history: booking.history.map((change) => ({ ...change })) }),
        );
      },
      referenceTaken: (reference) => [...state().bookings.values()].some((b) => b.reference === reference),

      holdsOn: (date, nowMs) => [...state().holds.values()].filter((h) => h.date === date && h.expiresAt > nowMs),
      hold: (id) => state().holds.get(id),
      holdsOfSession: (sessionId) => [...state().holds.values()].filter((h) => h.sessionId === sessionId),
      saveHold: (hold) => {
        state().holds.set(hold.id, Object.freeze({ ...hold }));
      },
      deleteHold: (id) => {
        state().holds.delete(id);
      },
      deleteExpiredHolds: (nowMs) => removeWhere(state().holds, (hold) => hold.expiresAt <= nowMs),

      saveCallback: (request) => {
        state().callbacks.set(request.id, Object.freeze({ ...request }));
      },
      callback: (id) => state().callbacks.get(id),
      openCallbacks: () =>
        [...state().callbacks.values()].filter((c) => c.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

      deleteBookingsBefore: (date) => removeWhere(state().bookings, (booking) => compareDates(booking.date, date) < 0),
      // ISO instants sort as text, and "2026-07-12T…" comes before "2026-07-13".
      deleteCallbacksBefore: (date) => removeWhere(state().callbacks, (callback) => callback.createdAt < date),
    };
  }
}

function removeWhere<T>(records: Map<string, T>, condition: (record: T) => boolean): number {
  let removed = 0;
  for (const [id, record] of records) {
    if (condition(record)) {
      records.delete(id);
      removed += 1;
    }
  }
  return removed;
}
