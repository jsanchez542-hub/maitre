import type { Page, Route } from '@playwright/test';
import { turnEvents } from '../../src/agent/agent.js';
import { DEMO_RESTAURANT, demoEvening, demoSuggestion, type DemoEvening } from '../../src/demo/index.js';
import {
  BookingEngine,
  MemoryStore,
  addDays,
  formatPhone,
  isLanguage,
  localNow,
  normalizePhone,
  randomIds,
  validateConfig,
  type Activity,
  type BusinessConfig,
  type Language,
  type Session,
} from '../../src/index.js';

/** The tests' instant: Friday 16 October at 20:05 in Bordeaux, in the middle of dinner. */
export const FRIDAY_EVENING = new Date('2026-10-16T18:05:00.000Z');

/** Turnstile as the tests see it: it vouches for the visitor at once, with nothing to click. */
const TURNSTILE = `window.turnstile = { render(container, options) { setTimeout(() => options.callback('test-token')); return 'widget'; }, remove() {} };`;

/** The assistant's lines in the tests. What they do in the engine is real; only the words are written here. */
const LINES: Record<'askName' | 'askPhone' | 'booked' | 'group' | 'called' | 'other', Record<Language, string>> = {
  askName: {
    fr: 'Une table pour 2 demain soir à 20 h 30 est libre. À quel nom ?',
    en: 'A table for 2 tomorrow evening at 8:30 pm is free. What name should it be under?',
    es: 'Hay una mesa para 2 mañana por la noche a las 20:30. ¿A qué nombre?',
  },
  askPhone: {
    fr: 'Merci. Saisissez votre numéro dans le champ sous la conversation, et je confirme la table.',
    en: 'Thank you. Type your number in the field below the chat, and I will confirm the table.',
    es: 'Gracias. Escriba su número en el campo bajo la conversación y confirmo la mesa.',
  },
  booked: { fr: 'C’est confirmé, à demain soir.', en: 'It’s confirmed, see you tomorrow evening.', es: 'Confirmado, hasta mañana por la noche.' },
  group: {
    fr: 'Je transmets votre demande à l’équipe, qui vous rappellera. Saisissez votre numéro dans le champ sous la conversation.',
    en: 'I am passing your request to the team, who will call you back. Type your number in the field below the chat.',
    es: 'Paso su solicitud al equipo, que le llamará. Escriba su número en el campo bajo la conversación.',
  },
  called: { fr: 'Merci, l’équipe vous rappelle sur ce numéro.', en: 'Thank you, the team will call you on that number.', es: 'Gracias, el equipo le llamará a ese número.' },
  other: {
    fr: 'Je peux vous trouver une table, ou répondre sur la carte et les horaires.',
    en: 'I can find you a table, or answer about the menu and the opening hours.',
    es: 'Puedo buscarle mesa, o responder sobre la carta y el horario.',
  },
};

interface Conversation {
  language: Language;
  holdId?: string;
  guestName?: string;
  phone?: string;
  passedOn?: boolean;
}

type Json = Record<string, unknown>;

/** What an owner may change from the dashboard, as the Worker lists it: the tables and the plan stay, bookings sit on them. */
const EDITABLE: readonly string[] = ['weekly', 'exceptions', 'menu', 'faq', 'minNoticeMinutes', 'maxAdvanceDays', 'maxPartySize'];
type Errand = { name: string; status: string };

/** A quiet restaurant's activity: a test writes the counts it needs. The sums are the core's, tested there. */
const QUIET: Omit<Activity, 'from' | 'to'> = {
  bookings: { made: 0, covers: 0, byChannel: { web: 0, whatsapp: 0, voice: 0, staff: 0 } },
  conversations: { written: 0, turns: 0, passedToTeam: 0 },
  calls: { answered: 0, duringService: 0, whileClosed: 0, minutes: 0, answerMs: { median: null, p90: null } },
};

/**
 * The live demo's API as the Worker answers it, on the real engine and the
 * day seeded at a fixed instant, with the assistant's words written in advance:
 * the page is tested against the contract without a model or a network.
 */
