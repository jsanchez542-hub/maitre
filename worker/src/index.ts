import { restaurantStub, type Env } from './env.js';
import { hasBearer, json, problem, readJson } from './http.js';
import type { ChatRequest } from './restaurant.js';

export { Restaurant } from './restaurant.js';

/**
 * Routes, all under /v1/restaurants/:id/:
 *
 *   POST chat                          agent  one turn of a web or WhatsApp conversation
 *   POST sessions/:session/phone       agent  the number typed in the web chat's field
 *   POST tools/:name                   agent  one tool call from the voice agent
 *   GET  day?date=&language=           staff  the service of the day
 *   GET  conversations?limit=          staff  the latest turns, with latency and cost
 *   POST staff/bookings                staff  a booking taken by hand or a party on the spot
 *   POST staff/bookings/:ref/cancel    staff
 *   POST staff/bookings/:ref/no-show   staff
 *   POST staff/callbacks/:id/done      staff
 *
 * "agent" routes need AGENT_TOKEN and "staff" routes STAFF_TOKEN, as a bearer
 * token. A route whose secret is not configured answers 503 instead of running open.
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 1 && parts[0] === 'health' && request.method === 'GET') return json({ ok: true });
  if (parts[0] !== 'v1' || parts[1] !== 'restaurants' || parts.length < 4) return problem(404, 'not_found');

  const restaurantId = parts[2] ?? '';
  const allowed = env.RESTAURANT_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  if (!allowed.includes(restaurantId)) return problem(404, 'not_found');
  const restaurant = restaurantStub(env, restaurantId);
  if (!restaurant) return problem(503, 'not_configured');
  const rest = parts.slice(3);
  const is = (method: string, ...shape: (string | null)[]): boolean =>
    request.method === method && rest.length === shape.length && shape.every((part, index) => part === null || part === rest[index]);

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
  const staffRoute =
    is('GET', 'day') ||
    is('GET', 'conversations') ||
    is('POST', 'staff', 'bookings') ||
    is('POST', 'staff', 'bookings', null, 'cancel') ||
    is('POST', 'staff', 'bookings', null, 'no-show') ||
    is('POST', 'staff', 'callbacks', null, 'done');
  if (!staffRoute) return problem(rest.length > 0 ? 405 : 404, rest.length > 0 ? 'method_or_route_not_allowed' : 'not_found');
  const denied = await authorized(request, env, 'staff');
  if (denied) return denied;

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
    });
    return json(result, result.status === 'invalid' ? 400 : result.status === 'unavailable' ? 409 : 201);
  }
  const target = rest[2] ?? '';
  const action =
    rest[1] === 'callbacks'
      ? await restaurant.completeCallback(target)
      : rest[3] === 'cancel'
        ? await restaurant.staffCancel(target)
        : await restaurant.markNoShow(target);
  return json(action, action.status === 'not_found' ? 404 : action.status === 'not_allowed' ? 409 : 200);
}
