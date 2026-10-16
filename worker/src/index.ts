import { localNow } from '../../src/calendar.js';
import { demoSuggestion, serviceDayAt } from '../../src/demo/evening.js';
import { DEMO_RESTAURANT } from '../../src/demo/restaurant.js';
import type { StaffChangeRequest } from '../../src/engine.js';
import { isLanguage } from '../../src/i18n/index.js';
import { newSandboxId, SANDBOX_ID, verifyTurnstile, visitorKey, type DemoBudget, type DemoCallTurn, type DemoRestaurant } from './demo.js';
import { budgetStub, demoStub, restaurantStub, type Env } from './env.js';
import { serveFilm } from './films.js';
import { hasBearer, json, jsonLines, problem, readJson } from './http.js';
import { callPass, liveKitProject } from './livekit.js';
import type { CallEnd, CallTurn, ChatRequest, Restaurant } from './restaurant.js';

export { DemoBudget, DemoRestaurant } from './demo.js';
export { Restaurant } from './restaurant.js';

/**
 * Routes, all under /v1/restaurants/:id/:
 *
 *   POST chat                          agent  one turn of a web or WhatsApp conversation
 *   POST sessions/:session/phone       agent  the number typed in the web chat's field
 *   POST calls/:session/start          agent  a phone call begins: { language, callerId? }, answers the greeting
 *                                             and the words speech recognition should expect on the line
 *   POST calls/:session/turns          agent  { turnId, message, language, heard?, unheard? }, answers JSON lines:
 *                                             a short line to say while the tools run, then the answer
 *   POST calls/:session/keypad         agent  { turnId, digits } typed by the caller, answered the same way
 *   POST calls/:session/end            agent  { endedBy, seconds, voiceToVoiceMs }, answers the last words if any
 *   POST tools/:name                   agent  one tool call from an outside agent that runs its own loop
 *   GET  day?date=&language=           staff  the service of the day
 *   GET  conversations?limit=          staff  the latest turns, with latency and cost
 *   GET  calls?limit=                  staff  the latest calls, with their length and how fast each answer came
 *   POST staff/bookings                staff  a booking taken by hand or a party on the spot, at a table if given
 *   POST staff/bookings/:ref/cancel    staff
 *   POST staff/bookings/:ref/no-show   staff
 *   POST staff/bookings/:ref/arrived   staff  the party is at the door
 *   POST staff/bookings/:ref/seated    staff  { table? } at its planned table or another
 *   POST staff/bookings/:ref/left      staff  the table is free again from now
 *   POST staff/bookings/:ref/table     staff  { table } moved there, and kept there
 *   POST staff/callbacks/:id/done      staff
 *   GET  activity?days=                staff  what the assistant did over the last days (7 by default): bookings by
 *                                             channel, conversations, calls answered during service and while closed
 *   GET  config                        staff  the restaurant's settings
 *   PUT  config                        staff  { weekly?, exceptions?, menu?, faq?, minNoticeMinutes?, maxAdvanceDays?,
 *                                             maxPartySize? } the settings an owner edits, checked as a whole; the
 *                                             assistant answers with them from its next turn
 *
 * "agent" routes need AGENT_TOKEN and "staff" routes STAFF_TOKEN, as a bearer
 * token. A route whose secret is not configured answers 503 instead of running open.
 *
 * The public demo, under /v1/demo/:
 *
 *   GET  (the demo itself)                           { live, calls, now, today, day, suggestion }: whether it is open
 *                                                    now, the call's terms or null, the restaurant's time and date,
 *                                                    the day of its service and a table a guest could still book,
 *                                                    without opening a restaurant or counting a visitor
 *   POST sandboxes                                   { turnstile } opens a visitor's own restaurant
 *   POST sandboxes/:sandbox/chat                     { sessionId, message, language } with the real assistant
 *   POST sandboxes/:sandbox/sessions/:session/phone  { phone } typed in the chat's field
 *   POST sandboxes/:sandbox/calls                    { language } the pass to call the restaurant from the browser, with
 *                                                    the calls left after it; a call the agent never answered within
 *                                                    its minute to join does not count
 *   POST sandboxes/:sandbox/calls/:session/...       agent  start, turns, keypad and end as above, and usage
 *                                                    { seconds }: the call's length, which the budget pays for
 *   GET  sandboxes/:sandbox/clock                    { clock, day, suggestion, callsLeft, expiresAt }: the real time,
 *                                                    the day of the service the dashboard opens on, a table a guest
 *                                                    could still book, the calls left, and when the restaurant
 *                                                    deletes itself
 *   GET  sandboxes/:sandbox/day, conversations and calls, POST sandboxes/:sandbox/staff/...  as the staff routes above
 *   GET and PUT sandboxes/:sandbox/config            as above: the visitor changes their own restaurant's settings
 *   GET  sandboxes/:sandbox/activity?days=            as above
 *
 * A sandbox's id is the only key to it: 128 random bits, given once, to the browser that opened it.
 *
 * And GET /media/:film, the demo's films, in the byte ranges a video player asks for (films.ts).
 */
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('Maître request failed:', error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : 'unknown');
      return problem(500, 'internal_error');
    }
  },
} satisfies ExportedHandler<Env>;

