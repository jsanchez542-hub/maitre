import { DurableObject } from 'cloudflare:workers';
import type { TurnResult } from '../../src/agent/agent.js';
import { DEMO_EVENING_AT, demoEvening } from '../../src/demo/evening.js';
import { normalizePhone } from '../../src/phone.js';
import { budgetStub, type Env } from './env.js';
import { Restaurant, type ChatResponse, type PhoneResponse } from './restaurant.js';

/**
 * The public demo, live: each visitor opens a restaurant of their own, the
 * Friday evening of the demo at 20:05 written into its own Durable Object, and
 * talks to the real assistant. What they book is on their dashboard and on no
 * one else's, and the whole restaurant is deleted a day later.
 *
 * Abuse is kept out in layers: Turnstile before a restaurant opens, a few
 * restaurants a day per visitor, a ceiling on the messages of each restaurant,
 * and the demo's spending counted against a daily and a monthly limit, under a
 * key of its own whose credit OpenRouter also caps. Past a limit the demo is
 * paused, and says so; it never runs open.
 */

/** How long a visitor's restaurant lives before it deletes itself. */
export const SANDBOX_HOURS = 24;
/** The longest message a visitor can send, in characters. */
export const MAX_DEMO_MESSAGE = 500;
/** Messages a restaurant takes in one minute: a person types slower than this. */
const MESSAGES_PER_MINUTE = 8;
/** How far a visitor can move the evening's clock on, in all: from 20:05 to 02:05. */
const MAX_ADVANCE_MINUTES = 6 * 60;

/** A demo restaurant's id: 128 random bits, base64url. Knowing it is what opens the restaurant. */
export const SANDBOX_ID = /^[A-Za-z0-9_-]{22}$/;

export function newSandboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const EXPIRES_AT = 'demo:expiresAt';
const ADVANCED_MS = 'demo:advancedMs';
const MESSAGES = 'demo:messages';

export type SandboxState = { status: 'ok'; expiresAt: string; clock: string } | { status: 'not_found' };
/** Why a demo turn did not run: the restaurant is gone, the visitor writes too fast or has used its messages, or the demo is paused. */
type Refusal = { status: 'not_found' } | { status: 'rate_limited' } | { status: 'sandbox_limit' } | { status: 'live_paused' };
export type DemoChatResponse = ChatResponse | Refusal;
export type DemoPhoneResponse = PhoneResponse | Invalid | Refusal;
type Invalid = { status: 'invalid'; problems: string[] };

interface MessageCount {
  total: number;
  minute: number;
  inMinute: number;
}

/** A whole number at least 0 from a setting, or undefined when it cannot be read. */
function setting(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(number) && number >= 0 ? number : undefined;
}

