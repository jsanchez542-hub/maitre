import { describe, expect, it } from 'vitest';
import { callsFrom, conversationsOf, medianOf, turnsFrom, type TurnRecord } from './conversations';

const turn = (sessionId: string, at: string, tools: { name: string; status: string }[] = [], outcome = 'answered'): TurnRecord => ({
  at,
  sessionId,
  channel: 'web',
  language: 'fr',
  guest: 'Bonsoir',
  phoneEntered: false,
  reply: 'Bonsoir.',
  outcome,
  latencyMs: 2100,
  costUsd: 0.0011,
  fellBack: false,
  tools,
  corrections: [],
  booked: [],
  changed: [],
  cancelled: [],
  passedToTeam: false,
  phone: null,
});

describe('the assistant’s log, read from the Worker', () => {
  it('keeps the well-formed turns and leaves the rest out', () => {
    const read = turnsFrom([
      {
        at: '2026-10-14T19:40:00.000Z',
        sessionId: 's1',
        channel: 'web',
        language: 'fr',
        guest: 'Une table pour 2 demain',
        reply: 'C’est noté.',
        outcome: 'answered',
        latencyMs: 2400,
        modelCalls: 2,
        usage: {},
        costUsd: 0.0012,
        tools: [{ name: 'find_table', status: 'available' }, { name: 'book_table' }],
        corrections: ['guessed_title', 3],
      },
      { at: 'not a date', sessionId: 's2', channel: 'web', language: 'fr', guest: '', reply: '', latencyMs: 1 },
      { at: '2026-10-14T19:41:00.000Z', sessionId: 's3', channel: 'fax', language: 'fr', guest: '', reply: '', latencyMs: 1 },
      { at: '2026-10-14T19:42:00.000Z', sessionId: 's4', channel: 'web', language: 'de', guest: '', reply: '', latencyMs: 1 },
      'turn',
    ]);
    expect(read).toHaveLength(1);
    expect(read[0]?.tools).toEqual([{ name: 'find_table', status: 'available' }]);
    expect(read[0]?.corrections).toEqual(['guessed_title']);
    expect(read[0]?.costUsd).toBe(0.0012);
    // A turn logged before the Worker said what each turn did: no events, no number.
    expect(read[0]).toMatchObject({ booked: [], changed: [], cancelled: [], passedToTeam: false, phone: null });
    expect(turnsFrom({ turns: [] })).toEqual([]);
  });

  it('reads what a turn did to bookings, and the guest’s number, leaving out what is not well formed', () => {
    const [read] = turnsFrom([
      {
        at: '2026-10-14T19:40:00.000Z',
        sessionId: 's1',
        channel: 'whatsapp',
        language: 'fr',
        guest: 'Au nom de Lemoine',
        reply: 'C’est réservé.',
        latencyMs: 2400,
        tools: [{ name: 'book_table', status: 'booked' }],
        corrections: [],
        booked: [
          { reference: 'K7QF3M', date: '2026-10-15', time: '20:30', partySize: 2, guestName: 'Lemoine' },
          { reference: 'NONAME', date: '2026-10-15', time: '20:30', partySize: 2 },
          { reference: 'BADDAY', date: '15/10/2026', time: '20:30', partySize: 2, guestName: 'Faure' },
        ],
        changed: [{ reference: 'K7QF3M', date: '2026-10-16', time: '21:00', partySize: 3 }, 'moved'],
        cancelled: [{ reference: 'X1Y2Z3' }, { reference: 4 }],
        passedToTeam: true,
        phone: '+33 6 39 98 00 21',
      },
    ]);
    expect(read?.booked).toEqual([{ reference: 'K7QF3M', date: '2026-10-15', time: '20:30', partySize: 2, guestName: 'Lemoine' }]);
    expect(read?.changed).toEqual([{ reference: 'K7QF3M', date: '2026-10-16', time: '21:00', partySize: 3 }]);
    expect(read?.cancelled).toEqual([{ reference: 'X1Y2Z3' }]);
    expect(read).toMatchObject({ passedToTeam: true, phone: '+33 6 39 98 00 21' });
  });

  it('reads a call still going as one without its length or its ending', () => {
    const [going, ended] = callsFrom([
      { sessionId: 'c1', startedAt: '2026-10-14T19:40:00.000Z', language: 'es' },
      { sessionId: 'c2', startedAt: '2026-10-14T19:30:00.000Z', language: 'fr', seconds: 192, endedBy: 'goodbye', voiceToVoiceMs: [900, 'x', 1200] },
    ]);
    expect(going).toMatchObject({ seconds: null, endedBy: null, answerMs: [] });
    expect(ended).toMatchObject({ seconds: 192, endedBy: 'goodbye', answerMs: [900, 1200] });
  });
});