export class FakeDemo {
  evening: DemoEvening;
  readonly sandbox = 'test0123456789abcdef0123456789ab';
  /** An error to answer, once, instead of the next request of that kind: { error } with its status, as the Worker does. */
  readonly failNext: Partial<Record<'open' | 'chat' | 'call', { status: number; error: string }>> = {};
  /** The restaurant's settings as its owner left them, and each change it kept. A test may have it refuse the next one. */
  config: BusinessConfig;
  /**
   * The restaurant's engine on its own store: changed settings give it a new engine over the same bookings, as the
   * Worker builds one, so the bookings the new hours leave out are found as they are there.
   */
  engine: BookingEngine;
  #store = new MemoryStore();
  /** The language the restaurant's guests wrote in: French until a page opens the restaurant in its own. */
  #language: Language = 'fr';
  /** The language each opening named, as the page sent it. */
  readonly openedIn: unknown[] = [];
  readonly saved: Json[] = [];
  refuseSettings = false;
  /** What GET /v1/demo answers: open, taking calls, unless a test closes it. */
  status: { live: boolean; calls: { perRestaurant: number; maxSeconds: number } | null } = { live: true, calls: { perRestaurant: 3, maxSeconds: 240 } };
  /** The lines asked for, by language: a test reads them to see what the page asked. */
  readonly lines: Language[] = [];
  /** The assistant's log, oldest first, as the Worker keeps it: the chat writes its turns here, and a test may add some. */
  readonly turns: Json[] = [];
  readonly calls: Json[] = [];
  activity: Omit<Activity, 'from' | 'to'> = QUIET;
  readonly #conversations = new Map<string, Conversation>();

