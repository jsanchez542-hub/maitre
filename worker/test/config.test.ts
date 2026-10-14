import { reset, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localNow } from '../../src/calendar.js';
import { parseDay, resolveDate } from '../../src/dates.js';

const BASE = 'https://maitre.test/v1/restaurants/demo';
const DEMO = 'https://maitre.test/v1/demo';
const STAFF = { authorization: 'Bearer test-staff-token', 'content-type': 'application/json' };
const JSON_BODY = { 'content-type': 'application/json' };
const DINNER = { service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});

function nextMonday(): string {
  const spec = parseDay('monday next week');
  const resolved = spec && resolveDate(spec, localNow(new Date(), 'Europe/Paris').date);
  if (!resolved || !resolved.ok) throw new Error('could not work out next Monday');
  return resolved.date;
}

async function read(base: string, headers: Record<string, string> = STAFF): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`${base}/config`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function change(base: string, settings: unknown, headers: Record<string, string> = STAFF): Promise<Response> {
  return SELF.fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ settings }) });
}

/** A visitor's demo restaurant, Turnstile vouching for them. */
async function sandbox(): Promise<string> {
  const response = await SELF.fetch(`${DEMO}/sandboxes`, {
    method: 'POST',
    headers: { ...JSON_BODY, 'cf-connecting-ip': '203.0.113.20' },
    body: JSON.stringify({ turnstile: 'a-token-from-the-widget' }),
  });
  expect(response.status).toBe(201);
  return String(((await response.json()) as { sandbox: string }).sandbox);
}

function vouchingTurnstile(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
    throw new Error(`unexpected request to ${url}`);
  });
}

describe('a restaurant’s settings', () => {
  it('are the ones it runs on, for its staff alone', async () => {
    expect(await read(BASE)).toMatchObject({ name: 'Merrain', timeZone: 'Europe/Paris', maxPartySize: 6 });
    expect((await SELF.fetch(`${BASE}/config`)).status).toBe(401);
    expect((await change(BASE, { maxPartySize: 4 }, JSON_BODY)).status).toBe(401);
  });

  it('change where an owner edits them, and the restaurant books by its new hours at once', async () => {
    // Merrain is closed on Mondays; its owner opens Monday dinner.
    const monday = nextMonday();
    const bookMonday = () =>
      SELF.fetch(`${BASE}/staff/bookings`, {
        method: 'POST',
        headers: STAFF,
        body: JSON.stringify({ date: monday, time: '20:00', partySize: 2, guestName: 'Lundi' }),
      });
    expect(await (await bookMonday()).json()).toMatchObject({ status: 'unavailable', reason: 'closed' });

    const { weekly } = (await read(BASE)) as { weekly: Record<string, unknown[]> };
    const saved = await change(BASE, { weekly: { ...weekly, 1: [DINNER] } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ status: 'ok', config: { weekly: { 1: [DINNER] } } });
    expect((await bookMonday()).status).toBe(201);
    // Kept: read again, they are the new ones.
    expect(await read(BASE)).toMatchObject({ weekly: { 1: [DINNER] } });
  });

  it('refuse what does not hold, or what an owner does not change from the dashboard, and keep nothing of it', async () => {
    const negative = await change(BASE, { minNoticeMinutes: -5 });
    expect([negative.status, await negative.json()]).toEqual([400, { status: 'invalid', problems: ['minNoticeMinutes must be from 0 to 10080'] }]);
    // Parties of eight, with no table for more than six.
    expect((await change(BASE, { maxPartySize: 8 })).status).toBe(400);
    const tables = await change(BASE, { tables: [] });
    expect(await tables.json()).toEqual({ status: 'invalid', problems: ['tables cannot be changed from the dashboard'] });
    expect(await (await change(BASE, { menu: 'tout' })).json()).toEqual({ status: 'invalid', problems: ['the settings are not in the expected shape'] });
    expect((await change(BASE, ['menu'])).status).toBe(400);
    expect(await read(BASE)).toMatchObject({ minNoticeMinutes: 60, maxPartySize: 6 });
  });

  it('in a visitor’s demo restaurant, change that restaurant alone, and its dashboard follows them', async () => {
    vouchingTurnstile();
    vi.useFakeTimers({ toFake: ['Date'] });
    // Monday 19 October at 15:00: closed today, so the dashboard opens on Tuesday's service.
    vi.setSystemTime(new Date('2026-10-19T13:00:00Z'));
    const mine = await sandbox();
    const theirs = await sandbox();
    const clock = async (id: string) => (await (await SELF.fetch(`${DEMO}/sandboxes/${id}/clock`)).json()) as Record<string, unknown>;
    expect(await clock(mine)).toMatchObject({ day: '2026-10-20' });

    const { weekly } = (await read(`${DEMO}/sandboxes/${mine}`, JSON_BODY)) as { weekly: Record<string, unknown[]> };
    expect((await change(`${DEMO}/sandboxes/${mine}`, { weekly: { ...weekly, 1: [DINNER] }, maxPartySize: 4 }, JSON_BODY)).status).toBe(200);
    expect(await clock(mine)).toMatchObject({ day: '2026-10-19', suggestion: { date: '2026-10-19' } });
    expect(await read(`${DEMO}/sandboxes/${theirs}`, JSON_BODY)).toMatchObject({ maxPartySize: 6 });
    expect(await clock(theirs)).toMatchObject({ day: '2026-10-20' });
  });
});