type Access = 'agent' | 'staff';

async function authorized(request: Request, env: Env, access: Access): Promise<Response | undefined> {
  const secret = access === 'agent' ? env.AGENT_TOKEN : env.STAFF_TOKEN;
  if (!secret) return problem(503, 'not_configured');
  return (await hasBearer(request, secret)) ? undefined : problem(401, 'unauthorized');
}

/** Whether a request's method and path segments match a route, with null for any one segment. */
function matcher(request: Request, rest: readonly string[]) {
  return (method: string, ...shape: (string | null)[]): boolean =>
    request.method === method && rest.length === shape.length && shape.every((part, index) => part === null || part === rest[index]);
}

/**
 * Whether this request fits its address's share of the API. Every request from
 * the internet carries the address Cloudflare saw; one without it did not come
 * through the edge, and there is nothing to count it by.
 */
async function withinLimit(request: Request, env: Env): Promise<boolean> {
  const address = request.headers.get('cf-connecting-ip');
  if (!env.API_LIMITER || !address) return true;
  // The voice agent answers many callers from one server: its token vouches for it, not its address.
  if (env.AGENT_TOKEN && (await hasBearer(request, env.AGENT_TOKEN))) return true;
  return (await env.API_LIMITER.limit({ key: address })).success;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Files of the site, not the API: they count against no visitor's share.
  if (url.pathname.startsWith('/media/')) return serveFilm(request, env);
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 1 && parts[0] === 'health' && request.method === 'GET') return json({ ok: true });
  if (!(await withinLimit(request, env))) return problem(429, 'too_many_requests');
  if (parts[0] === 'v1' && parts[1] === 'demo') return demo(request, env, url, parts.slice(2));
  if (parts[0] !== 'v1' || parts[1] !== 'restaurants' || parts.length < 4) return problem(404, 'not_found');

  const restaurantId = parts[2] ?? '';
  const allowed = env.RESTAURANT_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (!allowed.includes(restaurantId)) return problem(404, 'not_found');
  const restaurant = restaurantStub(env, restaurantId);
  if (!restaurant) return problem(503, 'not_configured');
  const rest = parts.slice(3);
  const is = matcher(request, rest);

  // A phone call, run by the voice agent on the caller's behalf.
  if (rest[0] === 'calls' && CALL_STEPS.some((step) => is('POST', 'calls', null, step))) {
    const denied = await authorized(request, env, 'agent');
    if (denied) return denied;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const input = body.value;
    const sessionId = rest[1] ?? '';
    switch (rest[2] as CallStep) {
      case 'start': {
        const started = await restaurant.startCall({
          sessionId,
          language: String(input['language'] ?? ''),
          ...(typeof input['callerId'] === 'string' ? { callerId: input['callerId'] } : {}),
        });
        return json(started, started.status === 'ok' ? 200 : 400);
      }
      case 'turns':
        return callAnswer(await restaurant.callTurn(callTurn(sessionId, input)));
      case 'keypad':
        return callAnswer(await restaurant.keypad({ sessionId, turnId: String(input['turnId'] ?? ''), digits: String(input['digits'] ?? '') }));
      case 'end': {
        const ended = await restaurant.endCall(callEnd(sessionId, input));
        return json(ended, ended.status === 'ok' ? 200 : 400);
      }
    }
  }

  // Guest-facing routes, called by Maître's own services on the guest's behalf.
  if (is('POST', 'chat') || is('POST', 'sessions', null, 'phone') || is('POST', 'tools', null)) {
    const denied = await authorized(request, env, 'agent');
    if (denied) return denied;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const input = body.value;
    if (rest[0] === 'chat') {
      if (!env.OPENROUTER_API_KEY) return problem(503, 'not_configured');
      const result = await restaurant.chat({
        sessionId: String(input['sessionId'] ?? ''),
        message: String(input['message'] ?? ''),
        // Checked by the restaurant, like every other field.
        channel: String(input['channel'] ?? '') as ChatRequest['channel'],
        language: String(input['language'] ?? ''),
        ...(typeof input['phone'] === 'string' ? { phone: input['phone'] } : {}),
      });
      if (result.status === 'not_configured') return problem(503, 'not_configured');
      return json(result, result.status === 'invalid' ? 400 : 200);
    }
    if (rest[0] === 'sessions') {
      const result = await restaurant.setPhone(rest[1] ?? '', String(input['phone'] ?? ''));
      return json(result, result.status === 'ok' ? 200 : 400);
    }
    const output = await restaurant.tool({
      sessionId: String(input['sessionId'] ?? ''),
      language: String(input['language'] ?? ''),
      ...(typeof input['callerId'] === 'string' ? { callerId: input['callerId'] } : {}),
      ...(typeof input['keypadPhone'] === 'string' ? { keypadPhone: input['keypadPhone'] } : {}),
      name: rest[1] ?? '',
      input: input['input'] ?? {},
    });
    return json(output);
  }

  // The restaurant's own dashboard.
  if (!isStaffRoute(request, rest)) return problem(rest.length > 0 ? 405 : 404, rest.length > 0 ? 'method_or_route_not_allowed' : 'not_found');
  const denied = await authorized(request, env, 'staff');
  if (denied) return denied;
  return staff(request, url, rest, restaurant);
}