  /** The restaurant at `now`, the real time as the Worker would see it: Friday's dinner unless a test picks another. */
  constructor(readonly now: Date = FRIDAY_EVENING) {
    this.evening = demoEvening({ now, store: this.#store });
    this.engine = this.evening.engine;
    this.config = this.engine.config;
  }

  /** As the Worker seeds a new restaurant: the evening again, with its guests' requests in the page's language. */
  #reseed(language: Language): void {
    if (language === this.#language) return;
    this.#language = language;
    this.#store = new MemoryStore();
    this.evening = demoEvening({ now: this.now, store: this.#store, language });
    this.engine = this.evening.engine;
    this.config = this.engine.config;
  }

  async install(page: Page): Promise<void> {
    await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\//, (route) => route.fulfill({ contentType: 'text/javascript', body: TURNSTILE }));
    await page.route(/\/v1\/demo(?:\/|\?|$)/, (route) => this.#answer(route));
    // The films are the site's own files, kept out of git: here an empty one, which never plays, so the picture stays,
    // as on a slow connection.
    await page.route(/\/media\//, (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: '' }));
  }

  async #answer(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split('/').filter(Boolean).slice(2);
    const body = (request.postData() ? request.postDataJSON() : {}) as Json;
    const answer = (status: number, json: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    const failure = (kind: 'open' | 'chat' | 'call') => {
      const failed = this.failNext[kind];
      if (!failed) return undefined;
      delete this.failNext[kind];
      return answer(failed.status, { error: failed.error });
    };

    if (parts.length === 0) return answer(200, { ...this.status, now: this.#now(), today: localNow(this.now, DEMO_RESTAURANT.timeZone).date, ...this.#time() });
    if (parts.length === 1 && parts[0] === 'sandboxes') {
      const refused = failure('open');
      if (refused) return refused;
      this.openedIn.push(body['language']);
      if (isLanguage(body['language'])) this.#reseed(body['language']);
      return answer(201, { sandbox: this.sandbox, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), clock: this.#now(), ...this.#time(), calls: this.status.calls });
    }
    if (parts[1] !== this.sandbox) return answer(404, { error: 'not_found' });
    const [what, id, more] = parts.slice(2);
    const engine = this.engine;
    const language = (typeof body['language'] === 'string' ? body['language'] : (url.searchParams.get('language') ?? 'fr')) as Language;

    if (what === 'chat') return failure('chat') ?? answer(200, this.#chat(String(body['sessionId']), String(body['message']), language));
    // The pass for a room no test can reach: what the page does with the line ends at the connection.
    if (what === 'calls' && !id && request.method() === 'POST') {
      const refused = failure('call');
      if (refused) return refused;
      this.lines.push(language);
      return answer(201, { url: 'wss://test.livekit.cloud', token: 'pass', sessionId: `call-${this.lines.length}`, maxSeconds: this.status.calls?.maxSeconds ?? 240 });
    }
    if (what === 'sessions' && more === 'phone') {
      const phone = normalizePhone(String(body['phone'] ?? ''));
      if (!phone) return answer(400, { status: 'invalid', problems: ['the number cannot be read'] });
      return answer(200, this.#phone(id ?? '', phone));
    }
    // The clock is the real one: it is read, never moved.
    if (what === 'clock' && request.method() === 'GET') {
      return answer(200, { status: 'ok', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), clock: this.#now(), ...this.#time() });
    }
    if (what === 'day') return answer(200, engine.serviceDay(url.searchParams.get('date') ?? this.evening.day, language));
    // The latest first, as the Worker reads its log.
    if (what === 'conversations') return answer(200, [...this.turns].reverse());
    if (what === 'calls' && request.method() === 'GET') return answer(200, [...this.calls].reverse());
    if (what === 'config' && request.method() === 'GET') return answer(200, this.config);
    if (what === 'outside-hours') return answer(200, { bookings: engine.bookingsOutsideHours(language) });
    if (what === 'config' && request.method() === 'PUT') {
      const settings = body['settings'];
      if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return answer(400, { status: 'invalid', problems: ['settings must be an object'] });
      const outside = Object.keys(settings).filter((key) => !EDITABLE.includes(key));
      if (outside.length > 0) return answer(400, { status: 'invalid', problems: outside.map((key) => `${key} cannot be changed from the dashboard`) });
      if (this.refuseSettings) return answer(400, { status: 'invalid', problems: ['the settings are not in the expected shape'] });
      const next = { ...this.config, ...settings } as BusinessConfig;
      const problems = validateConfig(next);
      if (problems.length > 0) return answer(400, { status: 'invalid', problems });
      this.config = next;
      this.engine = new BookingEngine(next, this.#store, { now: () => this.evening.clock.now(), ids: randomIds });
      this.saved.push(settings as Json);
      return answer(200, { status: 'ok', config: next, outsideHours: this.engine.bookingsOutsideHours(language) });
    }
    if (what === 'activity') {
      const days = Number(url.searchParams.get('days') ?? '7');
      if (!Number.isInteger(days) || days < 1 || days > 90) return answer(400, { status: 'invalid', problems: ['days must be a whole number from 1 to 90'] });
      const to = localNow(this.evening.clock.now(), DEMO_RESTAURANT.timeZone).date;
      return answer(200, { from: addDays(to, -(days - 1)), to, ...this.activity });
    }
    if (what === 'staff' && id === 'callbacks') {
      const done = engine.completeCallback(more ?? '');
      return answer(done.status === 'done' ? 200 : 404, done);
    }
    if (what === 'staff' && id === 'bookings') {
      const [reference = '', action] = parts.slice(4);
      if (!action) return answer(201, engine.staffBook(body as unknown as Parameters<typeof engine.staffBook>[0]));
      // The Worker's own statuses: a refusal is an answer with its reason, not a failure.
      if (action === 'tables') {
        const tables = engine.freeTablesFor(reference);
        return answer({ ok: 200, not_found: 404, not_allowed: 409 }[tables.status], tables);
      }
      if (action === 'change') {
        const changed = engine.staffChange(reference, body as unknown as Parameters<typeof engine.staffChange>[1]);
        return answer({ booked: 200, invalid: 400, not_found: 404, not_allowed: 409, unavailable: 409, table_taken: 409 }[changed.status], changed);
      }
      if (action === 'confirm') {
        const confirmed = engine.staffConfirm(reference, language);
        return answer({ done: 200, not_found: 404, not_allowed: 409 }[confirmed.status], confirmed);
      }
      const table = typeof body['table'] === 'string' ? body['table'] : undefined;
      const result =
        action === 'arrived'
          ? engine.markArrived(reference, language)
          : action === 'seated'
            ? engine.seat(reference, table, language)
            : action === 'left'
              ? engine.markLeft(reference, language)
              : action === 'table'
                ? engine.moveTable(reference, table ?? '', language)
                : action === 'cancel'
                  ? engine.staffCancel(reference)
                  : engine.markNoShow(reference);
      return answer(200, result);
    }
    return answer(405, { error: 'method_or_route_not_allowed' });
  }

  #now(): string {
    return this.evening.clock.now().toISOString();
  }

  /** The service the panel opens on, and the table a guest could still book. */
  #time(): { day: string; suggestion: ReturnType<typeof demoSuggestion> } {
    return { day: this.evening.day, suggestion: demoSuggestion(this.now) };
  }

  #session(id: string, conversation: Conversation): Session {
    return { id, channel: 'web', language: conversation.language, ...(conversation.phone ? { phone: { e164: conversation.phone, source: 'form' as const } } : {}) };
  }

  turnOf(reply: string, extra: Partial<{ askForPhone: boolean; booked: Json[]; passedToTeam: boolean }> = {}): Json {
    return { status: 'ok', reply, outcome: 'answered', askForPhone: false, booked: [], passedToTeam: false, ...extra };
  }

  /**
   * One turn in the log, as the Worker writes it: what the guest said, what the engine was asked and answered, the
   * reply, and what the turn did (bookings, a request to the team) with the number the conversation knows.
   */
  #log(sessionId: string, language: Language, guest: string, reply: string, tools: Errand[], did: Json = {}, phoneEntered = false): void {
    const phone = this.#conversations.get(sessionId)?.phone;
    this.turns.push({
      at: this.#now(),
      sessionId,
      channel: 'web',
      language,
      guest,
      ...(phoneEntered ? { phoneEntered: true } : {}),
      reply,
      outcome: 'answered',
      latencyMs: 1800 + tools.length * 600,
      modelCalls: tools.length + 1,
      usage: {},
      costUsd: 0.0008 + tools.length * 0.0003,
      tools,
      corrections: [],
      ...did,
      ...(phone ? { phone: formatPhone(phone) } : {}),
    });
  }

  #chat(sessionId: string, message: string, language: Language): Json {
    const conversation = this.#conversations.get(sessionId) ?? { language };
    this.#conversations.set(sessionId, conversation);
    const session = this.#session(sessionId, conversation);
    const said = (reply: string, tools: Errand[], extra: Parameters<FakeDemo['turnOf']>[1] = {}) => {
      this.#log(sessionId, conversation.language, message, reply, tools, extra.passedToTeam ? { passedToTeam: true } : {});
      return this.turnOf(reply, extra);
    };
    if (/\b12\b/.test(message)) {
      const passed = this.engine.requestCallback(session, { reason: 'large_group', summary: message.slice(0, 200) });
      conversation.passedOn = true;
      return said(LINES.group[language], [{ name: 'hand_over', status: passed.status }], { askForPhone: true, passedToTeam: passed.status === 'recorded' });
    }
    if (/20[\s :h]*30|8:30/.test(message)) {
      const { date, time, partySize } = demoSuggestion(this.now);
      const found = this.engine.findTable(session, { date: { kind: 'date', date }, time, partySize });
      if (found.status === 'available') conversation.holdId = found.holdId;
      return said(LINES.askName[language], [{ name: 'find_table', status: found.status }]);
    }
    if (conversation.holdId && !conversation.guestName) {
      conversation.guestName = message.replace(/[^\p{L}\s'-]/gu, ' ').trim().split(/\s+/).pop() ?? message;
      return said(LINES.askPhone[language], [{ name: 'book_table', status: 'phone_required' }], { askForPhone: true });
    }
    return said(LINES.other[language], []);
  }

  #phone(sessionId: string, phone: string): Json {
    const conversation = this.#conversations.get(sessionId);
    if (!conversation) return { status: 'invalid', problems: ['unknown session'] };
    conversation.phone = phone;
    const session = this.#session(sessionId, conversation);
    const formatted = formatPhone(phone);
    if (conversation.passedOn) {
      this.engine.addPhoneToCallbacks(session);
      this.#log(sessionId, conversation.language, '', LINES.called[conversation.language], [], {}, true);
      return { ...this.turnOf(LINES.called[conversation.language]), phone: formatted };
    }
    if (!conversation.holdId || !conversation.guestName) return { ...this.turnOf(LINES.other[conversation.language]), phone: formatted };
    const result = this.engine.book(session, { holdId: conversation.holdId, guestName: conversation.guestName });
    const booked = result.status === 'booked' ? [{ reference: result.booking.reference, date: result.booking.date, time: result.booking.time, partySize: result.booking.partySize }] : [];
    const events = turnEvents([{ name: 'book_table', output: result }]);
    this.#log(sessionId, conversation.language, '', LINES.booked[conversation.language], [{ name: 'book_table', status: result.status }], events.booked.length > 0 ? { booked: events.booked } : {}, true);
    return { ...this.turnOf(LINES.booked[conversation.language], { booked }), phone: formatted };
  }
}
