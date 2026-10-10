import { DurableObject } from 'cloudflare:workers';
import { respond, type TurnResult } from '../../src/agent/agent.js';
import { ModelError } from '../../src/agent/model.js';
import { openRouterModel } from '../../src/agent/providers/openai.js';
import { DEMO_RESTAURANT } from '../../src/demo/restaurant.js';
import {
  BookingEngine,
  type ServiceDay,
  type Session,
  type StaffActionResult,
  type StaffBookRequest,
  type StaffBookResult,
} from '../../src/engine.js';
import { isLanguage, type Language } from '../../src/i18n/index.js';
import { randomIds } from '../../src/ids.js';
import { formatPhone, normalizePhone } from '../../src/phone.js';
import type { PhoneSource } from '../../src/store.js';
import { runTool, type ToolOutput } from '../../src/tools.js';
import { Conversations, RETENTION_DAYS, type TurnLog } from './conversations.js';
import type { Env } from './env.js';
import { SqlStore } from './sql-store.js';

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_MS = 86_400_000;

export interface ChatRequest {
  sessionId: string;
  message: string;
  channel: 'web' | 'whatsapp';
  language: string;
  /** For WhatsApp: the sender's number, which the channel vouches for. */
  phone?: string;
}

export type ChatResponse =
  | {
      status: 'ok';
      reply: string;
      outcome: string;
      /** The web chat should now show its phone field. */
      askForPhone: boolean;
    }
  | { status: 'invalid'; problems: string[] }
  | { status: 'not_configured' };

/** A tool call from the voice agent, which runs its own conversation loop. */
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

/** A failure in words that are safe to log: never a key, a number or a message from a guest. */
function describe(error: unknown): string {
  if (error instanceof ModelError) return `model ${error.kind}${error.status ? ` ${error.status}` : ''}`;
  if (error instanceof Error) return `${error.name}: ${error.message.slice(0, 200)}`;
  return 'unknown error';
}

/**
 * One restaurant. Cloudflare runs exactly one instance of this object per
 * restaurant, in the European Union, and it handles requests one at a time:
 * that is what makes a double booking impossible rather than unlikely.
 */
export class Restaurant extends DurableObject<Env> {
  readonly #engine: BookingEngine;
  readonly #store: SqlStore;
  readonly #conversations: Conversations;
  /** Turns of one conversation run in order, even when a guest sends two messages while the model is thinking. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new SqlStore(ctx.storage);
    this.#conversations = new Conversations(ctx.storage.sql);
    this.#engine = new BookingEngine(DEMO_RESTAURANT, this.#store, { now: () => new Date(), ids: randomIds });
  }

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
    const apiKey = this.env.OPENROUTER_API_KEY;
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
      const model = openRouterModel({ apiKey, model: this.env.MODEL });
      const result = await respond(this.#engine, model, session, stored?.transcript ?? [], request.message, {
        onError: (error) => console.error('Maître turn failed:', describe(error)),
      });
      const now = new Date().toISOString();
      this.#conversations.save({
        id: session.id,
        channel: session.channel,
        language,
        ...(phone ? { phone } : {}),
        ...(source ? { phoneSource: source } : {}),
        transcript: result.transcript,
        updatedAt: now,
      });
      this.#conversations.log(this.#turnLog(session, request.message, result, now));
      await this.#keepTidy();
      return {
        status: 'ok',
        reply: result.reply,
        outcome: result.outcome,
        askForPhone: result.tools.some((tool) => tool.output.status === 'phone_required' || tool.output['needsPhone'] === true),
      };
    });
  }

  /** The number typed in the web chat's own field, never one written in the conversation. */
  async setPhone(sessionId: string, phone: string): Promise<{ status: 'ok'; phone: string } | Invalid> {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { status: 'invalid', problems: ['unknown session'] };
    const e164 = typeof phone === 'string' ? normalizePhone(phone) : undefined;
    if (!e164) return { status: 'invalid', problems: ['the number cannot be read: write it like 06 12 34 56 78 or +44 7700 900123'] };
    return this.#serial(sessionId, async () => {
      const stored = this.#conversations.get(sessionId);
      if (!stored) return { status: 'invalid', problems: ['unknown session'] } as Invalid;
      if (stored.channel !== 'web') return { status: 'invalid', problems: ['only the web chat takes a number from its form'] } as Invalid;
      this.#conversations.save({ ...stored, phone: e164, phoneSource: 'form', updatedAt: new Date().toISOString() });
      // The team may already have been asked to call back, before the number was known.
      this.#engine.addPhoneToCallbacks({ id: sessionId, channel: 'web', language: stored.language, phone: { e164, source: 'form' } });
      return { status: 'ok' as const, phone: formatPhone(e164) };
    });
  }

  /** One tool call for the voice agent, with the number from the phone network or the keypad. */
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

  async staffBook(request: StaffBookRequest): Promise<StaffBookResult> {
    return this.#engine.staffBook(request);
  }

  async staffCancel(reference: string): Promise<StaffActionResult> {
    return this.#engine.staffCancel(reference);
  }

  async markNoShow(reference: string): Promise<StaffActionResult> {
    return this.#engine.markNoShow(reference);
  }

  async completeCallback(id: string): Promise<{ status: 'done' } | { status: 'not_found' }> {
    return this.#engine.completeCallback(id);
  }

  async recentTurns(limit: number): Promise<TurnLog[]> {
    return this.#conversations.recent(Number.isInteger(limit) ? limit : 50);
  }

  /**
   * Expired holds are already ignored when tables are counted; the alarm only
   * clears them away, along with conversations past their retention period.
   */
  override async alarm(): Promise<void> {
    this.#engine.purgeExpiredHolds();
    this.#conversations.purgeBefore(new Date(Date.now() - RETENTION_DAYS * DAY_MS).toISOString());
    const next = this.#store.hasHolds() ? DEMO_RESTAURANT.holdMinutes * 60_000 : DAY_MS;
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