const CALL_STEPS = ['start', 'turns', 'keypad', 'end'] as const;
type CallStep = (typeof CALL_STEPS)[number];
/** A demo call also says how long it has lasted, for the demo's budget. */
const DEMO_CALL_STEPS = [...CALL_STEPS, 'usage'] as const;
type DemoCallStep = (typeof DEMO_CALL_STEPS)[number];

function callTurn(sessionId: string, input: Record<string, unknown>): CallTurn {
  return {
    sessionId,
    turnId: String(input['turnId'] ?? ''),
    message: String(input['message'] ?? ''),
    language: String(input['language'] ?? ''),
    ...(typeof input['heard'] === 'string' ? { heard: input['heard'] } : {}),
    ...(input['unheard'] !== undefined ? { unheard: String(input['unheard']) } : {}),
  };
}

function callEnd(sessionId: string, input: Record<string, unknown>): CallEnd {
  return { sessionId, endedBy: String(input['endedBy'] ?? ''), seconds: Number(input['seconds']), voiceToVoiceMs: input['voiceToVoiceMs'] };
}

/** A call's turn as HTTP: JSON lines while it runs, or what stopped it, by name, so the line can say the right thing. */
function callAnswer(result: DemoCallTurn): Response {
  switch (result.status) {
    case 'streaming':
      return jsonLines(result.events);
    case 'invalid':
      return json(result, 400);
    case 'not_configured':
      return problem(503, 'not_configured');
    case 'time_limit':
      return problem(409, 'call_time_limit');
    case 'rate_limited':
    case 'sandbox_limit':
      return problem(429, result.status);
    case 'not_found':
      return problem(404, 'not_found');
    default:
      return problem(503, 'live_paused');
  }
}

