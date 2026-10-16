import { isLanguage, type Channel, type Language, type PlainDate, type PlainTime } from 'maitre';

/**
 * The assistant's log as the owner reads it: each conversation as a thread, who wrote or called, what was said and
 * what it came to, and behind it what the assistant asked the engine, how fast and at what cost.
 */

/** One errand of the assistant in the engine, and the engine's answer. Only names and statuses: the outputs stay out of the log. */
export interface ToolCall {
  name: string;
  status: string;
}

/** A booking as a turn left it: made, or moved to where it is now. */
export interface BookingEvent {
  reference: string;
  date: PlainDate;
  time: PlainTime;
  partySize: number;
}

export interface TurnRecord {
  at: string;
  sessionId: string;
  channel: Channel;
  language: Language;
  /** What the guest wrote or said, as they did; empty on the turn that followed a number typed in the chat's field or on the keypad. */
  guest: string;
  phoneEntered: boolean;
  reply: string;
  /** How the turn went: answered, or how it could not be. */
  outcome: string;
  latencyMs: number;
  costUsd: number | null;
  /** Answered by the second model, the first one's provider having failed. */
  fellBack: boolean;
  tools: readonly ToolCall[];
  /** The rules the code applied because the model did not keep them on its own. */
  corrections: readonly string[];
  /** What the turn did to bookings, with the name each new one is under. Turns logged before the Worker said so have none. */
  booked: readonly (BookingEvent & { guestName: string })[];
  changed: readonly BookingEvent[];
  cancelled: readonly { reference: string }[];
  passedToTeam: boolean;
  /** The guest's number as the conversation knew it then: caller ID, WhatsApp, or typed on the website. */
  phone: string | null;
}

export interface CallRecord {
  sessionId: string;
  startedAt: string;
  language: Language;
  /** Null while the call is still going. */
  seconds: number | null;
  endedBy: string | null;
  /** For each answer, from the caller's last word to the restaurant's first. */
  answerMs: readonly number[];
}

/** What a conversation came to for the restaurant. A call in which nobody spoke is silent. */
export type ConversationResult = 'booked' | 'changed' | 'cancelled' | 'confirmed' | 'answered' | 'silent';

export interface Conversation {
  sessionId: string;
  channel: Channel;
  language: Language;
  startedAt: string;
  /** Oldest first. */
  turns: readonly TurnRecord[];
  call: CallRecord | null;
  result: ConversationResult;
  /** The booking the result is about, as it stands at the end; null when the log does not say. */
  booking: BookingEvent | null;
  passedToTeam: boolean;
  /** Who it was, as far as the conversation says: the name a booking is under, and the number. */
  guestName: string | null;
  phone: string | null;
}

type Json = Record<string, unknown>;

const CHANNELS: readonly string[] = ['web', 'whatsapp', 'voice', 'staff'] satisfies readonly Channel[];

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isChannel = (value: unknown): value is Channel => typeof value === 'string' && CHANNELS.includes(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Fields of a known, short length: the patterns only ever see ten or five characters.
const isDate = (value: unknown): value is PlainDate => typeof value === 'string' && value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isTime = (value: unknown): value is PlainTime => typeof value === 'string' && value.length === 5 && /^\d{2}:\d{2}$/.test(value);

/** The entries of a list that are records, or none when it is absent: the Worker writes a field only when it has something. */
const recordsIn = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function toolsFrom(value: unknown): ToolCall[] {
  return recordsIn(value).flatMap((tool): ToolCall[] =>
    typeof tool['name'] === 'string' && typeof tool['status'] === 'string' ? [{ name: tool['name'], status: tool['status'] }] : [],
  );
}

function bookingFrom(entry: Json): BookingEvent | null {
  const { reference, date, time, partySize } = entry;
  return typeof reference === 'string' && isDate(date) && isTime(time) && isCount(partySize) ? { reference, date, time, partySize } : null;
}

/** The turns as the Worker logs them, keeping only well-formed ones: they come from the network. */
export function turnsFrom(value: unknown): TurnRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): TurnRecord[] => {
    if (!isRecord(entry)) return [];
    const { at, sessionId, channel, language, guest, reply, latencyMs } = entry;
    if (!isInstant(at) || typeof sessionId !== 'string' || !isChannel(channel) || !isLanguage(language)) return [];
    if (typeof guest !== 'string' || typeof reply !== 'string' || !isCount(latencyMs)) return [];
    const corrections = Array.isArray(entry['corrections']) ? entry['corrections'].filter((name): name is string => typeof name === 'string') : [];
    const booked = recordsIn(entry['booked']).flatMap((made) => {
      const booking = bookingFrom(made);
      return booking && typeof made['guestName'] === 'string' ? [{ ...booking, guestName: made['guestName'] }] : [];
    });
    const changed = recordsIn(entry['changed']).flatMap((moved) => {
      const booking = bookingFrom(moved);
      return booking ? [booking] : [];
    });
    const cancelled = recordsIn(entry['cancelled']).flatMap((gone) => (typeof gone['reference'] === 'string' ? [{ reference: gone['reference'] }] : []));
    return [
      {
        at,
        sessionId,
        channel,
        language,
        guest,
        phoneEntered: entry['phoneEntered'] === true,
        reply,
        outcome: typeof entry['outcome'] === 'string' ? entry['outcome'] : 'answered',
        latencyMs,
        costUsd: isCount(entry['costUsd']) ? entry['costUsd'] : null,
        fellBack: entry['fellBack'] === true,
        tools: toolsFrom(entry['tools']),
        corrections,
        booked,
        changed,
        cancelled,
        passedToTeam: entry['passedToTeam'] === true,
        phone: typeof entry['phone'] === 'string' && entry['phone'] !== '' ? entry['phone'] : null,
      },
    ];
  });
}

