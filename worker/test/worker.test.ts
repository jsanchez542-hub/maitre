import { env, reset, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localNow } from '../../src/calendar.js';
import { parseDay, resolveDate } from '../../src/dates.js';
import { restaurantStub } from '../src/env.js';
import worker from '../src/index.js';
import { SqlStore } from '../src/sql-store.js';

const BASE = 'https://maitre.test/v1/restaurants/demo';
const AGENT = { authorization: 'Bearer test-agent-token', 'content-type': 'application/json' };
const STAFF = { authorization: 'Bearer test-staff-token', 'content-type': 'application/json' };
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** A day of next week in Paris: open, and inside the booking window whenever the tests run. */
function nextWeek(weekday: 'thursday' | 'friday' | 'saturday'): string {
  const spec = parseDay(`${weekday} next week`);
  const resolved = spec && resolveDate(spec, localNow(new Date(), 'Europe/Paris').date);
  if (!resolved || !resolved.ok) throw new Error(`could not work out ${weekday} next week`);
  return resolved.date;
}

function tool(sessionId: string, name: string, input: unknown, callerId = '+33611111111') {
  return SELF.fetch(`${BASE}/tools/${name}`, {
    method: 'POST',
    headers: AGENT,
    body: JSON.stringify({ sessionId, language: 'fr', callerId, input }),
  });
}

function staffBook(body: Record<string, unknown>) {
  return SELF.fetch(`${BASE}/staff/bookings`, { method: 'POST', headers: STAFF, body: JSON.stringify(body) });
}

function stub() {
  const restaurant = restaurantStub(env, 'demo');
  if (!restaurant) throw new Error('the test config must set DATA_JURISDICTION');
  return restaurant;
}

interface StaffDay {
  bookings: Record<string, unknown>[];
  callbacks: { open: number; list: Record<string, unknown>[] };
}

async function staffDay(date: string): Promise<StaffDay> {
  return (await (await SELF.fetch(`${BASE}/day?date=${date}&language=fr`, { headers: STAFF })).json()) as StaffDay;
}

interface ChatAnswer {
  status: string;
  reply: string;
  outcome: string;
  askForPhone: boolean;
  problems?: string[];
}

async function chat(body: Record<string, unknown>): Promise<{ code: number; answer: ChatAnswer }> {
  const response = await SELF.fetch(`${BASE}/chat`, { method: 'POST', headers: AGENT, body: JSON.stringify(body) });
  return { code: response.status, answer: (await response.json()) as ChatAnswer };
}

type Message = { role: string; content: string | null };
type Answer = object | ((messages: Message[]) => object);

/** OpenRouter as the tests play it: answers in order, each able to read the conversation it was sent. */
function fakeOpenRouter(answers: Answer[]): { authorization: string | null; body: string }[] {
  const requests: { authorization: string | null; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`unexpected request to ${url}`);
    const body = String(init?.body);
    requests.push({ authorization: new Headers(init?.headers).get('authorization'), body });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('the model was called once too often');
    const message = typeof answer === 'function' ? answer((JSON.parse(body) as { messages: Message[] }).messages) : answer;
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1500, completion_tokens: 40, cost: 0.0004 } });
  });
  return requests;
}

