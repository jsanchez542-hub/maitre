import { describe, expect, it } from 'vitest';
import { BookingEngine } from '../src/engine.js';
import { formatPrice } from '../src/menu.js';
import type { BookingStore } from '../src/store.js';
import { TOOL_DEFINITIONS, runTool } from '../src/tools.js';
import { TEST_CONFIG, guest, harness, sequentialIds } from './fixtures.js';

const THIN = ' ';
const NBSP = ' ';

describe('tool definitions', () => {
  it('have unique names and strict object schemas', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema['type'], tool.name).toBe('object');
      expect(tool.inputSchema['additionalProperties'], tool.name).toBe(false);
      const properties = Object.keys(tool.inputSchema['properties'] as object);
      for (const required of (tool.inputSchema['required'] as string[] | undefined) ?? []) {
        expect(properties, `${tool.name}.${required}`).toContain(required);
      }
    }
  });

  it('are written without dashes that read as machine text', () => {
    for (const tool of TOOL_DEFINITIONS) expect(JSON.stringify(tool)).not.toMatch(/[–—]/);
  });
});

describe('running tools', () => {
  it('finds a table from a weekday the way the guest said it', () => {
    const h = harness();
    const result = runTool(h.engine, guest('g1'), 'find_table', { day: 'friday', time: '20:00', partySize: 2 });
    expect(result).toMatchObject({ status: 'available', date: '2026-10-16', time: '20:00' });
  });

  it('explains every problem with the input instead of guessing', () => {
    const h = harness();
    const invalid = runTool(h.engine, guest('g1'), 'find_table', { day: 'vendredi', time: '20:00' });
    expect(invalid['status']).toBe('invalid_input');
    expect(invalid['problems']).toEqual([expect.stringContaining('day "vendredi" is not one of the forms'), 'partySize is required']);
    expect(runTool(h.engine, guest('g1'), 'find_table', [])).toEqual({
      status: 'invalid_input',
      problems: ['the input must be an object'],
    });
    expect(runTool(h.engine, guest('g1'), 'make_coffee', {})).toMatchObject({ status: 'unknown_tool' });
  });

  it('tells the assistant how to get a number on each channel', () => {
    const h = harness();
    const web = guest('w1', null, 'fr', 'web');
    const found = runTool(h.engine, web, 'find_table', { day: 'day after tomorrow', time: '20:00', partySize: 2 });
    const book = runTool(h.engine, web, 'book_table', { holdId: found['holdId'], guestName: 'Dupont', allergies: [] });
    expect(book).toMatchObject({ status: 'phone_required' });
    expect(String(book['instruction'])).toContain('field shown below the chat');

    const caller = guest('v1', null, 'fr', 'voice');
    expect(String(runTool(h.engine, caller, 'my_bookings', {})['instruction'])).toContain('keypad');
  });

  it('never returns the guest’s phone number in any answer', () => {
    const h = harness();
    const session = guest('g1', '+33698765432');
    const outputs = [
      runTool(h.engine, session, 'find_table', { day: '2026-10-16', time: '20:00', partySize: 2 }),
    ];
    outputs.push(runTool(h.engine, session, 'book_table', { holdId: outputs[0]?.['holdId'], guestName: 'Dupont', allergies: [] }));
    outputs.push(runTool(h.engine, session, 'my_bookings', {}));
    outputs.push(runTool(h.engine, session, 'confirm_booking', {}));
    outputs.push(runTool(h.engine, session, 'hand_over', { reason: 'other', summary: 'Question sur un menu de groupe' }));
    for (const output of outputs) expect(JSON.stringify(output)).not.toContain('98765432');
    expect(outputs[1]).toMatchObject({ status: 'booked' });
  });

  it('gives allergen answers as sentences to repeat word for word', () => {
    const h = harness();
    const confit = runTool(h.engine, guest('g1'), 'check_dish', { dishId: 'duck-confit', allergens: ['gluten', 'celery'] });
    expect(confit).toEqual({
      status: 'ok',
      dish: 'Confit de canard',
      sayExactly: [
        `D’après la fiche de la cuisine, le plat «${THIN}Confit de canard${THIN}» ne contient pas de gluten.`,
        `Le plat «${THIN}Confit de canard${THIN}» peut contenir des traces de céleri.`,
      ],
      findings: [
        { allergen: 'gluten', answer: 'free' },
        { allergen: 'celery', answer: 'may_contain' },
      ],
    });
    expect(h.store.snapshot().callbacks).toEqual([]);
  });

  it('says it does not know when the sheet is silent, and passes the question to the team itself', () => {
    const h = harness();
    const mousse = runTool(h.engine, guest('g1', '+447700900123', 'en'), 'check_dish', {
      dishId: 'chocolate-mousse',
      allergens: ['nuts'],
    });
    expect(mousse).toMatchObject({ status: 'ok', passedToTeam: true, findings: [{ allergen: 'nuts', answer: 'unknown' }] });
    expect(mousse).not.toHaveProperty('needsPhone');
    expect(mousse['sayExactly']).toEqual([
      'The allergen sheet for “Chocolate mousse” does not say whether it contains tree nuts. I would rather pass your question on to the team than guess.',
    ]);
    // Recorded by the code, not left to the model: a model that promises and forgets leaves an allergic guest waiting.
    expect(h.store.snapshot().callbacks).toMatchObject([
      { sessionId: 'g1', reason: 'allergy_question', phone: '+447700900123', summary: 'Allergens the sheet for “Chocolate mousse” does not cover: tree nuts.' },
    ]);
    expect(runTool(h.engine, guest('g1'), 'check_dish', { dishId: 'tiramisu', allergens: ['eggs'] })).toMatchObject({
      status: 'unknown_dish',
    });
  });

  it('asks a web guest for a number when the team cannot call back without one', () => {
    const h = harness();
    const web = guest('w1', null, 'fr', 'web');
    const mousse = runTool(h.engine, web, 'check_dish', { dishId: 'chocolate-mousse', allergens: ['nuts'] });
    expect(mousse).toMatchObject({ passedToTeam: true, needsPhone: true });
    expect(String(mousse['instruction'])).toContain('field shown below the chat');
    const handOver = runTool(h.engine, web, 'hand_over', { reason: 'complaint', summary: 'Plat froid hier soir' });
    expect(handOver).toMatchObject({ status: 'recorded', needsPhone: true });
    expect(String(handOver['instruction'])).toContain('field shown below the chat');
  });

  it('lists safe and undocumented dishes apart', () => {
    const h = harness();
    expect(runTool(h.engine, guest('g1'), 'dishes_without', { allergens: ['milk'] })).toEqual({
      status: 'ok',
      safe: ['Confit de canard'],
      undocumented: [],
    });
    expect(runTool(h.engine, guest('g1'), 'dishes_without', { allergens: ['nuts'] })).toMatchObject({
      safe: [],
      undocumented: ['Confit de canard', 'Soupe à l’oignon', 'Mousse au chocolat'],
    });
  });

  it('serves the menu, the hours and the written answers in the guest’s language', () => {
    const h = harness();
    expect(runTool(h.engine, guest('g1', '+34600000000', 'es'), 'get_menu', { category: 'main' })).toEqual({
      status: 'ok',
      dishes: [{ id: 'duck-confit', name: 'Confit de pato', category: 'main', price: `24${NBSP}€` }],
    });
    expect(runTool(h.engine, guest('g1'), 'opening_hours', {})).toMatchObject({ status: 'ok' });
    expect(runTool(h.engine, guest('g1', '+447700900123', 'en'), 'business_info', {})).toEqual({
      status: 'ok',
      answers: [{ question: 'Where can I park?', answer: 'Public car park 200 m away.' }],
    });
  });

  it('turns an unexpected failure into an answer the assistant can handle', () => {
    const broken: BookingStore = {
      transaction() {
        throw new Error('storage is down');
      },
    };
    const engine = new BookingEngine(TEST_CONFIG, broken, { now: () => new Date('2026-10-14T08:00:00Z'), ids: sequentialIds() });
    const seen: unknown[] = [];
    expect(
      runTool(engine, guest('g1'), 'find_table', { day: 'in 2 days', time: '20:00', partySize: 2 }, (error) =>
        seen.push(error),
      ),
    ).toEqual({ status: 'internal_error' });
    expect(seen).toHaveLength(1);
  });
});