function isStaffRoute(request: Request, rest: readonly string[]): boolean {
  const is = matcher(request, rest);
  return (
    is('GET', 'day') ||
    is('GET', 'conversations') ||
    is('GET', 'calls') ||
    is('POST', 'staff', 'bookings') ||
    STAFF_ACTIONS.some((action) => is('POST', 'staff', 'bookings', null, action)) ||
    is('POST', 'staff', 'bookings', null, 'change') ||
    is('GET', 'staff', 'bookings', null, 'tables') ||
    is('POST', 'staff', 'callbacks', null, 'done') ||
    is('GET', 'config') ||
    is('PUT', 'config') ||
    is('GET', 'outside-hours') ||
    is('GET', 'activity')
  );
}

/** The dashboard's routes, for a restaurant or for a visitor's demo restaurant, once the caller may use them. */
async function staff(
  request: Request,
  url: URL,
  rest: readonly string[],
  restaurant: DurableObjectStub<Restaurant> | DurableObjectStub<DemoRestaurant>,
): Promise<Response> {
  if (rest[0] === 'day') {
    const result = await restaurant.serviceDay(url.searchParams.get('date') ?? '', url.searchParams.get('language') ?? 'fr');
    return json(result, 'status' in result && result.status === 'invalid' ? 400 : 200);
  }
  if (rest[0] === 'conversations') {
    return json(await restaurant.recentTurns(Number(url.searchParams.get('limit') ?? '50')));
  }
  if (rest[0] === 'calls') {
    return json(await restaurant.recentCalls(Number(url.searchParams.get('limit') ?? '50')));
  }
  if (rest[0] === 'activity') {
    const result = await restaurant.activity(Number(url.searchParams.get('days') ?? '7'));
    return json(result, 'status' in result ? 400 : 200);
  }
  if (rest[0] === 'config') {
    if (request.method === 'GET') return json(await restaurant.config());
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const language = typeof body.value['language'] === 'string' ? body.value['language'] : undefined;
    const updated = await restaurant.updateConfig(body.value['settings'], language);
    return json(updated, updated.status === 'ok' ? 200 : 400);
  }
  if (rest[0] === 'outside-hours') {
    return json({ bookings: await restaurant.outsideHours(url.searchParams.get('language') ?? undefined) });
  }
  if (rest.length === 2) {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const input = body.value;
    const result = await restaurant.staffBook({
      date: String(input['date'] ?? ''),
      ...(typeof input['time'] === 'string' ? { time: input['time'] } : {}),
      partySize: Number(input['partySize']),
      ...(typeof input['guestName'] === 'string' ? { guestName: input['guestName'] } : {}),
      ...(typeof input['phone'] === 'string' ? { phone: input['phone'] } : {}),
      ...(typeof input['notes'] === 'string' ? { notes: input['notes'] } : {}),
      ...(Array.isArray(input['allergies']) ? { allergies: input['allergies'].map(String) } : {}),
      ...(input['walkIn'] === true ? { walkIn: true } : {}),
      ...(typeof input['table'] === 'string' ? { table: input['table'] } : {}),
      ...(isLanguage(input['language']) ? { language: input['language'] } : {}),
      ...(isLanguage(input['guestLanguage']) ? { guestLanguage: input['guestLanguage'] } : {}),
    });
    return json(result, result.status === 'invalid' ? 400 : result.status === 'unavailable' || result.status === 'table_taken' ? 409 : 201);
  }
  const target = rest[2] ?? '';
  if (rest[1] === 'callbacks') {
    const done = await restaurant.completeCallback(target);
    return json(done, done.status === 'not_found' ? 404 : 200);
  }
  if (rest[3] === 'tables') {
    const tables = await restaurant.freeTables(target);
    return json(tables, { ok: 200, not_found: 404, not_allowed: 409 }[tables.status]);
  }
  if (rest[3] === 'change') {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const change = staffChangeOf(body.value);
    if ('problems' in change) return json({ status: 'invalid', problems: change.problems }, 400);
    const result = await restaurant.staffChange(target, change);
    const status = { booked: 200, invalid: 400, not_found: 404, not_allowed: 409, unavailable: 409, table_taken: 409 }[result.status];
    return json(result, status);
  }
  // Every action may name the dashboard's language; "seated" and "table" also a table.
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const table = typeof body.value['table'] === 'string' ? body.value['table'] : undefined;
  const language = typeof body.value['language'] === 'string' ? body.value['language'] : undefined;
  let action;
  switch (rest[3] as StaffAction) {
    case 'confirm':
      action = await restaurant.staffConfirm(target, language);
      break;
    case 'cancel':
      action = await restaurant.staffCancel(target, language);
      break;
    case 'no-show':
      action = await restaurant.markNoShow(target, language);
      break;
    case 'arrived':
      action = await restaurant.markArrived(target, language);
      break;
    case 'left':
      action = await restaurant.markLeft(target, language);
      break;
    case 'seated':
      action = await restaurant.seat(target, table, language);
      break;
    case 'table':
      if (table === undefined) return problem(400, 'table_required');
      action = await restaurant.moveTable(target, table, language);
      break;
  }
  const status = { done: 200, not_found: 404, unknown_table: 400, not_allowed: 409, table_taken: 409 }[action.status];
  return json(action, status);
}

