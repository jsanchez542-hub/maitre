import { env, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localNow } from '../../src/calendar.js';
import { parseDay, resolveDate } from '../../src/dates.js';
import { budgetStub } from '../src/env.js';
import { callPass, liveKitProject } from '../src/livekit.js';

const BASE = 'https://maitre.test/v1/restaurants/demo';
const DEMO = 'https://maitre.test/v1/demo';
const AGENT = { authorization: 'Bearer test-agent-token', 'content-type': 'application/json' };
const STAFF = { authorization: 'Bearer test-staff-token', 'content-type': 'application/json' };
const JSON_BODY = { 'content-type': 'application/json' };
const EVENING = '2026-10-16';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});

function nextWeek(weekday: 'friday' | 'saturday'): string {
  const spec = parseDay(`${weekday} next week`);
  const resolved = spec && resolveDate(spec, localNow(new Date(), 'Europe/Paris').date);
  if (!resolved || !resolved.ok) throw new Error(`could not work out ${weekday} next week`);
  return resolved.date;
}

type Message = { role: string; content: string | null };
type Answer = object | ((messages: Message[]) => object);

/** The network as the tests play it: Turnstile vouches for the visitor, and OpenRouter answers in order. */
function fakeNetwork(answers: Answer[] = []): { authorization: string | null; body: string }[] {
  const queue = [...answers];
  const requests: { authorization: string | null; body: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`unexpected request to ${url}`);
    const body = String(init?.body);
    requests.push({ authorization: new Headers(init?.headers).get('authorization'), body });
    const answer = queue.shift();
    if (answer === undefined) throw new Error('the model was called once too often');
    const message = typeof answer === 'function' ? answer((JSON.parse(body) as { messages: Message[] }).messages) : answer;
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 1500, completion_tokens: 40, cost: 0.0004 } });
  });
  return requests;
}

