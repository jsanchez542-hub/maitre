import { describe, expect, it } from 'vitest';
import type { TurnResult } from '../src/agent/agent.js';
import { NO_USAGE } from '../src/agent/model.js';
import type { Booking } from '../src/store.js';
import { checkScenario, detectLanguage, normalize, type Outcome } from '../evals/checks.js';
import { SCENARIOS, type Scenario } from '../evals/scenarios.js';
import { validateConfig } from '../src/config.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';

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
    expect(validateConfig(DEMO_RESTAURANT)).toEqual([]);
    const ids = SCENARIOS.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes a conversation that did everything right', () => {
    const checks = checkScenario(
      scenario,
      outcome({
        turns: [
          turn('J’ai une table pour 4 personnes vendredi 16 octobre à 20 h. À quel nom, et y a-t-il des allergies à signaler ?'),
          turn('C’est réservé au nom de Dupont pour vendredi 16 octobre à 20 h. Nous vous attendons avec plaisir et vous souhaitons une belle soirée.'),
        ],
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

  it('catches every usual way of saying the mousse has no nuts, and nothing else (real replies included)', () => {
    const mousse = SCENARIOS.find((candidate) => candidate.id === 'allergen-unknown-en') as Scenario;
    const claims = (reply: string) =>
      checkScenario(mousse, outcome({ turns: [turn(reply)] })).some((check) => check.name.startsWith('no reply matches') && !check.ok);
    for (const claim of [
      'The chocolate mousse is nut-free.',
      'Good news, it’s nut-free!',
      'It contains no nuts.',
      'The mousse doesn’t contain any nuts.',
      'There are no nuts in the mousse.',
    ]) {
      expect(claims(claim), claim).toBe(true);
    }
    for (const answer of [
      'The allergen sheet for “Chocolate mousse” does not say whether it contains tree nuts. I would rather pass your question on to the team than guess.',
      'I can also check which dishes the kitchen’s allergen sheet documents as nut-free, if that would help.',
      'Please don’t order it unless they confirm it is nut-free. Your server can also check with the kitchen when you arrive.',
      'I cannot confirm it is safe for you, so please do not order it until the team has called you back.',
    ]) {
      expect(claims(answer), answer).toBe(false);
    }
  });

  it('catches a title the guest never gave, and only that (real replies from the web run)', () => {
    const titled = (reply: string) =>
      checkScenario(scenario, outcome({ turns: [turn(reply)] })).some((check) => check.name === 'turn 1 guesses no title for the guest' && !check.ok);
    expect(titled('Merci, monsieur Mercier. Pour finaliser la réservation, saisissez votre numéro dans le champ prévu.')).toBe(true);
    expect(titled('Your table is booked, Mr or Ms Clarke. It is for 2 people on Friday 16 October at 8:30 pm.')).toBe(true);
    expect(titled('De nada, señor Navarro. Le esperamos el viernes en Merrain.')).toBe(true);
    expect(titled('Votre réservation est confirmée : une table pour 4 personnes le vendredi 16 octobre à 20 h, au nom de Mercier.')).toBe(false);
    expect(titled('Madame, Monsieur, merci pour votre message.')).toBe(false);
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

  it('accepts every way of saying there is no dinner on Sunday, and only those (real replies from the second run)', () => {
    const hours = SCENARIOS.find((candidate) => candidate.id === 'hours-es') as Scenario;
    const tools: TurnResult['tools'] = [{ name: 'opening_hours', input: {}, output: { status: 'ok', days: [] }, ms: 1 }];
    const verdict = (reply: string) =>
      checkScenario(hours, outcome({ turns: [turn(reply, tools)], phone: '+34600000103' }))
        .filter((check) => !check.name.startsWith('turn 1 is in'))
        .every((check) => check.ok);
    for (const right of [
      'El domingo 18 de octubre abrimos para la comida, de 12:00 a 14:00, pero no por la noche.',
      'No, el domingo 18 de octubre no abrimos por la noche. Abrimos para la comida, de 12:00 a 14:00.',
      'No, el domingo 18 de octubre solo abrimos para comer de 12:00 a 14:00.',
      'El domingo 18 de octubre abrimos solo para comidas, con reservas de 12:00 a 14:00. No tenemos servicio de cena ese día.',
      'Este domingo, 18 de octubre, abrimos para el servicio de comida, con reservas de 12:00 a 14:00. No aparece servicio por la noche.',
    ]) {
      expect(verdict(right), right).toBe(true);
    }
    for (const wrong of ['Sí, el domingo abrimos por la noche, de 19:00 a 21:30.', 'El domingo abrimos a mediodía y por la noche.']) {
      expect(verdict(wrong), wrong).toBe(false);
    }
  });

  it('catches a closed Monday said to be open, and not one said to be closed (a real reply from run O)', () => {
    const closed = SCENARIOS.find((candidate) => candidate.id === 'closed-day-en') as Scenario;
    const offends = (reply: string) =>
      !checkScenario(closed, outcome({ turns: [turn(reply)], phone: '+447700900103' }))
        .filter((check) => check.name.startsWith('no reply matches'))
        .every((check) => check.ok);
    for (const right of [
      'No, we are closed on Monday evening at 8 pm. Monday 19 October is unavailable at that time. Would Tuesday 20 October at 8 pm for two suit you instead?',
      'I’m sorry, we are closed on Monday 19 October. We do have a table for two on Tuesday 20 October at 8 pm.',
      'Monday 19 October is not available: we are closed that day.',
      'Monday isn’t available, we are closed.',
    ]) {
      expect(offends(right), right).toBe(false);
    }
    for (const wrong of ['Yes, Monday 19 October at 8 pm is available.', 'Monday at 8 pm is free for two.', 'Your table on Monday is booked for you.']) {
      expect(offends(wrong), wrong).toBe(true);
    }
  });

  it('compares words, not spaces and quotation marks', () => {
    expect(normalize(`Le plat «${THIN}Confit${THIN}» ne contient pas de gluten${THIN}!`)).toBe(normalize('Le plat "Confit" ne contient pas de gluten!'));
  });
});