const STAFF_ACTIONS = ['confirm', 'cancel', 'no-show', 'arrived', 'seated', 'left', 'table'] as const;
type StaffAction = (typeof STAFF_ACTIONS)[number];

/**
 * A change from the dashboard. A field left out stays as it is; null or an
 * empty value removes a phone or a note, and null clears the allergies. A list
 * of allergies that is not a list is refused rather than read as no change.
 */
function staffChangeOf(input: Record<string, unknown>): StaffChangeRequest | { problems: string[] } {
  const allergies = input['allergies'];
  if (allergies !== undefined && allergies !== null && !Array.isArray(allergies)) return { problems: ['allergies must be a list'] };
  const change: StaffChangeRequest = {};
  if (input['date'] !== undefined) change.date = String(input['date']);
  if (input['time'] !== undefined) change.time = String(input['time']);
  if (input['partySize'] !== undefined) change.partySize = Number(input['partySize']);
  if (input['guestName'] !== undefined) change.guestName = String(input['guestName'] ?? '');
  if (input['phone'] !== undefined) change.phone = String(input['phone'] ?? '');
  if (input['notes'] !== undefined) change.notes = String(input['notes'] ?? '');
  if (allergies !== undefined) change.allergies = (allergies ?? []).map(String);
  if (typeof input['table'] === 'string') change.table = input['table'];
  if (isLanguage(input['language'])) change.language = input['language'];
  if (isLanguage(input['guestLanguage'])) change.guestLanguage = input['guestLanguage'];
  return change;
}

/** The public demo: a visitor opens a restaurant of their own and uses it as a guest and as its owner. */
async function demo(request: Request, env: Env, url: URL, rest: readonly string[]): Promise<Response> {
  if (matcher(request, rest)('GET')) return demoStatus(env);
  if (matcher(request, rest)('POST', 'sandboxes')) return openSandbox(request, env);
  const voiceReport = VOICE_REPORTS.find((report) => matcher(request, rest)('POST', 'voice', report));
  if (voiceReport) return reportVoice(request, env, voiceReport);
  if (rest[0] !== 'sandboxes' || rest.length < 3) return problem(404, 'not_found');

  const sandboxId = rest[1] ?? '';
  if (!SANDBOX_ID.test(sandboxId)) return problem(404, 'not_found');
  const inner = rest.slice(2);
  const at = matcher(request, inner);
  const callStep = DEMO_CALL_STEPS.find((step) => at('POST', 'calls', null, step));
  const known =
    at('POST', 'chat') ||
    at('POST', 'sessions', null, 'phone') ||
    at('POST', 'calls') ||
    callStep !== undefined ||
    at('GET', 'clock') ||
    isStaffRoute(request, inner);
  if (!known) return problem(405, 'method_or_route_not_allowed');

  const sandbox = demoStub(env, sandboxId);
  if (!sandbox) return problem(503, 'not_configured');
  // An id that was never opened, or a restaurant past its day, is simply not there.
  const state = await sandbox.state();
  if (state.status === 'not_found') return problem(404, 'not_found');

  if (at('POST', 'calls')) return openCall(request, env, sandboxId, sandbox);
  if (callStep !== undefined) return demoCall(request, env, callStep, inner[1] ?? '', sandbox);

  if (at('POST', 'chat')) {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const result = await sandbox.demoChat({
      sessionId: String(body.value['sessionId'] ?? ''),
      message: String(body.value['message'] ?? ''),
      language: String(body.value['language'] ?? ''),
    });
    return demoAnswer(result);
  }
  if (at('POST', 'sessions', null, 'phone')) {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    return demoAnswer(await sandbox.demoSetPhone(inner[1] ?? '', String(body.value['phone'] ?? '')));
  }
  if (at('GET', 'clock')) return json(state);
  return staff(request, url, inner, sandbox);
}

