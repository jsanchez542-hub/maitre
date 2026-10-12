import type { Allergen } from '../allergens.js';
import type { PlainDate, PlainTime } from '../calendar.js';
import type { Language } from '../i18n/index.js';
import type { HandoffReason } from '../store.js';
import { RECORDINGS } from './recordings.js';
import { Replay, type Recording } from './replay.js';

/** A booking a recorded conversation made. */
export interface ChatBooking {
  date: PlainDate;
  time: PlainTime;
  partySize: number;
  guestName: string;
  allergies: Allergen[];
  notes?: string;
}

/** A request a recorded conversation passed to the team, which calls the guest back. */
export interface ChatCallback {
  reason: HandoffReason;
  summary: string;
}

/** What a conversation played in the chat left behind, with the guest who held it. */
export interface ChatOutcome {
  recording: string;
  /** When the conversation took place. */
  at: string;
  channel: Recording['channel'];
  language: Language;
  /** The guest's number: the channel's, or the one typed in the web chat's field. */
  phone: string | null;
  /**
   * The bookings the conversation made. A conversation that only answers a
   * question, passes a request on, or cancels or moves a booking it started
   * with leaves none.
   */
  bookings: ChatBooking[];
  /** The requests it passed to the team: a party too large to seat, an allergen the sheet leaves open. */
  callbacks: ChatCallback[];
}

/**
 * Plays a recorded conversation to its end on its own restaurant, as the chat
 * shows it, and returns the bookings it made and the requests it passed on. The
 * dashboard passes the result to `demoEvening({ fromChat })`, so what the visitor
 * did in the chat is on the plan of the evening and in its calls to return.
 */
export function recordingOutcome(id: string): ChatOutcome {
  const recording = RECORDINGS.find((candidate) => candidate.id === id);
  if (!recording) throw new RangeError(`There is no recorded conversation "${id}"`);
  const replay = new Replay(recording);
  const before = new Set(replay.bookings().map((booking) => booking.id));
  while (!replay.done) replay.next();
  const bookings = replay
    .bookings()
    .filter((booking) => !before.has(booking.id) && booking.status !== 'cancelled')
    .map(
      (booking): ChatBooking => ({
        date: booking.date,
        time: booking.time,
        partySize: booking.partySize,
        guestName: booking.guestName,
        allergies: [...booking.allergies],
        ...(booking.notes ? { notes: booking.notes } : {}),
      }),
    );
  // A conversation starts with bookings only, so every request in its restaurant came from it.
  const callbacks = replay.callbacks().map((callback): ChatCallback => ({ reason: callback.reason, summary: callback.summary }));
  const phone = recording.turns.reduce<string | null>((typed, turn) => turn.fieldPhone ?? typed, recording.phone);
  return { recording: recording.id, at: recording.at, channel: recording.channel, language: recording.language, phone, bookings, callbacks };
}
