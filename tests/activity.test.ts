import { describe, expect, it } from 'vitest';
import { activityOf } from '../src/activity.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import type { Booking, CallbackRequest } from '../src/store.js';

const booking = (channel: Booking['channel'], partySize: number, extra: Partial<Booking> = {}): Booking =>
  ({ channel, partySize, createdAt: '2026-10-13T10:00:00Z', ...extra }) as Booking;

describe('what the assistant did for a restaurant', () => {
  it('counts the bookings it brought in by channel, the conversations it held and the calls it answered', () => {
    const activity = activityOf({
      config: DEMO_RESTAURANT,
      from: '2026-10-07',
      to: '2026-10-13',
      bookings: [booking('voice', 4), booking('voice', 2), booking('web', 2), booking('staff', 6), booking('staff', 3, { walkIn: true })],
      turns: [
        { at: '2026-10-12T18:00:00Z', sessionId: 'web-1', channel: 'web' },
        { at: '2026-10-12T18:01:00Z', sessionId: 'web-1', channel: 'web' },
        { at: '2026-10-12T19:00:00Z', sessionId: 'wa-1', channel: 'whatsapp' },
        { at: '2026-10-12T20:00:00Z', sessionId: 'call-1', channel: 'voice' },
      ],
      calls: [
        // Tuesday 13 at 20:30 in Bordeaux, in the middle of dinner.
        { startedAt: '2026-10-13T18:30:00Z', seconds: 95, voiceToVoiceMs: [1800, 2400, 2100] },
        // Monday 12 at 11:00: closed all day.
        { startedAt: '2026-10-12T09:00:00Z', seconds: 61, voiceToVoiceMs: [3000] },
        // Tuesday 13 at 16:00: between lunch and dinner.
        { startedAt: '2026-10-13T14:00:00Z' },
      ],
      callbacks: [{ id: 'c1' } as CallbackRequest],
    });
    expect(activity).toEqual({
      from: '2026-10-07',
      to: '2026-10-13',
      // A party on the spot is not a booking brought in.
      bookings: { made: 4, covers: 14, byChannel: { web: 1, whatsapp: 0, voice: 2, staff: 1 } },
      conversations: { written: 2, turns: 4, passedToTeam: 1 },
      calls: { answered: 3, duringService: 1, whileClosed: 2, minutes: 3, answerMs: { median: 2100, p90: 3000 } },
    });
  });

  it('says nothing of answer times without a call', () => {
    const activity = activityOf({ config: DEMO_RESTAURANT, from: '2026-10-13', to: '2026-10-13', bookings: [], turns: [], calls: [], callbacks: [] });
    expect(activity.calls).toEqual({ answered: 0, duringService: 0, whileClosed: 0, minutes: 0, answerMs: { median: null, p90: null } });
  });

  it('counts a call from just before dinner, and just after its last seating, as the service’s', () => {
    const call = (startedAt: string) => activityOf({ config: DEMO_RESTAURANT, from: '2026-10-13', to: '2026-10-13', bookings: [], turns: [], calls: [{ startedAt }], callbacks: [] }).calls;
    // 18:40, twenty minutes before the first seating; 22:20, fifty minutes after the last.
    expect(call('2026-10-13T16:40:00Z').duringService).toBe(1);
    expect(call('2026-10-13T20:20:00Z').duringService).toBe(1);
    // 23:00: the evening is over.
    expect(call('2026-10-13T21:00:00Z').whileClosed).toBe(1);
  });
});