export class DemoRestaurant extends Restaurant {
  #expiresAt = 0;
  #advancedMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#expiresAt = (await ctx.storage.get<number>(EXPIRES_AT)) ?? 0;
      this.#advancedMs = (await ctx.storage.get<number>(ADVANCED_MS)) ?? 0;
    });
  }

  /** The evening's own time: Friday 16 October at 20:05, plus what the visitor moved it on. */
  protected override now(): Date {
    return new Date(Date.parse(DEMO_EVENING_AT) + this.#advancedMs);
  }

  protected override modelKey(): string | undefined {
    return this.env.DEMO_OPENROUTER_API_KEY;
  }

  protected override async turnCompleted(result: TurnResult): Promise<void> {
    if (result.costUsd !== undefined && result.costUsd > 0) await budgetStub(this.env)?.record(result.costUsd);
  }

  #open(): boolean {
    return this.#expiresAt > Date.now();
  }

  /** Writes the demo evening into this restaurant's database, once, and sets the day after which it deletes itself. */
  async open(): Promise<SandboxState> {
    if (this.#expiresAt === 0) {
      demoEvening({ store: this.store });
      this.#expiresAt = Date.now() + SANDBOX_HOURS * 3_600_000;
      await this.ctx.storage.put({ [EXPIRES_AT]: this.#expiresAt, [ADVANCED_MS]: 0 });
      await this.ctx.storage.setAlarm(this.#expiresAt);
    }
    return this.state();
  }

  async state(): Promise<SandboxState> {
    if (!this.#open()) return { status: 'not_found' };
    return { status: 'ok', expiresAt: new Date(this.#expiresAt).toISOString(), clock: this.now().toISOString() };
  }

  /** Moves the evening on: the dashboard's "move the clock on 15 minutes". */
  async advance(minutes: unknown): Promise<SandboxState | Invalid> {
    if (!this.#open()) return { status: 'not_found' };
    const total = this.#advancedMs / 60_000 + Number(minutes);
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || total > MAX_ADVANCE_MINUTES) {
      return { status: 'invalid', problems: [`minutes must be a whole number from 1, and the evening ends ${MAX_ADVANCE_MINUTES / 60} hours after 20:05`] };
    }
    this.#advancedMs = total * 60_000;
    await this.ctx.storage.put(ADVANCED_MS, this.#advancedMs);
    return this.state();
  }

  /** One turn of the visitor's conversation with the real assistant, within this restaurant's limits and the demo's budget. */
  async demoChat(request: { sessionId: string; message: string; language: string }): Promise<DemoChatResponse> {
    if (!this.#open()) return { status: 'not_found' };
    if (typeof request.message === 'string' && request.message.length > MAX_DEMO_MESSAGE) {
      return { status: 'invalid', problems: [`message must be at most ${MAX_DEMO_MESSAGE} characters`] };
    }
    const refused = await this.#mayTalk();
    if (refused) return refused;
    return this.chat({ sessionId: request.sessionId, message: request.message, language: request.language, channel: 'web' });
  }

  /** The number typed in the chat's field, and the turn it sets going, which counts as a message like any other. */
  async demoSetPhone(sessionId: string, phone: string): Promise<DemoPhoneResponse> {
    if (!this.#open()) return { status: 'not_found' };
    // A number that cannot be read is refused before it costs the visitor a message.
    if (typeof phone !== 'string' || !normalizePhone(phone)) return this.setPhone(sessionId, phone);
    const refused = await this.#mayTalk();
    if (refused) return refused;
    return this.setPhone(sessionId, phone);
  }

  /** Whether the visitor may have the assistant answer once more: this restaurant's limits, then the demo's budget. */
  async #mayTalk(): Promise<Refusal | undefined> {
    const limit = setting(this.env.DEMO_MESSAGES_PER_SANDBOX) ?? 0;
    const minute = Math.floor(Date.now() / 60_000);
    const count = (await this.ctx.storage.get<MessageCount>(MESSAGES)) ?? { total: 0, minute, inMinute: 0 };
    const inMinute = count.minute === minute ? count.inMinute : 0;
    if (count.total >= limit) return { status: 'sandbox_limit' };
    if (inMinute >= MESSAGES_PER_MINUTE) return { status: 'rate_limited' };
    const budget = budgetStub(this.env);
    if (!budget || (await budget.allowTurn()) !== 'ok') return { status: 'live_paused' };
    await this.ctx.storage.put(MESSAGES, { total: count.total + 1, minute, inMinute: inMinute + 1 } satisfies MessageCount);
    return undefined;
  }

  /** A day after it opened, the restaurant deletes everything it holds: bookings, conversations and numbers. */
  override async alarm(): Promise<void> {
    if (this.#expiresAt !== 0 && Date.now() >= this.#expiresAt) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.#expiresAt = 0;
      this.#advancedMs = 0;
      return;
    }
    if (this.#expiresAt !== 0) await this.ctx.storage.setAlarm(this.#expiresAt);
  }
}

interface Spent {
  period: string;
  usd: number;
}

/**
 * What the public demo has spent and who opened what, in one place. The day and
 * the month are UTC. Visitors are counted by a keyed hash of their address that
 * changes every day, never by the address itself.
 */
export class DemoBudget extends DurableObject<Env> {
  async allowSandbox(visitor: string): Promise<'ok' | 'too_many_sandboxes' | 'live_paused'> {
    if (await this.#paused()) return 'live_paused';
    const limit = setting(this.env.DEMO_SANDBOXES_PER_IP) ?? 0;
    const day = new Date().toISOString().slice(0, 10);
    const key = `visitor:${day}:${visitor}`;
    const opened = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (opened >= limit) return 'too_many_sandboxes';
    await this.ctx.storage.put(key, opened + 1);
    await this.#forgetOtherDays(day);
    return 'ok';
  }

  async allowTurn(): Promise<'ok' | 'live_paused'> {
    return (await this.#paused()) ? 'live_paused' : 'ok';
  }

  async record(usd: number): Promise<void> {
    if (!Number.isFinite(usd) || usd <= 0) return;
    const now = new Date().toISOString();
    for (const [key, period] of [
      ['spent:day', now.slice(0, 10)],
      ['spent:month', now.slice(0, 7)],
    ] as const) {
      const spent = (await this.ctx.storage.get<Spent>(key)) ?? { period, usd: 0 };
      await this.ctx.storage.put(key, { period, usd: (spent.period === period ? spent.usd : 0) + usd } satisfies Spent);
    }
  }

  /** Today's and this month's spending against the limits, for whoever looks after the demo. */
  async spending(): Promise<{ day: Spent; month: Spent; dailyLimit: number | null; monthlyLimit: number | null }> {
    const now = new Date().toISOString();
    const current = async (key: string, period: string): Promise<Spent> => {
      const spent = await this.ctx.storage.get<Spent>(key);
      return spent && spent.period === period ? spent : { period, usd: 0 };
    };
    return {
      day: await current('spent:day', now.slice(0, 10)),
      month: await current('spent:month', now.slice(0, 7)),
      dailyLimit: setting(this.env.DEMO_DAILY_USD) ?? null,
      monthlyLimit: setting(this.env.DEMO_MONTHLY_USD) ?? null,
    };
  }

  /** Past a limit, or with a limit that cannot be read, the demo pauses: it fails closed. */
  async #paused(): Promise<boolean> {
    const { day, month, dailyLimit, monthlyLimit } = await this.spending();
    return dailyLimit === null || monthlyLimit === null || day.usd >= dailyLimit || month.usd >= monthlyLimit;
  }

  async #forgetOtherDays(today: string): Promise<void> {
    const old = [...(await this.ctx.storage.list({ prefix: 'visitor:' })).keys()].filter((key) => !key.startsWith(`visitor:${today}:`));
    if (old.length > 0) await this.ctx.storage.delete(old);
  }
}

/** Whether Cloudflare Turnstile vouches for the token the visitor's browser got. */
export async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (token.length === 0 || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
  } catch {
    return false;
  }
}

/** A visitor as the budget counts them: a hash of their address, keyed by a secret and the day, so it cannot be traced back. */
export async function visitorKey(ip: string, secret: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}\n${secret}\n${ip}`));
  return [...new Uint8Array(digest)]
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
