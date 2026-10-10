import { describe, expect, it } from 'vitest';
import { respond, trimTranscript } from '../src/agent/agent.js';
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
      { toolCalls: [{ name: 'find_table', input: { dateKind: 'weekday', weekday: 'friday', week: 'this', time: '20:00', partySize: 4 } }] },
      { text: 'J’ai une table pour 4 personnes vendredi 16 octobre à 20 h. À quel nom ?' },
    ]);
    const first = await respond(h.engine, model, guest('g1'), [], 'Une table pour 4 vendredi à 20h ?', { clock: ticking() });
    expect(first.outcome).toBe('answered');
    expect(first.tools.map((tool) => tool.output.status)).toEqual(['available']);
    expect(first.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    const holdId = first.tools[0]?.output['holdId'];
    const book = scriptedModel([
      { toolCalls: [{ name: 'book_table', input: { holdId, guestName: 'Dupont' } }] },
      { text: 'C’est réservé au nom de Dupont.' },
    ]);
    const second = await respond(h.engine, book, guest('g1'), first.transcript, 'Dupont', { clock: ticking() });
    expect(second.tools[0]?.output).toMatchObject({ status: 'booked' });
    expect(h.store.snapshot().bookings).toHaveLength(1);
    // The second turn sent the whole conversation, the first turn's tool result included.
    expect(book.requests[0]?.transcript.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
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
  it('gives today’s date and time at the restaurant, and keeps the rules in the cacheable part', () => {
    const prompt = buildSystemPrompt(TEST_CONFIG, 'fr', 'voice', new Date('2026-10-14T08:00:00Z'));
    expect(prompt.dynamic).toContain('Today is Wednesday 14 October (2026-10-14) and it is 10 am at the restaurant (Europe/Paris).');
    expect(prompt.dynamic).toContain('intelligence artificielle');
    expect(prompt.stable).toContain('Always reply in French, addressing the guest as "vous"');
    expect(prompt.stable).toContain('Never say a table is free unless find_table returned status "available"');
    expect(prompt.stable).not.toContain('2026-10-14');
  });

  it('is identical from one turn to the next except for the clock', () => {
    const a = buildSystemPrompt(TEST_CONFIG, 'en', 'web', new Date('2026-10-14T08:00:00Z'));
    const b = buildSystemPrompt(TEST_CONFIG, 'en', 'web', new Date('2026-10-15T19:30:00Z'));
    expect(a.stable).toBe(b.stable);
    expect(a.dynamic).not.toBe(b.dynamic);
  });
});
