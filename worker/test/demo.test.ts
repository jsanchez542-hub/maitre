import { env, reset, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetStub, demoStub } from '../src/env.js';

const DEMO = 'https://maitre.test/v1/demo';
const JSON_BODY = { 'content-type': 'application/json' };
const EVENING = '2026-10-16';
/** Friday 16 October 2026 at 20:05 in Bordeaux: the restaurant lives at the real time, and the tests fix it there. */
const FRIDAY_EVENING = '2026-10-16T18:05:00.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});

type Message = { role: string; content: string | null };
type Answer = object | ((messages: Message[]) => object);

/**
 * The network as the tests play it: Turnstile vouches (or not) for the visitor,
 * and OpenRouter answers in order. Nothing leaves the test.
 */
function fakeNetwork(options: { person?: boolean; answers?: Answer[] } = {}): { authorization: string | null; body: string }[] {
  const answers = [...(options.answers ?? [])];
  const requests: { authorization: string | null; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: options.person ?? true });
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

function heldTable(messages: Message[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role === 'tool' && message.content?.includes('"holdId"')) return (JSON.parse(message.content) as { holdId: string }).holdId;
  }
  throw new Error('no table was held');
}

async function open(ip = '203.0.113.7', language?: string): Promise<{ code: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(`${DEMO}/sandboxes`, {
    method: 'POST',
    headers: { ...JSON_BODY, 'cf-connecting-ip': ip },
    body: JSON.stringify({ turnstile: 'a-token-from-the-widget', ...(language ? { language } : {}) }),
  });
  return { code: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function opened(): Promise<string> {
  const { code, body } = await open();
  expect(code).toBe(201);
  return String(body['sandbox']);
}

function send(sandbox: string, path: string, body: object): Promise<Response> {
  return SELF.fetch(`${DEMO}/sandboxes/${sandbox}/${path}`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(body) });
}

async function day(sandbox: string, language = 'fr'): Promise<{ bookings: Record<string, unknown>[]; callbacks: { open: number } }> {
  const response = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/day?date=${EVENING}&language=${language}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { bookings: Record<string, unknown>[]; callbacks: { open: number } };
}

describe('the public demo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FRIDAY_EVENING));
  });

  it('opens a restaurant of its own for a person, at the real time, with the day’s service seeded around it', async () => {
    fakeNetwork();
    const { code, body } = await open();
    expect(code).toBe(201);
    expect(body['sandbox']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body).toMatchObject({ clock: FRIDAY_EVENING, day: EVENING });
    expect(Date.parse(String(body['expiresAt'])) - Date.now()).toBeGreaterThan(23 * 3_600_000);

    const evening = await day(String(body['sandbox']));
    expect(evening.bookings.map((booking) => booking['guestName'])).toEqual(expect.arrayContaining(['Moreau', 'Petit', 'Garcia', 'Fournier']));
    expect(evening.callbacks.open).toBe(2);
  });

  it('opens on the next service on the restaurant’s day off', async () => {
    fakeNetwork();
    // Monday 19 October at 15:00: Merrain is closed on Mondays.
    vi.setSystemTime(new Date('2026-10-19T13:00:00Z'));
    const { body } = await open();
    expect(body).toMatchObject({ clock: '2026-10-19T13:00:00.000Z', day: '2026-10-20' });
    const tuesday = (await (await SELF.fetch(`${DEMO}/sandboxes/${String(body['sandbox'])}/day?date=2026-10-20&language=fr`)).json()) as {
      bookings: Record<string, unknown>[];
    };
    expect(tuesday.bookings.length).toBeGreaterThan(0);
    expect(tuesday.bookings.every((booking) => booking['stage'] === 'expected')).toBe(true);
  });

  it('says the restaurant’s time and day before any restaurant is opened', async () => {
    fakeNetwork();
    expect(await (await SELF.fetch(DEMO)).json()).toMatchObject({ now: FRIDAY_EVENING, today: EVENING, day: EVENING });
  });

  it('refuses a script: Turnstile has to vouch for the visitor first', async () => {
    fakeNetwork({ person: false });
    expect(await open()).toMatchObject({ code: 403, body: { error: 'turnstile_failed' } });
  });

  it('lets one visitor open a few restaurants a day, and no more', async () => {
    fakeNetwork();
    for (let opened = 0; opened < 5; opened += 1) expect((await open('203.0.113.8')).code).toBe(201);
    expect(await open('203.0.113.8')).toMatchObject({ code: 429, body: { error: 'too_many_sandboxes' } });
    expect((await open('203.0.113.9')).code).toBe(201);
  });

  it('books with the real assistant and the demo’s own key, in that visitor’s restaurant and no one else’s', async () => {
    const requests = fakeNetwork({
      answers: [
        call('find_table', { day: 'today', time: '21:30', partySize: 2 }),
        (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Moulin', allergies: [] }),
        say('Il me manque votre numéro : saisissez-le dans le champ sous la conversation.'),
        (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Moulin', allergies: [] }),
        say('C’est réservé pour ce soir à 21 h 30. À tout à l’heure !'),
      ],
    });
    const mine = await opened();
    const theirs = await opened();
    const session = { sessionId: 'visitor-session-01', language: 'fr' };

    const asked = await send(mine, 'chat', { ...session, message: 'Une table pour deux ce soir à 21 h 30, au nom de Moulin.' });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toMatchObject({ status: 'ok', askForPhone: true, booked: [] });

    const typed = await send(mine, `sessions/${session.sessionId}/phone`, { phone: '06 39 98 00 31' });
    expect(typed.status).toBe(200);
    expect(await typed.json()).toMatchObject({
      status: 'ok',
      phone: '+33 6 39 98 00 31',
      askForPhone: false,
      booked: [{ date: EVENING, time: '21:30', partySize: 2 }],
    });

    expect((await day(mine)).bookings.find((booking) => booking['guestName'] === 'Moulin')).toMatchObject({ channel: 'web', phoneSource: 'form' });
    expect((await day(theirs)).bookings.some((booking) => booking['guestName'] === 'Moulin')).toBe(false);
    // The conversation as the dashboard reads it: who, and what the turn booked.
    const turns = (await (await SELF.fetch(`${DEMO}/sandboxes/${mine}/conversations`)).json()) as Record<string, unknown>[];
    expect(turns.find((turn) => turn['booked'])).toMatchObject({
      booked: [{ date: EVENING, time: '21:30', partySize: 2, guestName: 'Moulin' }],
      phone: '+33 6 39 98 00 31',
    });

    expect(requests).toHaveLength(5);
    for (const request of requests) expect(request.authorization).toBe('Bearer test-demo-openrouter-key');
    // What the demo spent is counted against its budget.
    const spending = await budgetStub(env)?.spending();
    expect(spending?.day.usd).toBeCloseTo(0.002, 10);
  });

  it('pauses past its budget, says so, and never calls the model or opens a restaurant then', async () => {
    const requests = fakeNetwork();
    const status = async () => (await (await SELF.fetch(DEMO)).json()) as Record<string, unknown>;
    // A page asks before showing the chat and the call button, without opening a restaurant.
    // At 20:05 tonight's 20:30 is within the hour's notice: the example is tomorrow's dinner.
    const suggestion = { date: '2026-10-17', time: '20:30', partySize: 2 };
    const time = { now: FRIDAY_EVENING, today: EVENING, day: EVENING, suggestion };
    // Calls are offered once a voice agent has checked in, with speech that works.
    expect(await status()).toEqual({ live: true, calls: null, ...time });
    const agent = { authorization: 'Bearer test-agent-token', 'content-type': 'application/json' };
    await SELF.fetch(`${DEMO}/voice/check-in`, { method: 'POST', headers: agent, body: JSON.stringify({ ready: true }) });
    expect(await status()).toEqual({ live: true, calls: { perRestaurant: 3, maxSeconds: 240 }, ...time });
    const sandbox = await opened();
    const budget = budgetStub(env);
    if (!budget) throw new Error('the test config must set DATA_JURISDICTION');
    await runInDurableObject(budget, async (_instance, state) => {
      await state.storage.put('spent:day', { period: new Date().toISOString().slice(0, 10), usd: 1 });
    });

    const paused = await send(sandbox, 'chat', { sessionId: 'visitor-session-02', message: 'Bonsoir', language: 'fr' });
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: 'live_paused' });
    expect(await open()).toMatchObject({ code: 503, body: { error: 'live_paused' } });
    expect(await status()).toEqual({ live: false, calls: null, ...time });
    expect(requests).toHaveLength(0);
  });

  it('keeps each restaurant to the pace a person writes at, and to a total', async () => {
    const requests = fakeNetwork();
    const sandbox = await opened();
    const restaurant = demoStub(env, sandbox);
    if (!restaurant) throw new Error('the test config must set DATA_JURISDICTION');
    const message = { sessionId: 'visitor-session-03', message: 'Bonsoir', language: 'fr' };

    await runInDurableObject(restaurant, async (_instance, state) => {
      await state.storage.put('demo:messages', { total: 3, minute: Math.floor(Date.now() / 60_000), inMinute: 8 });
    });
    const tooFast = await send(sandbox, 'chat', message);
    expect([tooFast.status, await tooFast.json()]).toEqual([429, { error: 'rate_limited' }]);

    await runInDurableObject(restaurant, async (_instance, state) => {
      await state.storage.put('demo:messages', { total: 60, minute: 0, inMinute: 0 });
    });
    const used = await send(sandbox, 'chat', message);
    expect([used.status, await used.json()]).toEqual([429, { error: 'sandbox_limit' }]);
    // A number that cannot be read costs nothing either.
    expect((await send(sandbox, `sessions/${message.sessionId}/phone`, { phone: 'pas un numéro' })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('keeps the real time, which nobody can move on, as in production', async () => {
    fakeNetwork();
    const sandbox = await opened();
    expect(await (await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/clock`)).json()).toMatchObject({ clock: FRIDAY_EVENING, day: EVENING });
    vi.setSystemTime(new Date('2026-10-16T18:20:00Z'));
    expect(await (await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/clock`)).json()).toMatchObject({ clock: '2026-10-16T18:20:00.000Z' });
    expect((await send(sandbox, 'clock', { minutes: 15 })).status).toBe(405);
  });

  it('runs the dashboard’s actions on the visitor’s restaurant, in the dashboard’s language', async () => {
    fakeNetwork();
    const sandbox = await opened();
    const bernard = (await day(sandbox, 'en')).bookings.find((booking) => booking['guestName'] === 'Bernard');
    const arrived = await send(sandbox, `staff/bookings/${String(bernard?.['reference'])}/arrived`, { language: 'en' });
    expect(arrived.status).toBe(200);
    expect(await arrived.json()).toMatchObject({ status: 'done' });
    expect((await day(sandbox)).bookings.find((booking) => booking['guestName'] === 'Bernard')).toMatchObject({ stage: 'arrived' });
  });

  it('lets the visitor change, confirm and place the restaurant’s bookings as its owner would', async () => {
    fakeNetwork();
    const sandbox = await opened();
    const expected = (await day(sandbox)).bookings.find((booking) => booking['stage'] === 'expected');
    const reference = String(expected?.['reference']);
    const free = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/staff/bookings/${reference}/tables`);
    expect(free.status).toBe(200);
    expect(await free.json()).toMatchObject({ status: 'ok' });
    expect(await (await send(sandbox, `staff/bookings/${reference}/confirm`, {})).json()).toMatchObject({ status: 'done', booking: { status: 'confirmed' } });
    expect(await (await send(sandbox, `staff/bookings/${reference}/change`, { notes: 'Table au calme' })).json()).toMatchObject({
      status: 'booked',
      booking: { notes: 'Table au calme' },
    });
  });

  it('writes its evening in the language the visitor opened it in', async () => {
    fakeNetwork();
    const { code, body } = await open('203.0.113.8', 'en');
    expect(code).toBe(201);
    const response = await SELF.fetch(`${DEMO}/sandboxes/${String(body['sandbox'])}/day?date=${EVENING}&language=en`);
    const day = (await response.json()) as { callbacks: { list: { summary: string }[] } };
    expect(day.callbacks.list.map((request) => request.summary)).toEqual([
      'Party of 9 for a birthday, Saturday 17 October, in the evening.',
      'Allergens not stated on the sheet for “Chocolate mousse”: tree nuts.',
    ]);
  });

  it('deletes the whole restaurant a day after it opened', async () => {
    fakeNetwork();
    vi.useRealTimers();
    const sandbox = await opened();
    const restaurant = demoStub(env, sandbox);
    if (!restaurant) throw new Error('the test config must set DATA_JURISDICTION');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    expect(await runDurableObjectAlarm(restaurant)).toBe(true);
    await runInDurableObject(restaurant, async (_instance, state) => {
      expect(await state.storage.get('demo:expiresAt')).toBeUndefined();
      expect(state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookings'`).toArray()).toEqual([]);
    });
    expect((await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/day?date=${EVENING}&language=fr`)).status).toBe(404);
  });

  it('knows nothing of an id it never gave, and refuses what is not one of its routes', async () => {
    fakeNetwork();
    expect((await SELF.fetch(`${DEMO}/sandboxes/AAAAAAAAAAAAAAAAAAAAAA/day?date=${EVENING}`)).status).toBe(404);
    expect((await SELF.fetch(`${DEMO}/sandboxes/not-an-id/day?date=${EVENING}`)).status).toBe(404);
    expect((await SELF.fetch(`${DEMO}/sandboxes`)).status).toBe(404);
    const sandbox = await opened();
    expect((await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/chat`, { method: 'PUT' })).status).toBe(405);
  });
});