const say = (content: string) => ({ content });
let callCount = 0;
const call = (name: string, input: object) => ({
  content: null,
  tool_calls: [{ id: `call-${(callCount += 1)}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
});

/** The table the last search set aside, read from the conversation the way a model would. */
function heldTable(messages: Message[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role === 'tool' && message.content?.includes('"holdId"')) return (JSON.parse(message.content) as { holdId: string }).holdId;
  }
  throw new Error('no table was held');
}

describe('the front door', () => {
  it('answers a health check', async () => {
    const response = await SELF.fetch('https://maitre.test/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses a missing or wrong token, the other side’s token, an unknown restaurant and an unknown route', async () => {
    const body = JSON.stringify({ sessionId: 'session-0001', language: 'fr', input: {} });
    expect((await SELF.fetch(`${BASE}/tools/opening_hours`, { method: 'POST', body })).status).toBe(401);
    expect(
      (await SELF.fetch(`${BASE}/tools/opening_hours`, { method: 'POST', body, headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    expect((await SELF.fetch(`${BASE}/tools/opening_hours`, { method: 'POST', body, headers: STAFF })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/day?date=2026-10-16`, { headers: AGENT })).status).toBe(401);
    expect((await SELF.fetch('https://maitre.test/v1/restaurants/someone-else/day', { headers: STAFF })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/delete-everything`, { method: 'POST', headers: STAFF })).status).toBe(405);
    expect((await SELF.fetch(`${BASE}/day`, { method: 'DELETE', headers: STAFF })).status).toBe(405);
  });

  it('refuses a body over 16 KB, whether it declares its length or arrives in chunks', async () => {
    const padding = 'x'.repeat(20_000);
    const declared = await SELF.fetch(`${BASE}/tools/opening_hours`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ sessionId: 'session-0001', language: 'fr', input: { padding } }),
    });
    expect(declared.status).toBe(413);

    const half = new TextEncoder().encode(padding.slice(0, 10_000));
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(half);
        controller.enqueue(half);
        controller.close();
      },
    });
    const request = new IncomingRequest(`${BASE}/tools/opening_hours`, { method: 'POST', headers: AGENT, body: chunked });
    expect(request.headers.get('content-length')).toBeNull();
    expect((await worker.fetch(request, env)).status).toBe(413);
  });

  it('stays closed when a secret or the data location is missing, instead of running open', async () => {
    const day = () => new IncomingRequest(`${BASE}/day?date=2026-10-16`, { headers: STAFF });
    expect((await worker.fetch(day(), { ...env, STAFF_TOKEN: '' })).status).toBe(503);
    expect((await worker.fetch(day(), { ...env, DATA_JURISDICTION: '' })).status).toBe(503);
    expect((await worker.fetch(day(), { ...env, DATA_JURISDICTION: 'us' })).status).toBe(503);
  });

  it('answers that the chat is not configured rather than calling a model without a key', async () => {
    const request = new IncomingRequest(`${BASE}/chat`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ sessionId: 'session-0002', message: 'Bonjour', channel: 'web', language: 'fr' }),
    });
    const response = await worker.fetch(request, { ...env, OPENROUTER_API_KEY: '' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });

  it('checks a chat request before calling the model', async () => {
    const requests = fakeOpenRouter([]);
    const { code, answer } = await chat({ sessionId: 'short', message: 'Hola', channel: 'sms', language: 'de' });
    expect(code).toBe(400);
    expect(answer.problems).toHaveLength(3);
    expect((await chat({ sessionId: 'whatsapp-0000', message: 'Hola', channel: 'whatsapp', language: 'es' })).code).toBe(400);
    expect(requests).toHaveLength(0);
  });
});

describe('conversations', () => {
  it('takes a web booking over three messages, with the number from the chat’s own field', async () => {
    const friday = nextWeek('friday');
    const requests = fakeOpenRouter([
      call('find_table', { day: 'friday next week', time: '20:00', partySize: 4 }),
      say('J’ai une table pour 4 vendredi à 20 h. À quel nom, et avez-vous des allergies ?'),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Dupont', allergies: [] }),
      say('Il me manque votre numéro : écrivez-le dans le champ sous la conversation.'),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Dupont', allergies: [] }),
      say('C’est **réservé** — à vendredi !'),
    ]);
    const session = { sessionId: 'web-session-0001', channel: 'web', language: 'fr' };

    const first = await chat({ ...session, message: 'Bonsoir, une table pour 4 vendredi prochain à 20 h' });
    expect(first).toMatchObject({ code: 200, answer: { status: 'ok', askForPhone: false } });
    const second = await chat({ ...session, message: 'Dupont, pas d’allergies' });
    expect(second.answer).toMatchObject({ status: 'ok', askForPhone: true });

    const typed = await SELF.fetch(`${BASE}/sessions/web-session-0001/phone`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ phone: '06 55 55 55 55' }),
    });
    expect(await typed.json()).toEqual({ status: 'ok', phone: '+33 6 55 55 55 55' });

    const third = await chat({ ...session, message: 'C’est fait' });
    expect(third.answer.status).toBe('ok');
    expect(third.answer.reply).not.toMatch(/\*\*|—/);

    const day = await staffDay(friday);
    expect(day.bookings).toHaveLength(1);
    expect(day.bookings[0]).toMatchObject({ guestName: 'Dupont', channel: 'web', phoneSource: 'form', phone: '+33 6 55 55 55 55' });

    const turns = (await (await SELF.fetch(`${BASE}/conversations?limit=10`, { headers: STAFF })).json()) as {
      tools: object[];
      costUsd: number;
      guest: string;
    }[];
    expect(turns.map((turn) => turn.tools)).toEqual([
      [{ name: 'book_table', status: 'booked' }],
      [{ name: 'book_table', status: 'phone_required' }],
      [{ name: 'find_table', status: 'available' }],
    ]);
    for (const turn of turns) expect(turn.costUsd).toBeCloseTo(0.0008, 10);

    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.authorization).toBe('Bearer test-openrouter-key');
      expect(JSON.parse(request.body)).toMatchObject({ provider: { data_collection: 'deny' } });
      // The model never sees the guest's number, whichever way it was written.
      expect(request.body).not.toMatch(/55\D?55\D?55\D?55/);
    }
  });

  it('takes a WhatsApp booking with the number WhatsApp vouches for, and keeps the session on that channel', async () => {
    const saturday = nextWeek('saturday');
    const requests = fakeOpenRouter([
      call('find_table', { day: 'saturday next week', time: '12:30', partySize: 2 }),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Moreau', allergies: ['milk'] }),
      say('C’est noté pour samedi à 12 h 30.'),
    ]);
    const { answer } = await chat({
      sessionId: 'whatsapp-0001',
      channel: 'whatsapp',
      language: 'fr',
      phone: '+33677777777',
      message: 'Une table pour 2 samedi midi, au nom de Moreau, allergie au lait',
    });
    expect(answer).toMatchObject({ status: 'ok', askForPhone: false });

    const day = await staffDay(saturday);
    expect(day.bookings[0]).toMatchObject({ guestName: 'Moreau', channel: 'whatsapp', phoneSource: 'whatsapp', phone: '+33 6 77 77 77 77' });
    for (const request of requests) expect(request.body).not.toMatch(/77\D?77\D?77\D?77/);

    expect((await chat({ sessionId: 'whatsapp-0001', channel: 'web', language: 'fr', message: 'Bonjour' })).code).toBe(400);
    const typed = await SELF.fetch(`${BASE}/sessions/whatsapp-0001/phone`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ phone: '06 12 34 56 78' }),
    });
    expect(typed.status).toBe(400);
    expect(requests).toHaveLength(3);
  });

  it('asks a web guest for a number the team needs, and gives it to the request already made', async () => {
    fakeOpenRouter([
      call('hand_over', { reason: 'complaint', summary: 'Plat arrivé froid hier soir' }),
      say('Je transmets à l’équipe. Laissez votre numéro dans le champ sous la conversation pour qu’elle vous rappelle.'),
    ]);
    const { answer } = await chat({ sessionId: 'web-session-0002', channel: 'web', language: 'fr', message: 'Mon plat était froid hier soir' });
    expect(answer).toMatchObject({ status: 'ok', askForPhone: true });
    expect((await staffDay(nextWeek('friday'))).callbacks.list[0]).not.toHaveProperty('phone');

    await SELF.fetch(`${BASE}/sessions/web-session-0002/phone`, { method: 'POST', headers: AGENT, body: JSON.stringify({ phone: '06 99 99 99 99' }) });
    expect((await staffDay(nextWeek('friday'))).callbacks.list[0]).toMatchObject({ reason: 'complaint', phone: '+33 6 99 99 99 99' });
  });

  it('answers in its own words and leaves a callback for the staff when the model is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"error":"unavailable"}', { status: 503 }));
    const { answer } = await chat({
      sessionId: 'whatsapp-0002',
      channel: 'whatsapp',
      language: 'fr',
      phone: '+33688888888',
      message: 'Bonjour, je voudrais réserver',
    });
    expect(answer).toMatchObject({ status: 'ok', outcome: 'failed_handed_over' });
    expect((await staffDay(nextWeek('friday'))).callbacks.open).toBe(1);
  });
});

describe('booking through the Durable Object', () => {
  it('finds a table, books it with the caller’s number, and shows it to the staff', async () => {
    const friday = nextWeek('friday');
    const found = (await (await tool('voice-call-0001', 'find_table', { day: 'friday next week', time: '20:00', partySize: 4 })).json()) as Record<
      string,
      unknown
    >;
    expect(found).toMatchObject({ status: 'available', date: friday, time: '20:00' });

    const booked = (await (
      await tool('voice-call-0001', 'book_table', { holdId: found['holdId'], guestName: 'Dupont', allergies: ['nuts'] })
    ).json()) as Record<string, unknown>;
    expect(booked).toMatchObject({ status: 'booked', booking: { guestName: 'Dupont', allergies: ['nuts'] } });
    expect(JSON.stringify(booked)).not.toContain('611111111');

    const response = await SELF.fetch(`${BASE}/day?date=${friday}&language=fr`, { headers: STAFF });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const day = (await response.json()) as { totals: object; bookings: object[] };
    expect(day.totals).toMatchObject({ bookings: 1, covers: 4, withAllergies: 1 });
    expect(day.bookings[0]).toMatchObject({ phone: '+33 6 11 11 11 11', phoneSource: 'caller_id', channel: 'voice' });
  });

  it('gives the last table to exactly one of two guests asking at the same moment', async () => {
    const saturday = nextWeek('saturday');
    // Two tables seat six. The staff take one, which leaves one for two simultaneous callers.
    expect((await staffBook({ date: saturday, time: '20:00', partySize: 6, guestName: 'Martin' })).status).toBe(201);

    const answers = await Promise.all([
      tool('voice-call-1001', 'find_table', { day: saturday, time: '20:00', partySize: 6 }, '+33622222222'),
      tool('voice-call-1002', 'find_table', { day: saturday, time: '20:00', partySize: 6 }, '+33633333333'),
    ]);
    const statuses = await Promise.all(answers.map(async (answer) => ((await answer.json()) as { status: string }).status));
    expect(statuses.sort()).toEqual(['available', 'unavailable']);
  });

  it('answers 409 with other times when the staff ask for a slot that is full', async () => {
    const thursday = nextWeek('thursday');
    for (const guestName of ['Bernard', 'Petit']) {
      expect((await staffBook({ date: thursday, time: '20:30', partySize: 6, guestName })).status).toBe(201);
    }
    const full = await staffBook({ date: thursday, time: '20:30', partySize: 6, guestName: 'Durand' });
    expect(full.status).toBe(409);
    const body = (await full.json()) as { status: string; alternatives: { date: string; time: string }[] };
    expect(body.status).toBe('unavailable');
    expect(body.alternatives.length).toBeGreaterThan(0);
    expect(body.alternatives.some((slot) => slot.date === thursday && slot.time === '20:30')).toBe(false);
  });

  it('lets the staff take a booking by hand, refuses a no-show before the guest is due, and cancels it', async () => {
    const thursday = nextWeek('thursday');
    const created = (await (await staffBook({ date: thursday, time: '12:30', partySize: 2, guestName: 'Leroy', phone: '06 44 44 44 44' })).json()) as {
      booking: { reference: string; phone: string };
    };
    expect(created.booking.phone).toBe('+33 6 44 44 44 44');

    const reference = created.booking.reference;
    expect((await SELF.fetch(`${BASE}/staff/bookings/${reference}/no-show`, { method: 'POST', headers: STAFF })).status).toBe(409);
    expect((await SELF.fetch(`${BASE}/staff/bookings/${reference}/cancel`, { method: 'POST', headers: STAFF })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/staff/bookings/NOPE42/cancel`, { method: 'POST', headers: STAFF })).status).toBe(404);
  });
});