/** A turn of the demo's chat as HTTP: what each limit is called, so the page can say which one it met. */
function demoAnswer(result: Awaited<ReturnType<DemoRestaurant['demoChat']>> | Awaited<ReturnType<DemoRestaurant['demoSetPhone']>>): Response {
  switch (result.status) {
    case 'ok':
      return json(result);
    case 'invalid':
      return json(result, 400);
    case 'rate_limited':
      return problem(429, 'rate_limited');
    case 'sandbox_limit':
      return problem(429, 'sandbox_limit');
    case 'not_found':
      return problem(404, 'not_found');
    default:
      // Past the budget or without the demo's key: the demo says it is paused, it never runs open.
      return problem(503, 'live_paused');
  }
}

/**
 * The pass for a visitor to call their restaurant from the browser, within its
 * calls and the demo's budget. The voice agent is sent to the room with the
 * call's id and the restaurant's, in a signed pass the browser cannot change.
 */
async function openCall(request: Request, env: Env, sandboxId: string, sandbox: DurableObjectStub<DemoRestaurant>): Promise<Response> {
  const project = liveKitProject(env);
  if (!project || !env.AGENT_TOKEN || !env.DEMO_OPENROUTER_API_KEY) return problem(503, 'not_configured');
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const language = isLanguage(body.value['language']) ? body.value['language'] : 'fr';
  // A page that still shows the button after the voice went down: the call would ring with nobody to answer.
  const budget = budgetStub(env);
  if (!budget || !(await budget.voiceReady())) return problem(409, 'calls_unavailable');
  const allowed = await sandbox.allowCall();
  switch (allowed.status) {
    case 'ok':
      break;
    case 'call_limit':
    case 'rate_limited':
    case 'sandbox_limit':
      return problem(429, allowed.status);
    case 'not_found':
      return problem(404, 'not_found');
    default:
      return problem(503, 'live_paused');
  }
  const token = await callPass(project, {
    room: `demo-${allowed.sessionId}`,
    identity: `visitor-${allowed.sessionId}`,
    agentName: env.LIVEKIT_AGENT_NAME,
    agentMetadata: JSON.stringify({ sandbox: sandboxId, sessionId: allowed.sessionId, language }),
    // Long enough to join and to reconnect during the call, not to keep.
    ttlSeconds: allowed.maxSeconds + 120,
  });
  return json({ url: project.url, token, sessionId: allowed.sessionId, maxSeconds: allowed.maxSeconds, callsLeft: allowed.callsLeft }, 201);
}

/** The voice agent's side of a demo call, with the agent's token: the visitor's browser never reaches these. */
async function demoCall(request: Request, env: Env, step: DemoCallStep, sessionId: string, sandbox: DurableObjectStub<DemoRestaurant>): Promise<Response> {
  const denied = await authorized(request, env, 'agent');
  if (denied) return denied;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = body.value;
  switch (step) {
    case 'start': {
      const started = await sandbox.demoStartCall(sessionId, String(input['language'] ?? ''));
      return started.status === 'ok' ? json(started) : callAnswer(started);
    }
    case 'turns':
      return callAnswer(await sandbox.demoCallTurn(callTurn(sessionId, input)));
    case 'keypad':
      return callAnswer(await sandbox.demoKeypad({ sessionId, turnId: String(input['turnId'] ?? ''), digits: String(input['digits'] ?? '') }));
    case 'usage': {
      const usage = await sandbox.demoCallUsage(sessionId, input['seconds']);
      return usage.status === 'ok' ? json(usage) : callAnswer(usage);
    }
    case 'end': {
      const ended = await sandbox.demoEndCall(callEnd(sessionId, input));
      return ended.status === 'ok' ? json(ended) : callAnswer(ended);
    }
  }
}

