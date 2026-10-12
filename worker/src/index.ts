import { isLanguage } from '../../src/i18n/index.js';
import { newSandboxId, SANDBOX_ID, verifyTurnstile, visitorKey, type DemoRestaurant } from './demo.js';
import { budgetStub, demoStub, restaurantStub, type Env } from './env.js';
import { hasBearer, json, problem, readJson } from './http.js';
import { serveMedia } from './media.js';
import type { ChatRequest, Restaurant } from './restaurant.js';

export { DemoBudget, DemoRestaurant } from './demo.js';
export { Restaurant } from './restaurant.js';

/**
 * Routes, all under /v1/restaurants/:id/:
 *
 *   POST chat                          agent  one turn of a web or WhatsApp conversation
 *   POST sessions/:session/phone       agent  the number typed in the web chat's field
 *   POST tools/:name                   agent  one tool call from the voice agent
 *   GET  day?date=&language=           staff  the service of the day
 *   GET  conversations?limit=          staff  the latest turns, with latency and cost
 *   POST staff/bookings                staff  a booking taken by hand or a party on the spot, at a table if given
 *   POST staff/bookings/:ref/cancel    staff
 *   POST staff/bookings/:ref/no-show   staff
 *   POST staff/bookings/:ref/arrived   staff  the party is at the door
 *   POST staff/bookings/:ref/seated    staff  { table? } at its planned table or another
 *   POST staff/bookings/:ref/left      staff  the table is free again from now
 *   POST staff/bookings/:ref/table     staff  { table } moved there, and kept there
 *   POST staff/callbacks/:id/done      staff
 *
 * "agent" routes need AGENT_TOKEN and "staff" routes STAFF_TOKEN, as a bearer
 * token. A route whose secret is not configured answers 503 instead of running open.
 *
 * The public demo, under /v1/demo/:
 *
 *   POST sandboxes                                   { turnstile } opens a visitor's own restaurant
 *   POST sandboxes/:sandbox/chat                     { sessionId, message, language } with the real assistant
 *   POST sandboxes/:sandbox/sessions/:session/phone  { phone } typed in the chat's field
 *   GET  sandboxes/:sandbox/clock                    the evening's time
 *   POST sandboxes/:sandbox/clock                    { minutes } moves it on
 *   GET  sandboxes/:sandbox/day and conversations, POST sandboxes/:sandbox/staff/...  as the staff routes above
 *
 * A sandbox's id is the only key to it: 128 random bits, given once, to the browser that opened it.
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 1 && parts[0] === 'health' && request.method === 'GET') return json({ ok: true });
  if (parts[0] === 'media' && parts.length === 2) return serveMedia(request, env, parts[1] ?? '');
  if (parts[0] === 'v1' && parts[1] === 'demo') return demo(request, env, url, parts.slice(2));
  if (parts[0] !== 'v1' || parts[1] !== 'restaurants' || parts.length < 4) return problem(404, 'not_found');

  const restaurantId = parts[2] ?? '';
  const allowed = env.RESTAURANT_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (!allowed.includes(restaurantId)) return problem(404, 'not_found');
  const restaurant = restaurantStub(env, restaurantId);
  if (!restaurant) return problem(503, 'not_configured');
  const rest = parts.slice(3);
  const is = matcher(request, rest);

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

function isStaffRoute(request: Request, rest: readonly string[]): boolean {
  const is = matcher(request, rest);
  return (
    is('GET', 'day') ||
    is('GET', 'conversations') ||
    is('POST', 'staff', 'bookings') ||
    STAFF_ACTIONS.some((action) => is('POST', 'staff', 'bookings', null, action)) ||
    is('POST', 'staff', 'callbacks', null, 'done')
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
    });
    return json(result, result.status === 'invalid' ? 400 : result.status === 'unavailable' || result.status === 'table_taken' ? 409 : 201);
  }
  const target = rest[2] ?? '';
  if (rest[1] === 'callbacks') {
    const done = await restaurant.completeCallback(target);
    return json(done, done.status === 'not_found' ? 404 : 200);
  }
  // Every action may name the dashboard's language; "seated" and "table" also a table.
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const table = typeof body.value['table'] === 'string' ? body.value['table'] : undefined;
  const language = typeof body.value['language'] === 'string' ? body.value['language'] : undefined;
  let action;
  switch (rest[3] as StaffAction) {
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

const STAFF_ACTIONS = ['cancel', 'no-show', 'arrived', 'seated', 'left', 'table'] as const;
type StaffAction = (typeof STAFF_ACTIONS)[number];

/** The public demo: a visitor opens a restaurant of their own and uses it as a guest and as its owner. */
async function demo(request: Request, env: Env, url: URL, rest: readonly string[]): Promise<Response> {
  if (matcher(request, rest)('POST', 'sandboxes')) return openSandbox(request, env);
  if (rest[0] !== 'sandboxes' || rest.length < 3) return problem(404, 'not_found');

  const sandboxId = rest[1] ?? '';
  if (!SANDBOX_ID.test(sandboxId)) return problem(404, 'not_found');
  const inner = rest.slice(2);
  const at = matcher(request, inner);
  const known = at('POST', 'chat') || at('POST', 'sessions', null, 'phone') || at('GET', 'clock') || at('POST', 'clock') || isStaffRoute(request, inner);
  if (!known) return problem(405, 'method_or_route_not_allowed');

  const sandbox = demoStub(env, sandboxId);
  if (!sandbox) return problem(503, 'not_configured');
  // An id that was never opened, or a restaurant past its day, is simply not there.
  const state = await sandbox.state();
  if (state.status === 'not_found') return problem(404, 'not_found');

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
  if (at('POST', 'clock')) {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const moved = await sandbox.advance(body.value['minutes']);
    return json(moved, moved.status === 'ok' ? 200 : moved.status === 'not_found' ? 404 : 400);
  }
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
  const state = await sandbox.open();
  if (state.status !== 'ok') return problem(500, 'internal_error');
  return json({ sandbox: sandboxId, expiresAt: state.expiresAt, clock: state.clock }, 201);
}