describe('the SQLite store', () => {
  it('undoes every write of a transaction that fails halfway', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const store = new SqlStore(state.storage);
      expect(() =>
        store.transaction((tx) => {
          tx.saveCallback({
            id: 'cb-1',
            sessionId: 'session-0003',
            channel: 'web',
            language: 'fr',
            reason: 'other',
            summary: 'test',
            status: 'open',
            createdAt: new Date().toISOString(),
          });
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(store.transaction((tx) => tx.callback('cb-1'))).toBeUndefined();
    });
  });

  it('refuses two bookings with the same reference or the same hold, below the engine', async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      new SqlStore(state.storage);
      const insert = (id: string, reference: string, holdId: string) =>
        state.storage.sql.exec(
          `INSERT INTO bookings (id, reference, hold_id, date, time, phone, data) VALUES (?, ?, ?, '1999-01-01', '20:00', NULL, '{}')`,
          id,
          reference,
          holdId,
        );
      insert('one', 'SAMREF', 'hold-one');
      expect(() => insert('two', 'SAMREF', 'hold-two')).toThrow();
      expect(() => insert('three', 'OTHREF', 'hold-one')).toThrow();
    });
  });

  it('clears expired holds when its alarm rings, and sets the next one', async () => {
    const restaurant = stub();
    await runInDurableObject(restaurant, async (_instance, state) => {
      new SqlStore(state.storage);
      state.storage.sql.exec(
        `INSERT INTO holds (id, session_id, date, expires_at, data) VALUES ('old-hold', 'session-0004', '1999-01-01', ?, '{}')`,
        Date.now() - 1000,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(restaurant)).toBe(true);
    await runInDurableObject(restaurant, async (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT id FROM holds`).toArray()).toEqual([]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
