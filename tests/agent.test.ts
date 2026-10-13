import { describe, expect, it } from 'vitest';
import { respond, trimTranscript, turnEffects } from '../src/agent/agent.js';
import { ModelError, type TranscriptEntry } from '../src/agent/model.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { scriptedModel } from '../src/agent/providers/scripted.js';
import { BookingEngine } from '../src/engine.js';
import type { BookingStore } from '../src/store.js';
import { TEST_CONFIG, guest, harness, sequentialIds } from './fixtures.js';

const THIN = ' ';

function ticking(): () => number {
  let now = 0;
  return () => (now += 10);
}

describe('a turn of conversation', () => {
  it('lets the model call tools until it can answer, then books', async () => {
    const h = harness();
    const model = scriptedModel([
      { toolCalls: [{ name: 'find_table', input: { day: 'friday', time: '20:00', partySize: 4 } }] },
      { text: 'J’ai une table pour 4 personnes vendredi 16 octobre à 20 h. À quel nom ?' },
    ]);
    const first = await respond(h.engine, model, guest('g1'), [], 'Une table pour 4 vendredi à 20h ?', { clock: ticking() });
    expect(first.outcome).toBe('answered');
    expect(first.tools.map((tool) => tool.output.status)).toEqual(['available']);
    expect(first.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    const holdId = first.tools[0]?.output['holdId'];
    const book = scriptedModel([
      { toolCalls: [{ name: 'book_table', input: { holdId, guestName: 'Dupont', allergies: [] } }] },
      { text: 'C’est réservé au nom de Dupont.' },
    ]);
    const second = await respond(h.engine, book, guest('g1'), first.transcript, 'Dupont', { clock: ticking() });
    expect(second.tools[0]?.output).toMatchObject({ status: 'booked' });
    expect(h.store.snapshot().bookings).toHaveLength(1);
    // The second turn sent the whole conversation, the first turn's tool result included.
    expect(book.requests[0]?.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  });

  it('hears a guest whose last words lost their reply as one message: the caller spoke on before it began', async () => {
    const h = harness();
    const model = scriptedModel([{ text: 'Pour combien de personnes ?' }]);
    const unanswered: TranscriptEntry[] = [{ role: 'user', text: 'Bonsoir.' }];
    const result = await respond(h.engine, model, guest('v1', undefined, 'fr', 'voice'), unanswered, 'Je voudrais réserver une table.');
    expect(model.requests[0]?.transcript).toEqual([{ role: 'user', text: 'Bonsoir. Je voudrais réserver une table.' }]);
    expect(result.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant']);
  });

  it('asks for the number instead of passing on a booking that waits only for it (13 October)', async () => {
    const h = harness();
    const caller = guest('v1', null, 'fr', 'voice');
    const found = await respond(
      h.engine,
      scriptedModel([{ toolCalls: [{ name: 'find_table', input: { day: 'friday', time: '20:00', partySize: 4 } }] }, { text: 'À quel nom ?' }]),
      caller,
      [],
      'Une table pour 4 vendredi à 20 h',
    );
    const holdId = found.tools[0]?.output['holdId'];
    // As on the call: the booking got "phone_required" twice, and the model passed it to the team and promised a call back.
    const model = scriptedModel([
      { toolCalls: [{ name: 'book_table', input: { holdId, guestName: 'Dupont', allergies: [] } }] },
      { toolCalls: [{ name: 'hand_over', input: { reason: 'other', summary: 'Could not finish the booking' } }] },
      { text: 'Je suis désolé, je ne peux pas finaliser la réservation. J’ai transmis votre demande à l’équipe, qui vous rappellera.' },
    ]);
    const result = await respond(h.engine, model, caller, found.transcript, 'Au nom de Dupont, et personne n’a d’allergie.');
    expect(result.tools.map((tool) => tool.output.status)).toEqual(['phone_required', 'not_needed']);
    expect(String(result.tools[0]?.output['instruction'])).toContain('nothing has gone wrong');
    expect(h.store.snapshot().callbacks).toHaveLength(0);
    expect(result.reply).toBe('Pour confirmer la réservation, tapez votre numéro de téléphone sur le clavier, puis la touche dièse.');
    expect(result.corrections).toContain('needless_hand_over');

    // A real reason still goes to the team, number or not.
    const group = await respond(
      h.engine,
      scriptedModel([
        { toolCalls: [{ name: 'hand_over', input: { reason: 'large_group', summary: 'A group of 30 next month' } }] },
        { text: 'L’équipe vous rappellera pour le groupe.' },
      ]),
      caller,
      result.transcript,
      'Et pour un groupe de 30 le mois prochain ?',
    );
    expect(group.tools[0]?.output.status).toBe('recorded');
    expect(h.store.snapshot().callbacks).toHaveLength(1);
  });

  it('cleans the reply before the guest sees it', async () => {
    const h = harness();
    const model = scriptedModel([{ text: '**Bien sûr** — nous sommes ouverts.\n- le midi\n- le soir' }]);
    const web = await respond(h.engine, model, guest('g1'), [], 'Vous êtes ouverts ?');
    expect(web.reply).toBe('Bien sûr, nous sommes ouverts.\n• le midi\n• le soir');

    const voice = await respond(h.engine, scriptedModel([{ text: 'Avec plaisir 😊\n- le midi' }]), guest('v1', '+33612345678', 'fr', 'voice'), [], 'Allô');
    expect(voice.reply).toBe('Avec plaisir le midi');
  });

  it('answers an empty message without calling the model', async () => {
    const h = harness();
    const model = scriptedModel([]);
    const result = await respond(h.engine, model, guest('g1'), [], '   ');
    expect(result).toMatchObject({ outcome: 'empty_message', modelCalls: 0 });
    expect(result.reply).toBe(`Je n’ai pas reçu de message. Que puis-je faire pour vous${THIN}?`);
    expect(model.requests).toHaveLength(0);
  });

  it('asks the team to call back when the model fails and there is a number', async () => {
    const h = harness();
    const failing = scriptedModel(() => {
      throw new ModelError('overloaded', 'Provider answered 529');
    });
    const errors: unknown[] = [];
    const result = await respond(h.engine, failing, guest('g1'), [], 'Une table ce soir ?', { onError: (e) => errors.push(e) });
    expect(result.outcome).toBe('failed_handed_over');
    expect(result.reply).toContain('J’ai transmis votre demande à l’équipe');
    expect(h.store.snapshot().callbacks).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('asks the guest to try again when there is no number to call back', async () => {
    const h = harness();
    const failing = scriptedModel(() => {
      throw new ModelError('timeout', 'No answer');
    });
    const result = await respond(h.engine, failing, guest('w1', null, 'en', 'web'), [], 'A table tonight?');
    expect(result).toMatchObject({ outcome: 'failed_retry', reply: 'I am sorry, something went wrong on my side. Could you try again in a moment?' });
    expect(h.store.snapshot().callbacks).toHaveLength(0);
  });

  it('never promises a callback it could not record', async () => {
    const broken: BookingStore = {
      transaction() {
        throw new Error('storage is down');
      },
    };
    const engine = new BookingEngine(TEST_CONFIG, broken, { now: () => new Date('2026-10-14T08:00:00Z'), ids: sequentialIds() });
    const failing = scriptedModel(() => {
      throw new ModelError('server', 'Provider answered 500');
    });
    const result = await respond(engine, failing, guest('g1'), [], 'Une table ?');
    expect(result.outcome).toBe('failed_retry');
  });

  it('stops a model that keeps calling tools', async () => {
    const h = harness();
    const looping = scriptedModel(() => ({ toolCalls: [{ name: 'opening_hours', input: {} }] }));
    const result = await respond(h.engine, looping, guest('g1'), [], 'Horaires ?', { maxModelCalls: 3 });
    expect(result).toMatchObject({ outcome: 'failed_handed_over', modelCalls: 3 });
    expect(result.tools).toHaveLength(3);
  });

  it('tells the phone line which tools are about to run, and a listener that fails changes nothing', async () => {
    const h = harness();
    const heard: string[][] = [];
    const twoSteps = () =>
      scriptedModel([{ toolCalls: [{ name: 'opening_hours', input: {} }] }, { text: 'Nous sommes ouverts du mardi au samedi.' }]);
    const caller = guest('v1', '+33612345678', 'fr', 'voice');
    const result = await respond(h.engine, twoSteps(), caller, [], 'Vous êtes ouverts quand ?', { onToolCalls: (names) => heard.push([...names]) });
    expect(heard).toEqual([['opening_hours']]);
    expect(result.reply).toBe('Nous sommes ouverts du mardi au samedi.');

    const errors: unknown[] = [];
    const despite = await respond(h.engine, twoSteps(), caller, [], 'Vous êtes ouverts quand ?', {
      onToolCalls: () => {
        throw new Error('the line hung up');
      },
      onError: (error) => errors.push(error),
    });
    expect(despite).toMatchObject({ outcome: 'answered', reply: 'Nous sommes ouverts du mardi au samedi.' });
    expect(errors).toHaveLength(1);
  });

  it('adds up usage and the cost providers report', async () => {
    const h = harness();
    const priced = {
      id: 'test:priced',
      calls: 0,
      async complete() {
        this.calls += 1;
        return this.calls === 1
          ? { text: '', toolCalls: [{ id: 'c1', name: 'opening_hours', input: {} }], usage: { inputTokens: 1000, cacheWriteTokens: 0, cachedInputTokens: 500, outputTokens: 20 }, costUsd: 0.0002 }
          : { text: 'Nous sommes ouverts du mardi au dimanche.', toolCalls: [], usage: { inputTokens: 1200, cacheWriteTokens: 0, cachedInputTokens: 500, outputTokens: 30 }, costUsd: 0.0003 };
      },
    };
    const result = await respond(h.engine, priced, guest('g1'), [], 'Horaires ?', { clock: ticking() });
    expect(result.usage).toEqual({ inputTokens: 2200, cacheWriteTokens: 0, cachedInputTokens: 1000, outputTokens: 50 });
    expect(result.costUsd).toBeCloseTo(0.0005, 10);
    expect(result.modelCalls).toBe(2);
    expect(result.modelMs).toHaveLength(2);
  });
});

describe('what a turn did', () => {
  const booking = { reference: 'ACDEFH', date: '2026-10-16', time: '21:30', partySize: 2 };

  it('reads the bookings from the engine’s answers: made, asked for again, or moved', () => {
    expect(
      turnEffects([
        { name: 'find_table', output: { status: 'available', holdId: 'h1' } },
        { name: 'book_table', output: { status: 'booked', booking } },
        { name: 'book_table', output: { status: 'duplicate', booking: { ...booking, reference: 'BCDEFG' } } },
        { name: 'change_booking', output: { status: 'changed', booking: { ...booking, reference: 'CDEFGH', time: '21:00' } } },
      ]).booked.map((made) => made.reference),
    ).toEqual(['ACDEFH', 'BCDEFG', 'CDEFGH']);
  });

  it('says when the team was asked to call back, and when the web chat must show its phone field', () => {
    expect(turnEffects([{ name: 'hand_over', output: { status: 'recorded', needsPhone: true } }])).toEqual({ booked: [], passedToTeam: true, askForPhone: true });
    expect(turnEffects([{ name: 'check_dish', output: { status: 'ok', passedToTeam: true } }]).passedToTeam).toBe(true);
    expect(turnEffects([{ name: 'book_table', output: { status: 'phone_required' } }])).toEqual({ booked: [], passedToTeam: false, askForPhone: true });
    expect(turnEffects([{ name: 'book_table', output: { status: 'hold_expired' } }])).toEqual({ booked: [], passedToTeam: false, askForPhone: false });
  });
});

describe('the transcript', () => {
  it('keeps long conversations in bounds without cutting a tool call from its result', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 30; i += 1) {
      entries.push({ role: 'user', text: `message ${i}` });
      entries.push({ role: 'assistant', text: '', toolCalls: [{ id: `c${i}`, name: 'opening_hours', input: {} }] });
      entries.push({ role: 'tool', callId: `c${i}`, name: 'opening_hours', output: { status: 'ok' } });
      entries.push({ role: 'assistant', text: 'ok', toolCalls: [] });
    }
    const trimmed = trimTranscript(entries, 10);
    expect(trimmed.length).toBeLessThanOrEqual(10);
    expect(trimmed[0]?.role).toBe('user');
  });
});

describe('the system prompt', () => {
  it('gives today’s date and the time at the restaurant, and keeps the rules in the cacheable part', () => {
    const prompt = buildSystemPrompt(TEST_CONFIG, 'fr', 'voice', new Date('2026-10-14T08:00:00Z'));
    expect(prompt.dynamic).toContain('Today is Wednesday 14 October (2026-10-14) at the restaurant (Europe/Paris).');
    // The time changes every minute: it is said after the guest's last message, never before the cached conversation.
    expect(prompt.dynamic).not.toContain('10 am');
    expect(prompt.now).toBe('[Note from the system, not from the guest: it is 10 am at the restaurant now.]');
    expect(prompt.dynamic).toContain('intelligence artificielle');
    expect(prompt.stable).toContain('Always reply in French, addressing the guest as "vous"');
    expect(prompt.stable).toContain('Never say a table is free unless find_table returned status "available"');
    expect(prompt.stable).not.toContain('2026-10-14');
  });

  it('lists the dishes with their ids in the guest’s language, so allergen questions skip a call', () => {
    const prompt = buildSystemPrompt(TEST_CONFIG, 'es', 'web', new Date('2026-10-14T08:00:00Z'));
    expect(prompt.stable).toContain('- duck-confit = Confit de pato');
    expect(prompt.stable).toContain('- chocolate-mousse = Mousse de chocolate');
  });

  it('is identical from one turn to the next except for the clock, and from one minute to the next except for the time', () => {
    const a = buildSystemPrompt(TEST_CONFIG, 'en', 'web', new Date('2026-10-14T08:00:00Z'));
    const b = buildSystemPrompt(TEST_CONFIG, 'en', 'web', new Date('2026-10-15T19:30:00Z'));
    expect(a.stable).toBe(b.stable);
    expect(a.dynamic).not.toBe(b.dynamic);
    const later = buildSystemPrompt(TEST_CONFIG, 'en', 'web', new Date('2026-10-14T08:07:00Z'));
    expect(later.dynamic).toBe(a.dynamic);
    expect(later.now).not.toBe(a.now);
  });
});
