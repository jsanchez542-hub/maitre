import { reset, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localNow } from '../../src/calendar.js';
import { parseDay, resolveDate } from '../../src/dates.js';

const BASE = 'https://maitre.test/v1/restaurants/demo';
const STAFF = { authorization: 'Bearer test-staff-token', 'content-type': 'application/json' };
const AGENT = { authorization: 'Bearer test-agent-token', 'content-type': 'application/json' };

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function nextFriday(): string {
  const spec = parseDay('friday next week');
  const resolved = spec && resolveDate(spec, localNow(new Date(), 'Europe/Paris').date);
  if (!resolved || !resolved.ok) throw new Error('could not work out next Friday');
  return resolved.date;
}

describe('a restaurant’s activity', () => {
  it('shows what came in today: a booking taken by hand and a call the assistant answered', async () => {
    const booked = await SELF.fetch(`${BASE}/staff/bookings`, {
      method: 'POST',
      headers: STAFF,
      body: JSON.stringify({ date: nextFriday(), time: '20:00', partySize: 4, guestName: 'Garnier' }),
    });
    expect(booked.status).toBe(201);
    await SELF.fetch(`${BASE}/calls/call-activity-01/start`, { method: 'POST', headers: AGENT, body: JSON.stringify({ language: 'fr' }) });
    await SELF.fetch(`${BASE}/calls/call-activity-01/end`, {
      method: 'POST',
      headers: AGENT,
      body: JSON.stringify({ endedBy: 'goodbye', seconds: 70, voiceToVoiceMs: [1900, 2300] }),
    });

    const response = await SELF.fetch(`${BASE}/activity?days=7`, { headers: STAFF });
    expect(response.status).toBe(200);
    const today = localNow(new Date(), 'Europe/Paris').date;
    expect(await response.json()).toMatchObject({
      to: today,
      bookings: { made: 1, covers: 4, byChannel: { staff: 1, voice: 0, web: 0, whatsapp: 0 } },
      calls: { answered: 1, minutes: 1, answerMs: { median: 1900, p90: 2300 } },
    });
  });

  it('is for the staff, over a span the conversations are kept for', async () => {
    expect((await SELF.fetch(`${BASE}/activity`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/activity?days=0`, { headers: STAFF })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/activity?days=365`, { headers: STAFF })).status).toBe(400);
  });
});