/** The calls as the Worker logs them, keeping only well-formed ones. */
export function callsFrom(value: unknown): CallRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): CallRecord[] => {
    if (!isRecord(entry) || typeof entry['sessionId'] !== 'string' || !isInstant(entry['startedAt']) || !isLanguage(entry['language'])) return [];
    const answers = Array.isArray(entry['voiceToVoiceMs']) ? entry['voiceToVoiceMs'].filter(isCount) : [];
    return [
      {
        sessionId: entry['sessionId'],
        startedAt: entry['startedAt'],
        language: entry['language'],
        seconds: isCount(entry['seconds']) ? entry['seconds'] : null,
        endedBy: typeof entry['endedBy'] === 'string' ? entry['endedBy'] : null,
        answerMs: answers,
      },
    ];
  });
}

/** Whether a turn did this to a booking: by the events it logged, or by the engine's statuses in a turn logged before them. */
const did = (turn: TurnRecord, events: readonly unknown[], tool: string, status: string): boolean =>
  events.length > 0 || turn.tools.some((call) => call.name === tool && call.status === status);

/**
 * What the engine did in a conversation, never what the reply says: a booking is one the engine made. A booking moved
 * in the conversation that made it is still that conversation's booking, where it stands at the end.
 */
function resultOf(turns: readonly TurnRecord[]): Pick<Conversation, 'result' | 'booking' | 'passedToTeam' | 'guestName' | 'phone'> {
  let result: ConversationResult = turns.length > 0 ? 'answered' : 'silent';
  let booking: BookingEvent | null = null;
  let passedToTeam = false;
  let guestName: string | null = null;
  let phone: string | null = null;
  for (const turn of turns) {
    phone = turn.phone ?? phone;
    if (turn.passedToTeam || turn.outcome === 'failed_handed_over' || turn.tools.some((call) => call.name === 'hand_over' && call.status === 'recorded')) {
      passedToTeam = true;
    }
    if (did(turn, turn.booked, 'book_table', 'booked')) {
      result = 'booked';
      const made = turn.booked[turn.booked.length - 1];
      booking = made ? { reference: made.reference, date: made.date, time: made.time, partySize: made.partySize } : null;
      guestName = made?.guestName || guestName;
    }
    if (did(turn, turn.changed, 'change_booking', 'changed')) {
      if (result !== 'booked') result = 'changed';
      booking = turn.changed[turn.changed.length - 1] ?? booking;
    }
    if (did(turn, turn.cancelled, 'cancel_booking', 'cancelled')) {
      result = 'cancelled';
      booking = null;
    }
    if (result === 'answered' && turn.tools.some((call) => call.name === 'confirm_booking' && call.status === 'confirmed')) result = 'confirmed';
  }
  return { result, booking, passedToTeam, guestName, phone };
}

/**
 * The turns and calls as conversations, the latest first: each one's turns in order, with the call they were said on.
 * The Worker lists its log latest first, in the order it wrote it, which two turns in the same millisecond keep and
 * their instants would not.
 */
export function conversationsOf(turns: readonly TurnRecord[], calls: readonly CallRecord[]): Conversation[] {
  const bySession = new Map<string, TurnRecord[]>();
  for (const turn of [...turns].reverse()) bySession.set(turn.sessionId, [...(bySession.get(turn.sessionId) ?? []), turn]);
  const callOf = new Map(calls.map((call) => [call.sessionId, call]));
  const conversations: Conversation[] = [];
  for (const sessionId of new Set([...bySession.keys(), ...callOf.keys()])) {
    const said = bySession.get(sessionId) ?? [];
    const call = callOf.get(sessionId) ?? null;
    const first = said[0];
    const language = first?.language ?? call?.language;
    const startedAt = call?.startedAt ?? first?.at;
    if (!language || !startedAt) continue;
    conversations.push({ sessionId, channel: call ? 'voice' : (first?.channel ?? 'web'), language, startedAt, turns: said, call, ...resultOf(said) });
  }
  return conversations.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The middle answer time of a call: half its answers came faster. Null without answers. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
