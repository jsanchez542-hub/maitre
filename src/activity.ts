import { addDays, localNow, toMinutes, type PlainDate } from './calendar.js';
import type { BusinessConfig } from './config.js';
import { sittingsOn } from './schedule.js';
import type { Booking, CallbackRequest, Channel } from './store.js';

/**
 * What the assistant did for a restaurant over a few days, for its dashboard:
 * the bookings it brought in by channel, the conversations it held, and the
 * calls it answered, while the restaurant was open and while it was closed.
 * It is what an owner weighs the assistant by.
 */
export interface Activity {
  /** The restaurant's own dates, both included. */
  from: PlainDate;
  to: PlainDate;
  bookings: {
    /** Bookings made in these days, for any date, by guests and by the staff; a party on the spot is not one. */
    made: number;
    covers: number;
    byChannel: Record<Channel, number>;
  };
  conversations: {
    /** Conversations in writing, on the website or WhatsApp. */
    written: number;
    /** Turns answered, on every channel. */
    turns: number;
    /** Requests passed to the team to call back. */
    passedToTeam: number;
  };
  calls: {
    answered: number;
    /** Answered during a service, from half an hour before its first seating to an hour after its last. */
    duringService: number;
    /** Answered while no service was on: the calls nobody would have picked up. */
    whileClosed: number;
    minutes: number;
    /** From the caller's last word to the restaurant's first, over every answer of these calls. */
    answerMs: { median: number | null; p90: number | null };
  };
}

export interface ActivityInput {
  config: BusinessConfig;
  from: PlainDate;
  to: PlainDate;
  /** Bookings created in the period. */
  bookings: readonly Booking[];
  /** Turns answered in the period. */
  turns: readonly { at: string; sessionId: string; channel: Channel }[];
  /** Calls started in the period. */
  calls: readonly { startedAt: string; seconds?: number; voiceToVoiceMs?: readonly number[] }[];
  /** Requests to call back created in the period. */
  callbacks: readonly CallbackRequest[];
}

/** Minutes around a service when a call still belongs to it: the phone rings before the doors open, and after the last seating. */
const BEFORE_SERVICE = 30;
const AFTER_SERVICE = 60;

export function activityOf(input: ActivityInput): Activity {
  const { config } = input;
  const byChannel: Record<Channel, number> = { web: 0, whatsapp: 0, voice: 0, staff: 0 };
  let covers = 0;
  const booked = input.bookings.filter((booking) => !booking.walkIn);
  for (const booking of booked) {
    byChannel[booking.channel] += 1;
    covers += booking.partySize;
  }

  const written = new Set(input.turns.filter((turn) => turn.channel === 'web' || turn.channel === 'whatsapp').map((turn) => turn.sessionId));

  let duringService = 0;
  let seconds = 0;
  const answers: number[] = [];
  for (const call of input.calls) {
    if (inService(config, new Date(call.startedAt))) duringService += 1;
    seconds += call.seconds ?? 0;
    answers.push(...(call.voiceToVoiceMs ?? []));
  }

  return {
    from: input.from,
    to: input.to,
    bookings: { made: booked.length, covers, byChannel },
    conversations: { written: written.size, turns: input.turns.length, passedToTeam: input.callbacks.length },
    calls: {
      answered: input.calls.length,
      duringService,
      whileClosed: input.calls.length - duringService,
      minutes: Math.round(seconds / 60),
      answerMs: { median: percentile(answers, 0.5), p90: percentile(answers, 0.9) },
    },
  };
}

/** Whether a service was on at an instant, by the restaurant's hours that day, the late end of the day before's included. */
function inService(config: BusinessConfig, instant: Date): boolean {
  const local = localNow(instant, config.timeZone);
  const minute = toMinutes(local.time);
  const days: [PlainDate, number][] = [
    [local.date, 0],
    [addDays(local.date, -1), 1440],
  ];
  return days.some(([date, shift]) =>
    sittingsOn(config, date).some(
      (sitting) => minute + shift >= toMinutes(sitting.firstSeating) - BEFORE_SERVICE && minute + shift <= toMinutes(sitting.lastSeating) + AFTER_SERVICE,
    ),
  );
}

function percentile(values: readonly number[], rank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1)] as number);
}
