import { DurableObject } from 'cloudflare:workers';
import { KEYPAD_ENTERED, PHONE_ENTERED, respond, turnEffects, type TurnEffects, type TurnResult } from '../../src/agent/agent.js';
import { ModelError, type TranscriptEntry } from '../../src/agent/model.js';
import { openRouterModel } from '../../src/agent/providers/openai.js';
import { DEMO_RESTAURANT } from '../../src/demo/restaurant.js';
import {
  BookingEngine,
  type ServiceDay,
  type Session,
  type StaffActionResult,
  type StaffBookRequest,
  type StaffBookResult,
  type TableActionResult,
} from '../../src/engine.js';
import { isLanguage, messages, type Language } from '../../src/i18n/index.js';
import { randomIds } from '../../src/ids.js';
import { formatPhone, normalizePhone } from '../../src/phone.js';
import type { PhoneSource } from '../../src/store.js';
import { errandOf, runTool, type ToolOutput } from '../../src/tools.js';
import { CALL_ENDINGS, Conversations, RETENTION_DAYS, type CallEndedBy, type CallLog, type TurnLog } from './conversations.js';
import type { Env } from './env.js';
import { SqlStore } from './sql-store.js';

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_MS = 86_400_000;
/** The longest message speech recognition can hand over in one turn, in characters. */
const MAX_SPOKEN = 2000;
/** The longest call the log believes, in seconds: anything above is a broken clock, not a call. */
const MAX_CALL_SECONDS = 4 * 3600;
/**
 * How long one model call may take on the phone before it is asked again, once.
 * The phone set's slowest first answer was 2.2 s at the 95th percentile; past
 * this, the provider has stalled and the caller would be waiting on nothing.
 */
const VOICE_MODEL_TIMEOUT_MS = 8_000;

export interface ChatRequest {
  sessionId: string;
  message: string;
  channel: 'web' | 'whatsapp';
  language: string;
  /** For WhatsApp: the sender's number, which the channel vouches for. */
  phone?: string;
}

/**
 * An answered turn: the reply, and what the turn did, read from the engine's
 * answers (bookings made or moved, a request passed to the team, the phone
 * field to show), so a chat can show a booking card without reading the reply.
 */
export type ChatAnswer = { status: 'ok'; reply: string; outcome: string } & TurnEffects;

export type ChatResponse = ChatAnswer | { status: 'invalid'; problems: string[] } | { status: 'not_configured' };

/** The number kept, and the turn it set going when the model key is there. */
export type PhoneResponse = ({ status: 'ok'; phone: string } & Partial<Omit<ChatAnswer, 'status'>>) | (ChatAnswer & { phone: string });

/** A call starting: the session the voice agent opened for it, the language it starts in, and the caller's number when the phone network gives one. */
export interface CallStart {
  sessionId: string;
  language: string;
  callerId?: string;
}

/** What the caller hears first, written by the code: it says the assistant is an AI and that the call may be recorded. */
export type CallStarted = { status: 'ok'; sessionId: string; language: Language; greeting: string };

/** What the caller said, as speech recognition heard it, with the id the line gave the turn. */
export interface CallTurn {
  sessionId: string;
  /** Chosen by the line: asking again with the same id after a dropped connection gets the same answer, never a second turn. */
  turnId: string;
  message: string;
  /** The language speech recognition heard: the conversation follows a caller who switches. */
  language: string;
  /** When the caller cut the last reply short, the part of it they heard. */
  heard?: string;
}

/** The keys the caller pressed after being asked for their number. */
export interface KeypadEntry {
  sessionId: string;
  turnId: string;
  digits: string;
}

/** A line of a call's turn: maybe a short line to say while the tools run, then always the answer. */
export type CallEvent = { type: 'working'; say: string } | ({ type: 'answer' } & ChatAnswer);

export type CallStream = { status: 'streaming'; events: ReadableStream<Uint8Array> };

export interface CallEnd {
  sessionId: string;
  endedBy: string;
  seconds: number;
  voiceToVoiceMs?: unknown;
}

/** A tool call from an outside agent that runs its own conversation loop: another voice platform, or a server exposing the tools. */
export interface ToolRequest {
  sessionId: string;
  language: string;
  /** The caller's number as the phone network gave it. */
  callerId?: string;
  /** Digits the caller typed on the keypad, when there is no caller ID. */
  keypadPhone?: string;
  name: string;
  input: unknown;
}

