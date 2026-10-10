import type { BusinessConfig } from '../config.js';
import { BookingEngine, normalizeReference, type Session, type StaffBookRequest } from '../engine.js';
import type { Language } from '../i18n/index.js';
import { randomIds } from '../ids.js';
import { MemoryStore, type Booking, type PhoneSource } from '../store.js';
import { runTool, type ToolOutput } from '../tools.js';
import { DEMO_RESTAURANT } from './restaurant.js';

/** A booking that exists before a conversation, made by the staff. `ref` names it, so a check or a replay can find it. */
export interface SetupBooking extends StaffBookRequest {
  ref?: string;
}

/** Makes the bookings a conversation starts with. Returns their references by name. */
export function applySetup(engine: BookingEngine, setup: readonly SetupBooking[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const { ref, ...request } of setup) {
    const result = engine.staffBook(request);
    if (result.status !== 'booked') throw new Error(`A booking the conversation starts with could not be made: ${result.status}`);
    if (ref) refs[ref] = result.booking.reference;
  }
  return refs;
}

export interface RecordedTurn {
  guest: string;
  /** The model's reply, as the guest saw it. */
  reply: string;
  /** From the guest's message to the reply, as measured when it was recorded. */
  latencyMs: number;
  costUsd?: number;
  /** The tool calls the model made, with what the engine answered then, trimmed to what a replay checks. */
  tools: { name: string; input: unknown; output: unknown }[];
}

/** A real conversation with a real model, kept to be played again without one. */
export interface Recording {
  id: string;
  description: string;
  language: Language;
  channel: 'web' | 'whatsapp' | 'voice';
  /** The number the channel gave, or null. */
  phone: string | null;
  /** When it took place: the replay runs on the same clock, so "vendredi" is the same Friday. */
  at: string;
  setup: SetupBooking[];
  /** The references the setup bookings had in the recording, by name. */
  refs: Record<string, string>;
  /** The model that held the conversation, as OpenRouter names it. */
  model: string;
  turns: RecordedTurn[];
}

export interface ReplayedTurn {
  guest: string;
  reply: string;
  /** What the engine answered now, on this replay's restaurant. */
  tools: { name: string; input: unknown; output: ToolOutput }[];
  latencyMs: number;
  costUsd?: number;
}

/** The engine no longer answers a recorded tool call the way it did, so the recorded reply could now be untrue. */
export class ReplayError extends Error {
  override name = 'ReplayError';
}

const PHONE_SOURCES: Record<Recording['channel'], PhoneSource> = { voice: 'caller_id', whatsapp: 'whatsapp', web: 'form' };
/** What a replay compares between the recorded answer of a tool and the live one. */
const COMPARED = ['status', 'date', 'time', 'partySize'] as const;
/** Identifiers the engine makes up afresh, which differ from one run to the next. */
const IDENTIFIERS = new Set(['holdId', 'reference']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The recorded identifiers in a tool call, replaced by the ones this replay's engine made. */
function translate(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? ids.get(normalizeReference(value) ?? '') ?? value;
  if (Array.isArray(value)) return value.map((item) => translate(item, ids));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item, ids)]));
  return value;
}

/** Pairs every identifier of a recorded answer with the one in the live answer, at the same place. */
function learn(recorded: unknown, live: unknown, ids: Map<string, string>): void {
  if (Array.isArray(recorded) && Array.isArray(live)) {
    recorded.forEach((item, index) => learn(item, live[index], ids));
    return;
  }
  if (!isRecord(recorded) || !isRecord(live)) return;
  for (const [key, value] of Object.entries(recorded)) {
    const now = live[key];
    if (IDENTIFIERS.has(key) && typeof value === 'string' && typeof now === 'string') ids.set(value, now);
    else learn(value, now, ids);
  }
}

/**
 * Plays a recorded conversation again on a fresh restaurant, with no model:
 * the replies are the recorded ones, and every tool call the model made runs
 * on the real engine. The bookings are the engine's own, so a page can show
 * the service of the day filling up as the conversation goes.
 *
 * Holds and references come out different from the recording's; they are
 * translated in the tool calls and in the replies. When the engine answers a
 * call differently from the recording (another status, day or time), the
 * replay stops rather than show a reply that would no longer be true.
 */
export class Replay {
  readonly engine: BookingEngine;
  readonly #store = new MemoryStore();
  readonly #recording: Recording;
  readonly #session: Session;
  readonly #ids = new Map<string, string>();
  #played = 0;

  constructor(recording: Recording, config: BusinessConfig = DEMO_RESTAURANT) {
    this.#recording = recording;
    this.engine = new BookingEngine(config, this.#store, { now: () => new Date(recording.at), ids: randomIds });
    const refs = applySetup(this.engine, recording.setup);
    for (const [name, recorded] of Object.entries(recording.refs)) {
      const live = refs[name];
      if (live) this.#ids.set(recorded, live);
    }
    this.#session = {
      id: `replay-${recording.id}`,
      channel: recording.channel,
      language: recording.language,
      ...(recording.phone ? { phone: { e164: recording.phone, source: PHONE_SOURCES[recording.channel] } } : {}),
    };
  }

  get done(): boolean {
    return this.#played >= this.#recording.turns.length;
  }

  /** Every booking of this replay's restaurant, those it started with included. */
  bookings(): Booking[] {
    return this.#store.snapshot().bookings;
  }

  /** Plays the next turn, or returns undefined once the conversation is over. */
  next(): ReplayedTurn | undefined {
    const turn = this.#recording.turns[this.#played];
    if (!turn) return undefined;
    this.#played += 1;
    const tools = turn.tools.map((tool) => {
      const input = translate(tool.input, this.#ids);
      const output = runTool(this.engine, this.#session, tool.name, input);
      const recorded = isRecord(tool.output) ? tool.output : {};
      for (const key of COMPARED) {
        if (key in recorded && recorded[key] !== output[key]) {
          throw new ReplayError(
            `${this.#recording.id}, turn ${this.#played}: ${tool.name} now answers ${key} ${JSON.stringify(output[key])}, ` +
              `the recording has ${JSON.stringify(recorded[key])}`,
          );
        }
      }
      learn(tool.output, output, this.#ids);
      return { name: tool.name, input, output };
    });
    let reply = turn.reply;
    for (const [recorded, live] of this.#ids) reply = reply.split(recorded).join(live);
    return { guest: turn.guest, reply, tools, latencyMs: turn.latencyMs, ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }) };
  }
}
