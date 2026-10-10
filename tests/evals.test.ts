import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../src/agent/agent.js';
import { NO_USAGE } from '../src/agent/model.js';
import type { Booking } from '../src/store.js';
import { checkScenario, detectLanguage, normalize, type Outcome } from '../evals/checks.js';
import { SCENARIOS, type Scenario } from '../evals/scenarios.js';
import { EVAL_RESTAURANT } from '../evals/restaurant.js';
import { validateConfig } from '../src/config.js';

const THIN = ' ';

function turn(reply: string, tools: TurnResult['tools'] = []): TurnResult {
  return { reply, transcript: [], tools, usage: NO_USAGE, modelCalls: 1, latencyMs: 900, modelMs: [800], outcome: 'answered', corrections: [] };
}

function booking(change: Partial<Booking>): Booking {
  return {
    id: 'b1',
    reference: 'ACDEFH',
    holdId: 'h1',
    date: '2026-10-16',
    time: '20:00',
    partySize: 4,
    stayMinutes: 120,
    tableGroup: 't4',
    service: 'dinner',
    guestName: 'Dupont',
    phone: '+33611111111',
    phoneSource: 'whatsapp',
    status: 'booked',
    channel: 'whatsapp',
    language: 'fr',
    allergies: [],
    history: [],
    createdAt: '2026-10-14T08:00:00.000Z',
    updatedAt: '2026-10-14T08:00:00.000Z',
    ...change,
  };
}

const scenario = SCENARIOS.find((candidate) => candidate.id === 'book-fr') as Scenario;

function outcome(change: Partial<Outcome>): Outcome {
  return { turns: [], newBookings: [], allBookings: [], callbacks: [], refs: {}, phone: '+33611111111', ...change };
}

describe('the evaluation harness', () => {
  it('runs on a valid restaurant and scenarios with unique ids', () => {
    expect(validateConfig(EVAL_RESTAURANT)).toEqual([]);
    const ids = SCENARIOS.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes a conversation that did everything right', () => {
    const checks = checkScenario(
      scenario,
      outcome({
        turns: [turn('C’est réservé au nom de Dupont pour vendredi 16 octobre à 20 h. Nous vous attendons avec plaisir et vous souhaitons une belle soirée.')],
        newBookings: [booking({})],
      }),
    );
    expect(checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('fails a booking with the wrong time, a second booking, or a number the channel did not give', () => {
    const wrongTime = checkScenario(scenario, outcome({ turns: [turn('ok')], newBookings: [booking({ time: '20:30' })] }));
    expect(wrongTime.find((check) => !check.ok)?.detail).toBe('time 20:30');
    const twice = checkScenario(scenario, outcome({ turns: [turn('ok')], newBookings: [booking({}), booking({ id: 'b2' })] }));
    expect(twice.some((check) => !check.ok && check.detail?.startsWith('2 bookings'))).toBe(true);
    const otherNumber = checkScenario(scenario, outcome({ turns: [turn('ok')], newBookings: [booking({ phone: '+33612345678' })] }));
    expect(otherNumber.some((check) => !check.ok && check.detail?.includes('phone'))).toBe(true);
  });

  it('fails a reply that rephrases the allergen sheet instead of repeating it', () => {
    const sentence = `D’après la fiche de la cuisine, le plat «${THIN}Confit${THIN}» ne contient pas de gluten.`;
    const tools: TurnResult['tools'] = [{ name: 'check_dish', input: {}, output: { status: 'ok', sayExactly: [sentence] }, ms: 1 }];
    const faithful = checkScenario(scenario, outcome({ turns: [turn(`D'après la fiche de la cuisine, le plat « Confit » ne contient pas de gluten.`, tools)] }));
    expect(faithful.find((check) => check.name.includes('word for word'))?.ok).toBe(true);
    const rephrased = checkScenario(scenario, outcome({ turns: [turn('Le confit est sans gluten, vous pouvez y aller !', tools)] }));
    expect(rephrased.find((check) => check.name.includes('word for word'))?.ok).toBe(false);
  });

  it('catches internals, markdown, the wrong language and a repeated phone number', () => {
    const failed = (reply: string) =>
      checkScenario(scenario, outcome({ turns: [turn(reply)] }))
        .filter((check) => !check.ok)
        .map((check) => check.name);
    expect(failed('I called find_table and the table is free for you on Friday evening.')).toContain('turn 1 shows no internals');
    expect(failed('**Parfait**, c’est noté pour vendredi soir à vingt heures pour vous.')).toContain('turn 1 is plain text');
    expect(failed('Your table is booked for Friday at eight, we look forward to seeing you.')).toContain('turn 1 is in fr');
    expect(failed('Je vous rappelle au 06 11 11 11 11 dès que possible pour confirmer la table.')).toContain('turn 1 never repeats the guest\'s number');
  });

  it('tells languages apart only when there is enough to go on', () => {
    expect(detectLanguage('Bonjour, je vous confirme la table pour vendredi soir avec plaisir.')).toBe('fr');
    expect(detectLanguage('Your table for two is booked for Friday at eight in the evening.')).toBe('en');
    expect(detectLanguage('Su mesa para dos está reservada el viernes a las ocho, gracias por su visita.')).toBe('es');
    expect(detectLanguage('Merci !')).toBeUndefined();
  });

  it('is not fooled by a Spanish list of dishes full of "la" (a real misreading from the first run)', () => {
    const reply =
      'Según la ficha de alérgenos de la cocina, estos platos no contienen gluten:\n\nOstras de la bahía de Arcachon\n' +
      'Confit de pato con patatas sarladesas\nEntrecot a la bordelesa\nRisotto de boletus\nMousse de chocolate\n\n' +
      'Si quiere, puedo consultarle cualquier otro plato en concreto.';
    expect(detectLanguage(reply)).toBe('es');
  });

  it('compares words, not spaces and quotation marks', () => {
    expect(normalize(`Le plat «${THIN}Confit${THIN}» ne contient pas de gluten${THIN}!`)).toBe(normalize('Le plat "Confit" ne contient pas de gluten!'));
  });
});
