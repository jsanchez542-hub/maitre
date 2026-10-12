import type { Allergen } from '../allergens.js';
import type { PlainDate, PlainTime } from '../calendar.js';
import type { Language } from '../i18n/index.js';
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
}

/**
 * Plays a recorded conversation to its end on its own restaurant, as the chat
 * shows it, and returns the bookings it made. The dashboard passes the result
 * to `demoEvening({ fromChat })`, so what the visitor booked in the chat is
 * on the plan of the evening.
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
  const phone = recording.turns.reduce<string | null>((typed, turn) => turn.fieldPhone ?? typed, recording.phone);
  return { recording: recording.id, at: recording.at, channel: recording.channel, language: recording.language, phone, bookings };
}