describe('prices', () => {
  it('follow each language’s convention', () => {
    expect(formatPrice(2400, 'fr')).toBe(`24${NBSP}€`);
    expect(formatPrice(2450, 'fr')).toBe(`24,50${NBSP}€`);
    expect(formatPrice(2450, 'en')).toBe('€24.50');
    expect(formatPrice(2400, 'en')).toBe('€24');
    expect(formatPrice(905, 'es')).toBe(`9,05${NBSP}€`);
  });
});

describe('the fields that used to go wrong in real runs', () => {
  it('refuses a booking that does not say whether anyone has an allergy', () => {
    const h = harness();
    const found = runTool(h.engine, guest('g1'), 'find_table', { day: 'friday', time: '20:00', partySize: 2 });
    expect(runTool(h.engine, guest('g1'), 'book_table', { holdId: found['holdId'], guestName: 'Rousseau' })).toEqual({
      status: 'invalid_input',
      problems: ['allergies is required (an empty list when none was mentioned)'],
    });
    expect(runTool(h.engine, guest('g1'), 'book_table', { holdId: found['holdId'], guestName: 'Rousseau', allergies: ['nuts'] })).toMatchObject({
      status: 'booked',
      booking: { allergies: ['nuts'] },
    });
  });

  it('reads "the 24th" without a stray month', () => {
    const h = harness();
    expect(runTool(h.engine, guest('g1'), 'find_table', { day: '24', time: '20:00', partySize: 2 })).toMatchObject({
      status: 'available',
      date: '2026-10-24',
    });
  });
});
