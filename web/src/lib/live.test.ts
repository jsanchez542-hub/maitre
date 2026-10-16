import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveError, openLine, openSandbox, readClockOf, readDemoStatus, say, sendPhone } from './live';

/** Friday 16 at 20:05 in Bordeaux: tonight's 20:30 is past its hour's notice, so the table offered is Saturday's. */
const TIME = { clock: '2026-10-16T18:05:00.000Z', day: '2026-10-16', suggestion: { date: '2026-10-17', time: '20:30', partySize: 2 }, callsLeft: 3 };

function answering(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
}

async function problemOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof LiveError) return error.problem;
    throw error;
  }
  throw new Error('the call did not fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the live demo’s API', () => {
  it('opens a restaurant of the visitor’s own, in the page’s language, on the real time, with the calls it takes or none', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ sandbox: 'abc', expiresAt: '2026-10-13T20:00:00.000Z', ...TIME, calls: { perRestaurant: 3, maxSeconds: 240 } }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(openSandbox('token', 'en')).resolves.toEqual({ id: 'abc', expiresAt: '2026-10-13T20:00:00.000Z', ...TIME, calls: { perRestaurant: 3, maxSeconds: 240 } });
    expect(fetch).toHaveBeenCalledWith('/v1/demo/sandboxes', expect.objectContaining({ method: 'POST', body: JSON.stringify({ turnstile: 'token', language: 'en' }) }));
    answering(201, { sandbox: 'abc', expiresAt: '2026-10-13T20:00:00.000Z', ...TIME, calls: null });
    await expect(openSandbox('token', 'fr')).resolves.toMatchObject({ calls: null });
  });

  it('asks whether the demo is open at /v1/demo itself, with the restaurant’s time, and offers no calls while it is closed', async () => {
    const status = { now: TIME.clock, today: '2026-10-16', day: TIME.day, suggestion: TIME.suggestion };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ live: true, calls: { perRestaurant: 3, maxSeconds: 240 }, ...status }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(readDemoStatus()).resolves.toEqual({ live: true, calls: { perRestaurant: 3, maxSeconds: 240 }, ...status });
    expect(fetch).toHaveBeenCalledWith('/v1/demo', expect.objectContaining({ method: 'GET' }));
    answering(200, { live: false, calls: { perRestaurant: 3, maxSeconds: 240 }, ...status });
    await expect(readDemoStatus()).resolves.toEqual({ live: false, calls: null, ...status });
    answering(200, { open: true });
    expect(await problemOf(readDemoStatus())).toBe('unexpected');
  });

  it('reads the restaurant’s clock, and refuses a time it cannot read', async () => {
    answering(200, { status: 'ok', expiresAt: '2026-10-13T20:00:00.000Z', ...TIME });
    await expect(readClockOf('abc')).resolves.toEqual(TIME);
    answering(200, { status: 'ok', ...TIME, clock: 'ce soir' });
    expect(await problemOf(readClockOf('abc'))).toBe('unexpected');
    answering(200, { status: 'ok', ...TIME, suggestion: { date: '2026-10-17', time: '8:30 pm', partySize: 2 } });
    expect(await problemOf(readClockOf('abc'))).toBe('unexpected');
  });

  it('asks for a line to the restaurant, and names the refusals of a call', async () => {
    answering(201, { url: 'wss://example.livekit.cloud', token: 'pass', sessionId: 'call-1', maxSeconds: 240, callsLeft: 2 });
    await expect(openLine('abc', 'fr')).resolves.toEqual({ url: 'wss://example.livekit.cloud', token: 'pass', sessionId: 'call-1', maxSeconds: 240, callsLeft: 2 });
    // A Worker that does not count: the screen falls back on the restaurant's allowance.
    answering(201, { url: 'wss://example.livekit.cloud', token: 'pass', sessionId: 'call-1', maxSeconds: 240 });
    await expect(openLine('abc', 'fr')).resolves.toMatchObject({ callsLeft: null });
    answering(429, { error: 'call_limit' });
    expect(await problemOf(openLine('abc', 'fr'))).toBe('call_limit');
    answering(201, { url: 'wss://example.livekit.cloud' });
    expect(await problemOf(openLine('abc', 'fr'))).toBe('unexpected');
  });

  it('names each of the Worker’s refusals, and only those', async () => {
    for (const [status, code] of [
      [403, 'turnstile_failed'],
      [429, 'too_many_sandboxes'],
      [503, 'live_paused'],
      [429, 'rate_limited'],
      [429, 'sandbox_limit'],
      [404, 'not_found'],
    ] as const) {
      answering(status, { error: code });
      expect(await problemOf(say('abc', 'session-1', 'Bonsoir', 'fr'))).toBe(code);
    }
    answering(400, { error: 'body_too_large' });
    expect(await problemOf(say('abc', 'session-1', 'Bonsoir', 'fr'))).toBe('invalid');
    // A code that happens to be the name of an object's own method is still a code nobody knows.
    answering(500, { error: 'constructor' });
    expect(await problemOf(say('abc', 'session-1', 'Bonsoir', 'fr'))).toBe('unexpected');
  });

  it('tells a lost connection from an answer it cannot read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await problemOf(say('abc', 'session-1', 'Bonsoir', 'fr'))).toBe('offline');
    answering(502, '<html>Bad gateway</html>');
    expect(await problemOf(say('abc', 'session-1', 'Bonsoir', 'fr'))).toBe('unexpected');
  });

  it('takes what the turn did from the engine’s answer, and leaves out what is not a booking', async () => {
    answering(200, {
      status: 'ok',
      reply: 'Votre réservation est confirmée.',
      outcome: 'answered',
      askForPhone: false,
      booked: [{ reference: 'AB12CD', date: '2026-10-16', time: '21:30', partySize: 2 }, { reference: 'broken' }],
      passedToTeam: false,
    });
    await expect(say('abc', 'session-1', 'Lemoine', 'fr')).resolves.toEqual({
      reply: 'Votre réservation est confirmée.',
      askForPhone: false,
      booked: [{ reference: 'AB12CD', date: '2026-10-16', time: '21:30', partySize: 2 }],
      passedToTeam: false,
    });
  });

  it('says when the number in the field cannot be read, without calling it a failure', async () => {
    answering(400, { status: 'invalid', problems: ['the number cannot be read'] });
    await expect(sendPhone('abc', 'session-1', '12')).resolves.toEqual({ status: 'unreadable' });
  });
});