const say = (content: string) => ({ content });
let toolCalls = 0;
const call = (name: string, input: object) => ({
  content: null,
  tool_calls: [{ id: `call-${(toolCalls += 1)}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
});

function heldTable(messages: Message[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role === 'tool' && message.content?.includes('"holdId"')) return (JSON.parse(message.content) as { holdId: string }).holdId;
  }
  throw new Error('no table was held');
}

/** A step of a call on the restaurant's own line, as the voice agent sends it. */
function step(sessionId: string, name: string, body: object, headers: Record<string, string> = AGENT): Promise<Response> {
  return SELF.fetch(`${BASE}/calls/${sessionId}/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** The JSON lines of a call's turn, in the order the line reads them. */
async function lines(response: Response): Promise<Record<string, unknown>[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  return new TextDecoder()
    .decode(await response.arrayBuffer())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function staffDay(date: string, base = BASE, headers: Record<string, string> = STAFF): Promise<{ bookings: Record<string, unknown>[] }> {
  return (await (await SELF.fetch(`${base}/day?date=${date}&language=fr`, { headers })).json()) as { bookings: Record<string, unknown>[] };
}

describe('a call to the restaurant', () => {
  it('greets as an AI, covers the wait while the tools run, and books with the number the phone network gave', async () => {
    const friday = nextWeek('friday');
    const requests = fakeNetwork([
      call('find_table', { day: 'friday next week', time: '20:00', partySize: 4 }),
      say('J’ai une table pour 4 personnes vendredi à 20 h. À quel nom, et y a-t-il des allergies ?'),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Dupont', allergies: [] }),
      say('C’est réservé au nom de Dupont, vendredi à 20 h. À bientôt !'),
    ]);

    const started = (await (await step('call-voice-0001', 'start', { language: 'fr', callerId: '+33 6 11 11 11 11' })).json()) as Record<string, string>;
    expect(started).toMatchObject({ status: 'ok', sessionId: 'call-voice-0001', language: 'fr' });
    // As a restaurant answers, by the hour there, saying it is an AI; the audio is never recorded, so never that it may be.
    expect(started['greeting']).toMatch(/^Merrain, bon(jour|soir)\. .*une intelligence artificielle\./);
    expect(started['greeting']).not.toMatch(/enregistr/);
    // Speech recognition is told the restaurant's name and its dishes, in the call's language.
    expect(started['keyterms']).toEqual(expect.arrayContaining(['Merrain', 'Soupe à l’oignon gratinée']));
    // Starting the same call again changes nothing.
    expect(await (await step('call-voice-0001', 'start', { language: 'en' })).json()).toEqual(started);

    const asked = await lines(await step('call-voice-0001', 'turns', { turnId: 'turn-0000001', message: 'Bonsoir, une table pour quatre vendredi prochain à vingt heures', language: 'fr' }));
    // The short line comes first, as soon as the model reaches for its tools: the caller hears it while they run.
    expect(asked).toEqual([{ type: 'working', say: 'Je regarde.' }, expect.objectContaining({ type: 'answer', status: 'ok', booked: [], askForPhone: false })]);

    const booked = await lines(await step('call-voice-0001', 'turns', { turnId: 'turn-0000002', message: 'Dupont, pas d’allergie', language: 'fr' }));
    expect(booked[0]).toEqual({ type: 'working', say: 'Je m’en occupe.' });
    expect(booked[1]).toMatchObject({ type: 'answer', booked: [{ date: friday, time: '20:00', partySize: 4 }] });

    const day = await staffDay(friday);
    expect(day.bookings[0]).toMatchObject({ guestName: 'Dupont', channel: 'voice', phoneSource: 'caller_id', phone: '+33 6 11 11 11 11' });
    expect(requests[0]?.body).toContain('The guest is on the phone');
    // The model never sees the caller's number.
    for (const request of requests) expect(request.body).not.toMatch(/11\D?11\D?11\D?11/);

    const turns = (await (await SELF.fetch(`${BASE}/conversations?limit=5`, { headers: STAFF })).json()) as Record<string, unknown>[];
    expect(turns[0]).toMatchObject({ channel: 'voice', guest: 'Dupont, pas d’allergie', working: 'Je m’en occupe.' });
  });

  it('answers a turn asked twice only once: a line that lost the connection gets the same answer', async () => {
    const requests = fakeNetwork([say('Nous sommes ouverts du mardi au samedi.')]);
    await step('call-voice-0002', 'start', { language: 'fr' });
    const turn = { turnId: 'turn-retry-01', message: 'Vous êtes ouverts quand ?', language: 'fr' };
    const once = await lines(await step('call-voice-0002', 'turns', turn));
    expect(await lines(await step('call-voice-0002', 'turns', turn))).toEqual(once);
    expect(once).toEqual([expect.objectContaining({ type: 'answer', reply: 'Nous sommes ouverts du mardi au samedi.' })]);
    expect(requests).toHaveLength(1);
  });

  it('takes the number from the keypad when the line has none, and asks again for one it cannot read', async () => {
    const friday = nextWeek('friday');
    const requests = fakeNetwork([
      call('find_table', { day: 'friday next week', time: '20:00', partySize: 2 }),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Martin', allergies: [] }),
      say('Pour confirmer, tapez votre numéro sur le clavier, puis la touche dièse.'),
      say('Bien sûr : tapez votre numéro sur le clavier, puis la touche dièse.'),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Martin', allergies: [] }),
      say('C’est réservé, merci.'),
    ]);
    await step('call-voice-0003', 'start', { language: 'fr' });
    const asked = await lines(
      await step('call-voice-0003', 'turns', { turnId: 'turn-keypad-1', message: 'Une table pour deux vendredi prochain à vingt heures au nom de Martin, sans allergie', language: 'fr' }),
    );
    expect(asked.at(-1)).toMatchObject({ type: 'answer', askForPhone: true, booked: [] });
    // Asked again without a tool, the number is still awaited: the keypad opens all the same.
    const again = await lines(await step('call-voice-0003', 'turns', { turnId: 'turn-keypad-1b', message: 'Pardon, je dois faire quoi ?', language: 'fr' }));
    expect(again.at(-1)).toMatchObject({ type: 'answer', askForPhone: true });

    // Two keys and a hash are not a number: the caller is asked again, in words, and no model is called.
    const unreadable = await lines(await step('call-voice-0003', 'keypad', { turnId: 'turn-keypad-2', digits: '12#' }));
    expect(unreadable).toEqual([expect.objectContaining({ type: 'answer', outcome: 'keypad_unreadable', askForPhone: true, reply: expect.stringContaining('touche dièse') })]);
    expect(requests).toHaveLength(4);

    const typed = await lines(await step('call-voice-0003', 'keypad', { turnId: 'turn-keypad-3', digits: '0622222222#' }));
    expect(typed.at(-1)).toMatchObject({ type: 'answer', askForPhone: false, booked: [{ date: friday, time: '20:00', partySize: 2 }] });
    expect((await staffDay(friday)).bookings[0]).toMatchObject({ guestName: 'Martin', phoneSource: 'keypad', phone: '+33 6 22 22 22 22' });
    expect(requests[4]?.body).toContain('Note from the phone line, not said by the caller');
    for (const request of requests) expect(request.body).not.toMatch(/22\D?22\D?22\D?22/);

    expect((await step('call-voice-0003', 'keypad', { turnId: 'turn-keypad-4', digits: '06-22' })).status).toBe(400);
  });

  it('remembers a reply the caller cut short as far as they heard it, and follows a caller who switches language', async () => {
    const requests = fakeNetwork([
      say('Nous sommes ouverts du mardi au samedi, le midi de 12 h à 14 h et le soir de 19 h à 22 h 30.'),
      say('We are closed on Sundays.'),
    ]);
    await step('call-voice-0004', 'start', { language: 'fr' });
    await lines(await step('call-voice-0004', 'turns', { turnId: 'turn-cut-0001', message: 'Vous êtes ouverts quand ?', language: 'fr' }));
    await lines(
      await step('call-voice-0004', 'turns', { turnId: 'turn-cut-0002', message: 'And on Sundays?', language: 'en', heard: 'Nous sommes ouverts du mardi au samedi' }),
    );
    const sent = JSON.parse(requests[1]?.body ?? '{}') as { messages: Message[] };
    // Exactly what was heard, as the whole text of the reply: the cache breakpoint puts it in a block of its own.
    expect(JSON.stringify(sent.messages.filter((message) => message.role === 'assistant').at(-1)?.content)).toContain('"text":"Nous sommes ouverts du mardi au samedi"');
    expect(JSON.stringify(sent.messages[0]?.content)).toContain('Always reply in English');
  });

  it('forgets a reply the caller never heard, and hears what they said before and after it as one message', async () => {
    const requests = fakeNetwork([
      say('Bonsoir, que puis-je faire pour vous ?'),
      call('find_table', { day: 'friday next week', time: '20:00', partySize: 4 }),
      say('J’ai une table pour 4 personnes vendredi à 20 h. À quel nom ?'),
      say('Bien sûr. J’ai une table pour 4 personnes vendredi à 20 h : à quel nom ?'),
      say('C’est noté.'),
    ]);
    await step('call-voice-0007', 'start', { language: 'fr' });
    // The caller paused after "Bonsoir", speech recognition ended the turn there, and they spoke on before the reply began.
    await lines(await step('call-voice-0007', 'turns', { turnId: 'turn-unheard-1', message: 'Bonsoir.', language: 'fr' }));
    await lines(
      await step('call-voice-0007', 'turns', {
        turnId: 'turn-unheard-2',
        message: 'Je voudrais une table pour quatre vendredi prochain à vingt heures.',
        language: 'fr',
        unheard: 'turn-unheard-1',
      }),
    );
    const merged = (JSON.parse(requests[1]?.body ?? '{}') as { messages: Message[] }).messages;
    expect(merged.filter((message) => message.role === 'assistant')).toEqual([]);
    const guest = merged.filter((message) => message.role === 'user');
    expect(guest).toHaveLength(1);
    expect(JSON.stringify(guest[0]?.content)).toContain('Bonsoir. Je voudrais une table pour quatre vendredi prochain à vingt heures.');

    // Heard only "Je regarde.": the reply goes, what the tools found stays.
    await lines(await step('call-voice-0007', 'turns', { turnId: 'turn-unheard-3', message: 'Pardon ?', language: 'fr', unheard: 'turn-unheard-2' }));
    const kept = (JSON.parse(requests[3]?.body ?? '{}') as { messages: Message[] }).messages;
    expect(kept.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('holdId'))).toBe(true);
    expect(kept.some((message) => JSON.stringify(message.content).includes('À quel nom'))).toBe(false);
    expect(kept.at(-1)?.role).toBe('user');
    expect(JSON.stringify(kept.at(-1)?.content)).toContain('Pardon ?');

    // An id that is not the last turn's changes nothing: that reply was heard.
    await lines(await step('call-voice-0007', 'turns', { turnId: 'turn-unheard-4', message: 'Dupont.', language: 'fr', unheard: 'turn-unheard-1' }));
    const intact = (JSON.parse(requests[4]?.body ?? '{}') as { messages: Message[] }).messages;
    expect(intact.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Bien sûr.'))).toBe(true);

    const turns = (await (await SELF.fetch(`${BASE}/conversations?limit=10`, { headers: STAFF })).json()) as Record<string, unknown>[];
    expect(turns.filter((turn) => turn['unheardBefore'] === true)).toHaveLength(2);
    expect((await step('call-voice-0007', 'turns', { turnId: 'turn-unheard-5', message: 'Merci.', language: 'fr', unheard: 'x' })).status).toBe(400);
  });

  it('offers the phone a way to hang up, and hangs up after the goodbye of a caller who ends the call', async () => {
    const requests = fakeNetwork([
      { content: 'Au revoir, et à bientôt chez Merrain.', tool_calls: [{ id: 'call-bye', type: 'function', function: { name: 'end_call', arguments: '{}' } }] },
    ]);
    await step('call-voice-0007', 'start', { language: 'fr' });
    const answer = await lines(await step('call-voice-0007', 'turns', { turnId: 'turn-bye-0001', message: 'Merci, au revoir.', language: 'fr' }));
    // No short line while a goodbye is written: the answer alone.
    expect(answer).toEqual([expect.objectContaining({ type: 'answer', reply: 'Au revoir, et à bientôt chez Merrain.', hangUp: true })]);
    const offered = (JSON.parse(requests[0]?.body ?? '{}') as { tools: { function: { name: string } }[] }).tools.map((tool) => tool.function.name);
    expect(offered).toContain('end_call');
    expect(await (await step('call-voice-0007', 'end', { endedBy: 'goodbye', seconds: 41.2 })).json()).toEqual({ status: 'ok', say: '' });
    const calls = (await (await SELF.fetch(`${BASE}/calls?limit=10`, { headers: STAFF })).json()) as Record<string, unknown>[];
    expect(calls[0]).toMatchObject({ sessionId: 'call-voice-0007', endedBy: 'goodbye', seconds: 41 });
  });

  it('gives the last words of a line that hangs up on its own, and shows the owner each call’s length and pace', async () => {
    fakeNetwork();
    await step('call-voice-0005', 'start', { language: 'fr' });
    const ended = await step('call-voice-0005', 'end', { endedBy: 'silence', seconds: 95.4, voiceToVoiceMs: [820.4, 1190, 'fast', -5, 99_999] });
    expect(await ended.json()).toEqual({ status: 'ok', say: 'Je ne vous entends plus. Vous pouvez rappeler quand vous voulez. Au revoir.' });
    // A call ends once.
    expect(await (await step('call-voice-0005', 'end', { endedBy: 'caller', seconds: 120 })).json()).toEqual({ status: 'ok', say: '' });

    const calls = (await (await SELF.fetch(`${BASE}/calls?limit=10`, { headers: STAFF })).json()) as Record<string, unknown>[];
    expect(calls).toEqual([
      { sessionId: 'call-voice-0005', startedAt: expect.any(String), language: 'fr', endedAt: expect.any(String), seconds: 95, endedBy: 'silence', voiceToVoiceMs: [820, 1190] },
    ]);
    expect((await step('call-voice-0005', 'end', { endedBy: 'boredom', seconds: 3 })).status).toBe(400);
    expect((await step('call-never-started', 'end', { endedBy: 'caller', seconds: 3 })).status).toBe(400);
  });

  it('is the voice agent’s alone: no token, the staff’s token or a demo-only step get nothing', async () => {
    fakeNetwork();
    expect((await step('call-voice-0006', 'start', { language: 'fr' }, JSON_BODY)).status).toBe(401);
    expect((await step('call-voice-0006', 'start', { language: 'fr' }, STAFF)).status).toBe(401);
    expect((await step('call-voice-0006', 'usage', { seconds: 30 })).status).toBe(405);
    expect((await SELF.fetch(`${BASE}/calls`, { headers: AGENT })).status).toBe(401);
    // A chat session is not a call.
    expect((await step('web-session-0001', 'turns', { turnId: 'turn-00000001', message: 'Allô', language: 'fr' })).status).toBe(400);
  });
});

function base64urlBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The claims of a LiveKit pass, once its signature is checked against the project's secret. */
async function verifiedClaims(token: string, secret: string): Promise<Record<string, unknown>> {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  expect(await crypto.subtle.verify('HMAC', key, base64urlBytes(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(base64urlBytes(header)))).toEqual({ alg: 'HS256', typ: 'JWT' });
  return JSON.parse(new TextDecoder().decode(base64urlBytes(payload))) as Record<string, unknown>;
}

describe('the pass to call through LiveKit', () => {
  it('is signed with the project’s secret and lets one person into one room, with a microphone only', async () => {
    const token = await callPass(
      { url: 'wss://maitre-test.livekit.cloud', apiKey: 'key', apiSecret: 'secret' },
      { room: 'demo-call', identity: 'visitor-1', agentName: 'maitre-voice', agentMetadata: '{"a":1}', ttlSeconds: 300, now: 1_000 },
    );
    expect(await verifiedClaims(token, 'secret')).toEqual({
      iss: 'key',
      sub: 'visitor-1',
      nbf: 1_000,
      exp: 1_300,
      video: { room: 'demo-call', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: ['microphone'] },
      roomConfig: { agents: [{ agentName: 'maitre-voice', metadata: '{"a":1}' }] },
    });
  });

  it('is only made when the project is fully configured, with a secure address', () => {
    expect(liveKitProject({ LIVEKIT_URL: 'wss://maitre.livekit.cloud', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })).toBeDefined();
    expect(liveKitProject({ LIVEKIT_URL: 'wss://maitre.livekit.cloud', LIVEKIT_API_KEY: 'k' })).toBeUndefined();
    expect(liveKitProject({ LIVEKIT_URL: 'ws://maitre.livekit.cloud', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })).toBeUndefined();
    expect(liveKitProject({ LIVEKIT_URL: 'wss://evil.example/path?x=1', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' })).toBeUndefined();
  });
});

/** The voice agent says it is there and its speech works, as it does every minute. */
function checkIn(body: object = { ready: true }, report = 'check-in', headers: Record<string, string> = AGENT): Promise<Response> {
  return SELF.fetch(`${DEMO}/voice/${report}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function openSandbox(): Promise<string> {
  expect((await checkIn()).status).toBe(200);
  const response = await SELF.fetch(`${DEMO}/sandboxes`, {
    method: 'POST',
    headers: { ...JSON_BODY, 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify({ turnstile: 'a-token-from-the-widget' }),
  });
  expect(response.status).toBe(201);
  const opened = (await response.json()) as Record<string, unknown>;
  // The page learns here whether to show its call button, and on what terms.
  expect(opened['calls']).toEqual({ perRestaurant: 3, maxSeconds: 240 });
  return String(opened['sandbox']);
}

interface Pass {
  url: string;
  token: string;
  sessionId: string;
  maxSeconds: number;
  callsLeft: number;
}

async function pass(sandbox: string, language = 'fr'): Promise<Pass> {
  const response = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ language }) });
  expect(response.status).toBe(201);
  return (await response.json()) as Pass;
}

function demoStep(sandbox: string, sessionId: string, name: string, body: object, headers: Record<string, string> = AGENT): Promise<Response> {
  return SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls/${sessionId}/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('the call button', () => {
  // The demo restaurant lives at the real time: the tests fix it at 20:05 on Friday 16 October, in the middle of dinner.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T18:05:00Z'));
  });

  const offer = async (): Promise<unknown> => ((await (await SELF.fetch(DEMO)).json()) as Record<string, unknown>)['calls'];

  it('shows only while a voice agent checks in with speech that works, and a call is refused otherwise', async () => {
    fakeNetwork([]);
    // Configured, but no agent is running: a call would ring with nobody to answer.
    expect(await offer()).toBeNull();
    const sandbox = await openSandbox();
    expect(await offer()).toEqual({ perRestaurant: 3, maxSeconds: 240 });

    // Its speech answers 429: the free allowance is spent.
    expect(await (await checkIn({ ready: false, reason: 'speech_quota' })).json()).toEqual({ status: 'ok', calls: false });
    expect(await offer()).toBeNull();
    const refused = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls`, { method: 'POST', headers: JSON_BODY, body: '{}' });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'calls_unavailable']);

    // Speech works again; then the agent stops checking in, and after two missed check-ins it is gone.
    await checkIn();
    expect(await offer()).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-16T18:07:40Z'));
    expect(await offer()).toBeNull();
  });

  it('turns calls off for a quarter of an hour after a call fails on its speech, whatever the agent says meanwhile', async () => {
    fakeNetwork([]);
    await checkIn();
    expect(await (await checkIn({ reason: 'speech_quota' }, 'call-failed')).json()).toEqual({ status: 'ok', calls: false });
    await checkIn();
    expect(await offer()).toBeNull();
    vi.setSystemTime(new Date('2026-10-16T18:20:30Z'));
    await checkIn();
    expect(await offer()).toEqual({ perRestaurant: 3, maxSeconds: 240 });
  });

  it('takes the agent’s word only with the agent’s token, and a reason only as a word', async () => {
    fakeNetwork([]);
    expect((await checkIn({ ready: true }, 'check-in', JSON_BODY)).status).toBe(401);
    expect((await checkIn({ ready: true }, 'check-in', { ...JSON_BODY, authorization: 'Bearer test-staff-token' })).status).toBe(401);
    expect(await offer()).toBeNull();
    await checkIn({ ready: false, reason: 'Error: 429 at wss://agent-gateway <html>' });
    const budget = budgetStub(env);
    if (!budget) throw new Error('the test config must set DATA_JURISDICTION');
    await runInDurableObject(budget, async (_instance, state) => {
      expect(await state.storage.get('voice')).not.toHaveProperty('reason');
    });
  });
});

describe('calling the demo restaurant from the browser', () => {
  // The demo restaurant lives at the real time: the tests fix it at 20:05 on Friday 16 October, in the middle of dinner.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T18:05:00Z'));
  });

  it('gives the visitor a pass that sends the voice agent with the call, and the agent books in the visitor’s own restaurant', async () => {
    const requests = fakeNetwork([
      call('find_table', { day: 'today', time: '21:30', partySize: 2 }),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Nolan', allergies: [] }),
      say('To confirm, please type your phone number on the keypad, then press the hash key.'),
      (messages) => call('book_table', { holdId: heldTable(messages), guestName: 'Nolan', allergies: [] }),
      say('You are booked for two tonight at 9.30 pm.'),
    ]);
    const sandbox = await openSandbox();
    const given = await pass(sandbox, 'en');
    expect(given).toMatchObject({ url: 'wss://maitre-test.livekit.cloud', maxSeconds: 240 });
    expect(given.sessionId).toMatch(/^call_[A-Za-z0-9_-]{22}$/);
    const claims = await verifiedClaims(given.token, 'test-livekit-secret');
    expect(claims).toMatchObject({
      iss: 'test-livekit-key',
      sub: `visitor-${given.sessionId}`,
      video: { room: `demo-${given.sessionId}`, roomJoin: true, canPublishSources: ['microphone'] },
      roomConfig: { agents: [{ agentName: 'maitre-voice' }] },
    });
    const dispatch = (claims['roomConfig'] as { agents: { metadata: string }[] }).agents[0]?.metadata ?? '';
    expect(JSON.parse(dispatch)).toEqual({ sandbox, sessionId: given.sessionId, language: 'en' });

    // Only the voice agent, with its token, can run the call.
    expect((await demoStep(sandbox, given.sessionId, 'start', { language: 'en' }, JSON_BODY)).status).toBe(401);
    expect((await demoStep(sandbox, 'call_AAAAAAAAAAAAAAAAAAAAAA', 'start', { language: 'en' })).status).toBe(400);
    const started = (await (await demoStep(sandbox, given.sessionId, 'start', { language: 'en' })).json()) as Record<string, string>;
    expect(started['greeting']).toMatch(/^Merrain, good (morning|afternoon|evening)\. .*an AI\./);

    const asked = await lines(await demoStep(sandbox, given.sessionId, 'turns', { turnId: 'turn-demo-001', message: 'A table for two tonight at half past nine, Nolan, no allergies', language: 'en' }));
    expect(asked[0]).toEqual({ type: 'working', say: 'Let me check.' });
    // A call from the browser has no caller ID: the number comes from the keypad, never from speech.
    expect(asked[1]).toMatchObject({ type: 'answer', askForPhone: true, booked: [] });
    const booked = await lines(await demoStep(sandbox, given.sessionId, 'keypad', { turnId: 'turn-demo-002', digits: '0033611223344#' }));
    expect(booked.at(-1)).toMatchObject({ type: 'answer', booked: [{ date: EVENING, time: '21:30', partySize: 2 }] });
    const nolan = (await staffDay(EVENING, `${DEMO}/sandboxes/${sandbox}`, JSON_BODY)).bookings.find((booking) => booking['guestName'] === 'Nolan');
    expect(nolan).toMatchObject({ channel: 'voice', phoneSource: 'keypad', phone: '+33 6 11 22 33 44' });
    for (const request of requests) expect(request.authorization).toBe('Bearer test-demo-openrouter-key');

    const calls = (await (await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls`, { headers: JSON_BODY })).json()) as Record<string, unknown>[];
    expect(calls).toEqual([expect.objectContaining({ sessionId: given.sessionId, language: 'en' })]);
  });

  it('gives a restaurant a few calls, not more', async () => {
    fakeNetwork();
    const sandbox = await openSandbox();
    expect((await pass(sandbox)).callsLeft).toBe(2);
    for (let made = 1; made < 3; made += 1) await pass(sandbox);
    const refused = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ language: 'fr' }) });
    expect([refused.status, await refused.json()]).toEqual([429, { error: 'call_limit' }]);
  });

  it('counts a call the restaurant answered, not one nobody answered within its minute to join', async () => {
    fakeNetwork();
    const sandbox = await openSandbox();
    const answered = await pass(sandbox);
    expect((await demoStep(sandbox, answered.sessionId, 'start', { language: 'fr' })).status).toBe(200);
    // The line was down for these two: they ring, nobody answers, and the visitor gives up.
    await pass(sandbox);
    const last = await pass(sandbox);
    expect(last.callsLeft).toBe(0);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const clock = (await (await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/clock`)).json()) as Record<string, unknown>;
    expect(clock['callsLeft']).toBe(2);
    expect((await pass(sandbox)).callsLeft).toBe(1);
  });

  it('pays for the voice by the minute, once, and stops the call at its longest', async () => {
    fakeNetwork();
    const sandbox = await openSandbox();
    const { sessionId } = await pass(sandbox);
    await demoStep(sandbox, sessionId, 'start', { language: 'fr' });
    const usage = async (seconds: number) => (await demoStep(sandbox, sessionId, 'usage', { seconds })).json();

    expect(await usage(60)).toEqual({ status: 'ok', carryOn: true });
    expect(await usage(60)).toEqual({ status: 'ok', carryOn: true });
    expect((await budgetStub(env)?.spending())?.day.usd).toBeCloseTo(0.03, 10);
    expect(await usage(240)).toEqual({ status: 'ok', carryOn: false, reason: 'time_limit' });
    expect((await budgetStub(env)?.spending())?.day.usd).toBeCloseTo(0.12, 10);

    const late = await demoStep(sandbox, sessionId, 'turns', { turnId: 'turn-late-0001', message: 'Allô ?', language: 'fr' });
    expect([late.status, await late.json()]).toEqual([409, { error: 'call_time_limit' }]);
    const ended = await demoStep(sandbox, sessionId, 'end', { endedBy: 'time_limit', seconds: 241 });
    expect(await ended.json()).toEqual({ status: 'ok', say: 'Je dois mettre fin à cet appel, qui a atteint sa durée maximale. Merci d’avoir appelé, au revoir.' });
  });

  it('stops a call once the demo’s budget is spent, and gives no pass while it is paused', async () => {
    fakeNetwork();
    const sandbox = await openSandbox();
    const { sessionId } = await pass(sandbox);
    await demoStep(sandbox, sessionId, 'start', { language: 'es' });
    const budget = budgetStub(env);
    if (!budget) throw new Error('the test config must set DATA_JURISDICTION');
    await runInDurableObject(budget, async (_instance, state) => {
      await state.storage.put('spent:day', { period: new Date().toISOString().slice(0, 10), usd: 1 });
    });

    expect(await (await demoStep(sandbox, sessionId, 'usage', { seconds: 30 })).json()).toEqual({ status: 'ok', carryOn: false, reason: 'paused' });
    const refused = await SELF.fetch(`${DEMO}/sandboxes/${sandbox}/calls`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ language: 'es' }) });
    expect([refused.status, await refused.json()]).toEqual([503, { error: 'live_paused' }]);
    const ended = await demoStep(sandbox, sessionId, 'end', { endedBy: 'paused', seconds: 31 });
    expect(((await ended.json()) as { say: string }).say).toMatch(/^Tengo que terminar esta llamada/);
  });
});

describe('a model that is down', () => {
  it('answers with the fallback model, and the log says so', async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { model } = JSON.parse(String(init?.body)) as { model: string };
      asked.push(model);
      if (model === 'anthropic/claude-haiku-5.5') return new Response('{"error":{"message":"down"}}', { status: 503 });
      return Response.json({ choices: [{ message: { content: 'Nous sommes ouverts du mardi au samedi.' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } });
    });
    const response = await SELF.fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ sessionId: 'web-fallback-01', channel: 'web', language: 'fr', message: 'Vous êtes ouverts quand ?' }),
    });
    expect(await response.json()).toMatchObject({ status: 'ok', outcome: 'answered', reply: 'Nous sommes ouverts du mardi au samedi.' });
    // The first model is asked twice, then the second answers: the guest only sees the answer.
    expect(asked).toEqual(['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5', 'openai/gpt-5.6-luna']);
    const turns = (await (await SELF.fetch(`${BASE}/conversations?limit=1`, { headers: STAFF })).json()) as Record<string, unknown>[];
    expect(turns[0]).toMatchObject({ outcome: 'answered', fellBack: true });
  });
});