/** Opens a visitor's restaurant: for a person, not a script, within the visitor's daily count and the demo's budget. */
async function openSandbox(request: Request, env: Env): Promise<Response> {
  const budget = budgetStub(env);
  if (!env.TURNSTILE_SECRET || !env.DEMO_OPENROUTER_API_KEY || !budget) return problem(503, 'not_configured');
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const ip = request.headers.get('cf-connecting-ip');
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, String(body.value['turnstile'] ?? ''), ip))) return problem(403, 'turnstile_failed');
  const allowed = await budget.allowSandbox(await visitorKey(ip ?? 'unknown', env.TURNSTILE_SECRET));
  if (allowed === 'too_many_sandboxes') return problem(429, 'too_many_sandboxes');
  if (allowed === 'live_paused') return problem(503, 'live_paused');
  const sandboxId = newSandboxId();
  const sandbox = demoStub(env, sandboxId);
  if (!sandbox) return problem(503, 'not_configured');
  // The page's language: the evening's requests and notes are written in it.
  const state = await sandbox.open(isLanguage(body.value['language']) ? body.value['language'] : undefined);
  if (state.status !== 'ok') return problem(500, 'internal_error');
  const { expiresAt, clock, day, suggestion, callsLeft } = state;
  return json({ sandbox: sandboxId, expiresAt, clock, day, suggestion, callsLeft, calls: await callOffer(env, budget) }, 201);
}

/**
 * Whether the demo is open now, and the call's terms: what a page asks on
 * every visit, so it shows the chat and the call button only when they work.
 * Opening a restaurant to find out would spend the visitor's daily quota.
 */
async function demoStatus(env: Env): Promise<Response> {
  const budget = budgetStub(env);
  const live = budget !== undefined && Boolean(env.DEMO_OPENROUTER_API_KEY) && (await budget.status()) === 'live';
  // The restaurant lives at the real time: a page shows it before any restaurant is opened.
  const now = new Date();
  return json({
    live,
    calls: live ? await callOffer(env, budget) : null,
    now: now.toISOString(),
    today: localNow(now, DEMO_RESTAURANT.timeZone).date,
    day: serviceDayAt(now),
    suggestion: demoSuggestion(now),
  });
}

/**
 * Whether the demo can take calls, and on what terms: the page shows its call
 * button only then, never one that would fail. Configured is not enough: a
 * voice agent must have checked in lately, with speech that works.
 */
async function callOffer(env: Env, budget: DurableObjectStub<DemoBudget> | undefined): Promise<{ perRestaurant: number; maxSeconds: number } | null> {
  const perRestaurant = Number(env.DEMO_CALLS_PER_SANDBOX);
  const maxSeconds = Number(env.DEMO_CALL_SECONDS);
  if (!liveKitProject(env) || !env.AGENT_TOKEN || !(perRestaurant > 0) || !(maxSeconds > 0)) return null;
  if (!budget || !(await budget.voiceReady())) return null;
  return { perRestaurant, maxSeconds };
}

const VOICE_REPORTS = ['check-in', 'call-failed'] as const;

/**
 * The voice agent's word on itself, with the agent's token: every minute it
 * checks in, saying whether its speech works, and a call that failed on its
 * speech says so at once.
 */
async function reportVoice(request: Request, env: Env, report: (typeof VOICE_REPORTS)[number]): Promise<Response> {
  const denied = await authorized(request, env, 'agent');
  if (denied) return denied;
  const budget = budgetStub(env);
  if (!budget) return problem(503, 'not_configured');
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const reason = typeof body.value['reason'] === 'string' ? body.value['reason'] : undefined;
  if (report === 'call-failed') await budget.voiceFailed(reason ?? 'speech_error');
  else await budget.voiceCheckIn({ ready: body.value['ready'] === true, ...(reason ? { reason } : {}) });
  return json({ status: 'ok', calls: await budget.voiceReady() });
}