type Invalid = { status: 'invalid'; problems: string[] };

/** The language the dashboard asked for, or the restaurant's own when it asked for none it speaks. */
function dashboardLanguage(language: unknown): Language | undefined {
  return isLanguage(language) ? language : undefined;
}

/** A failure in words that are safe to log: never a key, a number or a message from a guest. */
function describe(error: unknown): string {
  if (error instanceof ModelError) return `model ${error.kind}${error.status ? ` ${error.status}` : ''}`;
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`;
  return 'unknown error';
}

/** What is wrong with the ids of a call's turn, if anything. */
function callIdProblems(sessionId: unknown, turnId: unknown): string[] {
  const problems: string[] = [];
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) problems.push('sessionId must be 8 to 64 letters, digits, dashes or underscores');
  if (typeof turnId !== 'string' || !SESSION_ID.test(turnId)) problems.push('turnId must be 8 to 64 letters, digits, dashes or underscores');
  return problems;
}

/**
 * The conversation as the caller heard it. When they cut the last reply short,
 * the model sees what was said and not what was meant to be, as a person would
 * remember it.
 */
function cutShort(transcript: TranscriptEntry[], heard: string): TranscriptEntry[] {
  const last = transcript.at(-1);
  const said = heard.trim();
  if (!last || last.role !== 'assistant' || last.toolCalls.length > 0 || said === '' || said.length >= last.text.length) return transcript;
  return [...transcript.slice(0, -1), { ...last, text: said }];
}

interface TurnHooks {
  /** The line's id for the turn, kept with the answer so asking again returns it. */
  turnId?: string;
  onToolCalls?: (names: readonly string[]) => void;
  /** The short line said while the tools ran, for the log. */
  working?: () => string | undefined;
}

/**
 * One restaurant. Cloudflare runs exactly one instance of this object per
 * restaurant, in the European Union, and it handles requests one at a time:
 * that is what makes a double booking impossible rather than unlikely.
 */
export class Restaurant extends DurableObject<Env> {
  readonly #engine: BookingEngine;
  protected readonly store: SqlStore;
  readonly #conversations: Conversations;
  /** Turns of one conversation run in order, even when a guest sends two messages while the model is thinking. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
    this.#conversations = new Conversations(ctx.storage.sql);
    this.#engine = new BookingEngine(DEMO_RESTAURANT, this.store, { now: () => this.now(), ids: randomIds });
  }

  /** The restaurant's clock: the real one, except in a demo restaurant, whose evening keeps its own time. */
  protected now(): Date {
    return new Date();
  }

  /** The OpenRouter key the assistant answers with. The public demo has a key of its own, with its own spending limit. */
  protected modelKey(): string | undefined {
    return this.env.OPENROUTER_API_KEY;
  }

  /** Called after every answered turn, with what it cost: the public demo counts its spending here. */
  protected async turnCompleted(_result: TurnResult): Promise<void> {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const problems: string[] = [];
    if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId)) {
      problems.push('sessionId must be 8 to 64 letters, digits, dashes or underscores');
    }
    if (typeof request.message !== 'string') problems.push('message must be text');
    if (request.channel !== 'web' && request.channel !== 'whatsapp') problems.push('channel must be web or whatsapp');
    if (!isLanguage(request.language)) problems.push('language must be fr, en or es');
    let whatsappPhone: string | undefined;
    if (request.channel === 'whatsapp') {
      whatsappPhone = typeof request.phone === 'string' ? normalizePhone(request.phone) : undefined;
      if (!whatsappPhone) problems.push('a WhatsApp conversation needs the sender’s number');
    }
    if (problems.length > 0) return { status: 'invalid', problems };
    const apiKey = this.modelKey();
    if (!apiKey) return { status: 'not_configured' };
    const language = request.language as Language;

    return this.#serial(request.sessionId, async (): Promise<ChatResponse> => {
      const stored = this.#conversations.get(request.sessionId);
      if (stored && stored.channel !== request.channel) return { status: 'invalid', problems: ['this session belongs to another channel'] };
      const phone = whatsappPhone ?? stored?.phone;
      const source: PhoneSource | undefined = whatsappPhone ? 'whatsapp' : stored?.phoneSource;
      const session: Session = {
        id: request.sessionId,
        channel: request.channel,
        language,
        ...(phone && source ? { phone: { e164: phone, source } } : {}),
      };
      return this.#turn(session, stored?.transcript ?? [], request.message, apiKey);
    });
  }

  /**
   * The number typed in the web chat's own field, never one written in the
   * conversation. The turn then goes on by itself, as if the guest had said
   * "done": the booking waiting for the number is made, or the request passed
   * to the team gets it, and the answer says so. Without a model key the
   * number is only kept.
   */
  async setPhone(sessionId: string, phone: string): Promise<PhoneResponse | Invalid> {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { status: 'invalid', problems: ['unknown session'] };
    const e164 = typeof phone === 'string' ? normalizePhone(phone) : undefined;
    if (!e164) return { status: 'invalid', problems: ['the number cannot be read: write it like 06 12 34 56 78 or +44 7700 900123'] };
    return this.#serial(sessionId, async (): Promise<PhoneResponse | Invalid> => {
      const stored = this.#conversations.get(sessionId);
      if (!stored) return { status: 'invalid', problems: ['unknown session'] };
      if (stored.channel !== 'web') return { status: 'invalid', problems: ['only the web chat takes a number from its form'] };
      this.#conversations.save({ ...stored, phone: e164, phoneSource: 'form', updatedAt: new Date().toISOString() });
      const session: Session = { id: sessionId, channel: 'web', language: stored.language, phone: { e164, source: 'form' } };
      // The team may already have been asked to call back, before the number was known.
      this.#engine.addPhoneToCallbacks(session);
      const apiKey = this.modelKey();
      if (!apiKey) return { status: 'ok', phone: formatPhone(e164) };
      const turn = await this.#turn(session, stored.transcript, PHONE_ENTERED, apiKey);
      return { ...turn, phone: formatPhone(e164) };
    });
  }

  /** One turn with the model, kept in the conversation and in the log the owner reads. */
  async #turn(session: Session, transcript: TranscriptEntry[], message: string, apiKey: string, hooks: TurnHooks = {}): Promise<ChatAnswer> {
    // The phone may use a faster model than the chat, and waits less for a stalled one: a caller is on the line.
    const voice = session.channel === 'voice';
    const modelId = voice && this.env.VOICE_MODEL ? this.env.VOICE_MODEL : this.env.MODEL;
    const model = openRouterModel({ apiKey, model: modelId, ...(voice ? { timeoutMs: VOICE_MODEL_TIMEOUT_MS, maxRetries: 1 } : {}) });
    const result = await respond(this.#engine, model, session, transcript, message, {
      onError: (error) => console.error('Maître turn failed:', describe(error)),
      ...(hooks.onToolCalls ? { onToolCalls: hooks.onToolCalls } : {}),
    });
    const answer: ChatAnswer = { status: 'ok', reply: result.reply, outcome: result.outcome, ...turnEffects(result.tools) };
    const now = new Date().toISOString();
    this.#conversations.save({
      id: session.id,
      channel: session.channel,
      language: session.language,
      ...(session.phone ? { phone: session.phone.e164, phoneSource: session.phone.source } : {}),
      transcript: result.transcript,
      updatedAt: now,
      ...(hooks.turnId ? { lastTurn: { id: hooks.turnId, answer } } : {}),
    });
    const typedPhone = message === PHONE_ENTERED || message === KEYPAD_ENTERED;
    const working = hooks.working?.();
    this.#conversations.log({
      ...this.#turnLog(session, typedPhone ? '' : message, result, now),
      ...(typedPhone ? { phoneEntered: true as const } : {}),
      ...(working ? { working } : {}),
    });
    await this.turnCompleted(result);
    await this.#keepTidy();
    return answer;
  }

  /**
   * A call begins. The voice agent opened the session; the number comes from
   * the phone network when it gives one, never from what the caller says.
   * Starting the same call again changes nothing and gives the same greeting.
   */
  async startCall(request: CallStart): Promise<CallStarted | Invalid> {
    const problems: string[] = [];
    if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId)) {
      problems.push('sessionId must be 8 to 64 letters, digits, dashes or underscores');
    }
    if (!isLanguage(request.language)) problems.push('language must be fr, en or es');
    if (problems.length > 0) return { status: 'invalid', problems };
    const language = request.language as Language;
    return this.#serial(request.sessionId, async (): Promise<CallStarted | Invalid> => {
      const stored = this.#conversations.get(request.sessionId);
      if (stored && stored.channel !== 'voice') return { status: 'invalid', problems: ['this session belongs to another channel'] };
      if (!stored) {
        const callerId = typeof request.callerId === 'string' ? normalizePhone(request.callerId) : undefined;
        const now = new Date().toISOString();
        this.#conversations.save({
          id: request.sessionId,
          channel: 'voice',
          language,
          ...(callerId ? { phone: callerId, phoneSource: 'caller_id' as const } : {}),
          transcript: [],
          updatedAt: now,
        });
        this.#conversations.startCall({ sessionId: request.sessionId, startedAt: now, language });
        await this.#keepTidy();
      }
      const spoken = stored?.language ?? language;
      return { status: 'ok', sessionId: request.sessionId, language: spoken, greeting: messages(spoken).greeting(this.#engine.config.name, 'voice') };
    });
  }

  /**
   * One turn of a call, as a stream: a short line to say as soon as the model
   * reaches for its tools, so the caller is never left in silence, then the
   * answer. The turn is kept under the line's id, so a line that lost the
   * connection and asks again gets the same answer instead of a second turn.
   */
  async callTurn(request: CallTurn): Promise<CallStream | Invalid | { status: 'not_configured' }> {
    const problems = callIdProblems(request.sessionId, request.turnId);
    if (typeof request.message !== 'string' || request.message.length > MAX_SPOKEN) problems.push(`message must be text of at most ${MAX_SPOKEN} characters`);
    if (!isLanguage(request.language)) problems.push('language must be fr, en or es');
    if (request.heard !== undefined && (typeof request.heard !== 'string' || request.heard.length > MAX_SPOKEN)) problems.push('heard must be text');
    if (problems.length > 0) return { status: 'invalid', problems };
    const apiKey = this.modelKey();
    if (!apiKey) return { status: 'not_configured' };
    if (this.#conversations.get(request.sessionId)?.channel !== 'voice') return { status: 'invalid', problems: ['unknown call'] };
    const language = request.language as Language;

    return this.#callStream(request.sessionId, language, async (send) => {
      const stored = this.#conversations.get(request.sessionId);
      if (!stored) throw new Error('The call vanished between its check and its turn');
      if (stored.lastTurn?.id === request.turnId) return send({ type: 'answer', ...(stored.lastTurn.answer as ChatAnswer) });
      const transcript = request.heard ? cutShort(stored.transcript, request.heard) : stored.transcript;
      const session: Session = {
        id: request.sessionId,
        channel: 'voice',
        language,
        ...(stored.phone && stored.phoneSource ? { phone: { e164: stored.phone, source: stored.phoneSource } } : {}),
      };
      const answer = await this.#turn(session, transcript, request.message, apiKey, this.#workingLine(request.turnId, language, send));
      send({ type: 'answer', ...answer });
    });
  }

  /**
   * The number the caller typed on the keypad, then the hash key. The turn goes
   * on by itself, as on the web chat: the booking waiting for the number is
   * made, or the request passed to the team gets it. A number that cannot be
   * read is asked for again, in words the caller hears.
   */
  async keypad(request: KeypadEntry): Promise<CallStream | Invalid | { status: 'not_configured' }> {
    const problems = callIdProblems(request.sessionId, request.turnId);
    if (typeof request.digits !== 'string' || !/^[0-9*#]{1,24}$/.test(request.digits)) problems.push('digits must be 1 to 24 keypad keys');
    if (problems.length > 0) return { status: 'invalid', problems };
    const apiKey = this.modelKey();
    if (!apiKey) return { status: 'not_configured' };
    const first = this.#conversations.get(request.sessionId);
    if (first?.channel !== 'voice') return { status: 'invalid', problems: ['unknown call'] };

    return this.#callStream(request.sessionId, first.language, async (send) => {
      const stored = this.#conversations.get(request.sessionId);
      if (!stored) throw new Error('The call vanished between its check and its turn');
      if (stored.lastTurn?.id === request.turnId) return send({ type: 'answer', ...(stored.lastTurn.answer as ChatAnswer) });
      const now = new Date().toISOString();
      const e164 = normalizePhone(request.digits.replace(/#+$/, ''));
      if (!e164) {
        const answer: ChatAnswer = {
          status: 'ok',
          reply: messages(stored.language).keypadUnreadable(),
          outcome: 'keypad_unreadable',
          booked: [],
          passedToTeam: false,
          askForPhone: true,
        };
        this.#conversations.save({ ...stored, updatedAt: now, lastTurn: { id: request.turnId, answer } });
        return send({ type: 'answer', ...answer });
      }
      this.#conversations.save({ ...stored, phone: e164, phoneSource: 'keypad', updatedAt: now });
      const session: Session = { id: request.sessionId, channel: 'voice', language: stored.language, phone: { e164, source: 'keypad' } };
      // The team may already have been asked to call back, before the number was known.
      this.#engine.addPhoneToCallbacks(session);
      const answer = await this.#turn(session, stored.transcript, KEYPAD_ENTERED, apiKey, this.#workingLine(request.turnId, stored.language, send));
      send({ type: 'answer', ...answer });
    });
  }

  /**
   * The call is over: how long it lasted, who ended it and how fast each answer
   * came, for the dashboard. When the line hangs up on its own, the answer has
   * the last words to say first, in the caller's language.
   */
  async endCall(request: CallEnd): Promise<{ status: 'ok'; say: string } | Invalid> {
    const problems: string[] = [];
    if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId)) problems.push('unknown call');
    if (!(CALL_ENDINGS as readonly string[]).includes(request.endedBy)) problems.push(`endedBy must be one of ${CALL_ENDINGS.join(', ')}`);
    if (typeof request.seconds !== 'number' || !Number.isFinite(request.seconds) || request.seconds < 0 || request.seconds > MAX_CALL_SECONDS) {
      problems.push('seconds must be the length of the call');
    }
    if (problems.length > 0) return { status: 'invalid', problems };
    const stored = this.#conversations.get(request.sessionId);
    if (stored?.channel !== 'voice' || !this.#conversations.call(request.sessionId)) return { status: 'invalid', problems: ['unknown call'] };
    const measured = Array.isArray(request.voiceToVoiceMs) ? request.voiceToVoiceMs : [];
    const voiceToVoiceMs = measured.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= 60_000).map(Math.round);
    const endedBy = request.endedBy as CallEndedBy;
    this.#conversations.endCall(request.sessionId, { endedAt: new Date().toISOString(), seconds: Math.round(request.seconds), endedBy, voiceToVoiceMs });
    const say = endedBy === 'silence' || endedBy === 'time_limit' || endedBy === 'paused' ? messages(stored.language).callEnding(endedBy) : '';
    return { status: 'ok', say };
  }

  async recentCalls(limit: number): Promise<CallLog[]> {
    return this.#conversations.recentCalls(Number.isInteger(limit) ? limit : 50);
  }

  /** The hooks that say a short line once, the first time the model reaches for its tools in a turn. */
  #workingLine(turnId: string, language: Language, send: (event: CallEvent) => void): TurnHooks {
    let working: string | undefined;
    return {
      turnId,
      onToolCalls: (names) => {
        if (working !== undefined) return;
        working = messages(language).working(errandOf(names));
        send({ type: 'working', say: working });
      },
      working: () => working,
    };
  }

  /**
   * A call's turn as a stream of JSON lines, run after the turns before it. A
   * line that hangs up stops reading; the turn still finishes and is kept, and
   * a failure the turn did not handle still ends with words the caller hears.
   */
  #callStream(sessionId: string, language: Language, run: (send: (event: CallEvent) => void) => Promise<void>): CallStream {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event: CallEvent): void => {
      writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => undefined);
    };
    const done = this.#serial(sessionId, async () => {
      try {
        await run(send);
      } catch (error) {
        console.error('Maître call turn failed:', describe(error));
        send({ type: 'answer', status: 'ok', reply: messages(language).failureRetry(), outcome: 'failed_retry', booked: [], passedToTeam: false, askForPhone: false });
      } finally {
        await writer.close().catch(() => undefined);
      }
    });
    this.ctx.waitUntil(done);
    return { status: 'streaming', events: readable };
  }

  /** One tool call for an outside agent, with the number from the phone network or the keypad. */
  async tool(request: ToolRequest): Promise<ToolOutput> {
    if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId) || !isLanguage(request.language)) {
      return { status: 'invalid_input', problems: ['sessionId and language are required'] };
    }
    if (typeof request.name !== 'string' || request.name.length > 40) return { status: 'unknown_tool' };
    const keypad = request.keypadPhone ? normalizePhone(request.keypadPhone) : undefined;
    const callerId = request.callerId ? normalizePhone(request.callerId) : undefined;
    const phone = keypad ? { e164: keypad, source: 'keypad' as const } : callerId ? { e164: callerId, source: 'caller_id' as const } : undefined;
    const session: Session = { id: request.sessionId, channel: 'voice', language: request.language, ...(phone ? { phone } : {}) };
    const output = runTool(this.#engine, session, request.name, request.input, (error) => console.error('Maître tool failed:', describe(error)));
    // A caller without caller ID types the number on the keypad: requests made before then get it too.
    if (phone) this.#engine.addPhoneToCallbacks(session);
    await this.#keepTidy();
    return output;
  }

  async serviceDay(date: string, language: string): Promise<ServiceDay | Invalid> {
    if (!isLanguage(language)) return { status: 'invalid', problems: ['language must be fr, en or es'] };
    try {
      return this.#engine.serviceDay(date, language);
    } catch {
      return { status: 'invalid', problems: ['date must be a calendar date written YYYY-MM-DD'] };
    }
  }

  // The staff actions answer in the dashboard's language: the booking they return, and the times offered when one fails.
  async staffBook(request: StaffBookRequest): Promise<StaffBookResult> {
    return this.#engine.staffBook(request);
  }

  async staffCancel(reference: string, language?: string): Promise<StaffActionResult> {
    return this.#engine.staffCancel(reference, dashboardLanguage(language));
  }

  async markNoShow(reference: string, language?: string): Promise<StaffActionResult> {
    return this.#engine.markNoShow(reference, dashboardLanguage(language));
  }

  async markArrived(reference: string, language?: string): Promise<StaffActionResult> {
    return this.#engine.markArrived(reference, dashboardLanguage(language));
  }

  async seat(reference: string, table?: string, language?: string): Promise<TableActionResult> {
    return this.#engine.seat(reference, table, dashboardLanguage(language));
  }

  async markLeft(reference: string, language?: string): Promise<StaffActionResult> {
    return this.#engine.markLeft(reference, dashboardLanguage(language));
  }

  async moveTable(reference: string, table: string, language?: string): Promise<TableActionResult> {
    return this.#engine.moveTable(reference, table, dashboardLanguage(language));
  }

  async completeCallback(id: string): Promise<{ status: 'done' } | { status: 'not_found' }> {
    return this.#engine.completeCallback(id);
  }

  async recentTurns(limit: number): Promise<TurnLog[]> {
    return this.#conversations.recent(Number.isInteger(limit) ? limit : 50);
  }

  /**
   * Expired holds are already ignored when tables are counted; the alarm only
   * clears them away. It also deletes what is past the retention period:
   * conversations, bookings for days long gone and old requests to call back.
   */
  override async alarm(): Promise<void> {
    this.#engine.purgeExpiredHolds();
    this.#engine.purgeOlderThan(RETENTION_DAYS);
    this.#conversations.purgeBefore(new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString());
    const next = this.store.hasHolds() ? DEMO_RESTAURANT.holdMinutes * 60_000 : DAY_MS;
    await this.ctx.storage.setAlarm(Date.now() + next);
  }

  async #keepTidy(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DEMO_RESTAURANT.holdMinutes * 60_000);
    }
  }

  #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.then(work, work);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return current;
  }

  #turnLog(session: Session, guest: string, result: TurnResult, at: string): TurnLog {
    return {
      at,
      sessionId: session.id,
      channel: session.channel,
      language: session.language,
      guest: guest.slice(0, 2000),
      reply: result.reply,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      modelCalls: result.modelCalls,
      usage: result.usage,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      tools: result.tools.map((tool) => ({ name: tool.name, status: String(tool.output.status) })),
      corrections: result.corrections,
    };
  }
}