describe('conversations', () => {
  it('puts each guest’s turns together in the order they were said, the latest conversation first', () => {
    // As the Worker lists them, the latest first.
    const conversations = conversationsOf(
      [
        { ...turn('a', '2026-10-14T19:12:00.000Z'), reply: 'second' },
        turn('b', '2026-10-14T19:10:00.000Z'),
        { ...turn('a', '2026-10-14T19:01:00.000Z'), reply: 'first' },
      ],
      [],
    );
    expect(conversations.map((conversation) => conversation.sessionId)).toEqual(['b', 'a']);
    expect(conversations[1]?.turns.map((said) => said.reply)).toEqual(['first', 'second']);
  });

  it('keeps the Worker’s order for two turns written in the same millisecond', () => {
    const at = '2026-10-14T19:01:00.000Z';
    const [conversation] = conversationsOf([{ ...turn('a', at), reply: 'second' }, { ...turn('a', at), reply: 'first' }], []);
    expect(conversation?.turns.map((said) => said.reply)).toEqual(['first', 'second']);
  });

  it('gives a call its turns, and keeps a call in which nobody spoke', () => {
    const [silent, spoken] = conversationsOf(
      [{ ...turn('call-1', '2026-10-14T19:00:20.000Z'), channel: 'voice' }],
      [
        { sessionId: 'call-1', startedAt: '2026-10-14T19:00:00.000Z', language: 'fr', seconds: 95, endedBy: 'goodbye', answerMs: [1100] },
        { sessionId: 'call-2', startedAt: '2026-10-14T19:20:00.000Z', language: 'en', seconds: 8, endedBy: 'caller', answerMs: [] },
      ],
    );
    expect(spoken).toMatchObject({ sessionId: 'call-1', channel: 'voice', startedAt: '2026-10-14T19:00:00.000Z', result: 'answered' });
    expect(spoken?.turns).toHaveLength(1);
    expect(silent).toMatchObject({ sessionId: 'call-2', channel: 'voice', language: 'en', result: 'silent', turns: [] });
  });

  it('says what the engine did, not what the reply said', () => {
    // Each turn's errands in the order they were said; the Worker lists them the latest first.
    const resultOf = (tools: { name: string; status: string }[][], outcome?: string) =>
      conversationsOf(
        tools.map((errands, index) => turn('s', `2026-10-14T19:0${index}:00.000Z`, errands, outcome)).reverse(),
        [],
      )[0];
    expect(resultOf([[{ name: 'find_table', status: 'available' }], [{ name: 'book_table', status: 'booked' }]])?.result).toBe('booked');
    // A table held but never booked is no booking, whatever the reply promised.
    expect(resultOf([[{ name: 'find_table', status: 'available' }], [{ name: 'book_table', status: 'hold_expired' }]])?.result).toBe('answered');
    expect(resultOf([[{ name: 'book_table', status: 'booked' }], [{ name: 'change_booking', status: 'changed' }]])?.result).toBe('booked');
    expect(resultOf([[{ name: 'change_booking', status: 'changed' }]])?.result).toBe('changed');
    expect(resultOf([[{ name: 'book_table', status: 'booked' }], [{ name: 'cancel_booking', status: 'cancelled' }]])?.result).toBe('cancelled');
    expect(resultOf([[{ name: 'confirm_booking', status: 'confirmed' }]])?.result).toBe('confirmed');
    expect(resultOf([[{ name: 'hand_over', status: 'recorded' }]])).toMatchObject({ result: 'answered', passedToTeam: true });
    expect(resultOf([[]], 'failed_handed_over')).toMatchObject({ passedToTeam: true });
    expect(resultOf([[{ name: 'hand_over', status: 'invalid_input' }]])?.passedToTeam).toBe(false);
  });

  it('knows who the guest was, and the booking as it stands at the end', () => {
    const made = { reference: 'K7QF3M', date: '2026-10-15', time: '20:30', partySize: 2 };
    const [conversation] = conversationsOf(
      [
        { ...turn('s', '2026-10-14T19:03:00.000Z'), changed: [{ ...made, time: '21:00' }], phone: '+33 6 39 98 00 21' },
        { ...turn('s', '2026-10-14T19:02:00.000Z'), booked: [{ ...made, guestName: 'Lemoine' }], phone: '+33 6 39 98 00 21' },
        turn('s', '2026-10-14T19:01:00.000Z'),
      ],
      [],
    );
    // Moved in the conversation that made it, it is still that conversation's booking, at its new time.
    expect(conversation).toMatchObject({ result: 'booked', guestName: 'Lemoine', phone: '+33 6 39 98 00 21' });
    expect(conversation?.booking).toEqual({ ...made, time: '21:00' });
  });

  it('passes a question on to the team as the Worker logged it, an allergen sheet’s silence included', () => {
    const [conversation] = conversationsOf([{ ...turn('s', '2026-10-14T19:01:00.000Z', [{ name: 'check_dish', status: 'ok' }]), passedToTeam: true }], []);
    expect(conversation).toMatchObject({ result: 'answered', passedToTeam: true, guestName: null, phone: null });
  });

  it('says what an older turn did from the engine’s statuses alone, without the booking’s details', () => {
    const [conversation] = conversationsOf([turn('s', '2026-10-14T19:01:00.000Z', [{ name: 'book_table', status: 'booked' }])], []);
    expect(conversation).toMatchObject({ result: 'booked', booking: null, guestName: null });
  });

  it('takes the middle answer time of a call', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([1300, 900, 1100])).toBe(1100);
    expect(medianOf([900, 1300, 1100, 1000])).toBe(1050);
  });
});
