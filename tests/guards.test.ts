import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/agent.js';
import { comparable, dropGuessedTitles, dropNameVocatives, enforceAllergenRelay } from '../src/agent/guards.js';
import { scriptedModel } from '../src/agent/providers/scripted.js';
import { guest, harness } from './fixtures.js';

const SENTENCE =
  'The allergen sheet for “Chocolate mousse” does not say whether it contains tree nuts. I would rather pass your question on to the team than guess.';
const checked = [{ name: 'check_dish', output: { status: 'ok', sayExactly: [SENTENCE] } }];

describe('the allergen relay guard', () => {
  it('leaves a reply that already repeats the sheet alone', () => {
    const reply = `${SENTENCE} I have passed it to the team.`;
    expect(enforceAllergenRelay(reply, checked)).toEqual({ reply, corrected: false });
  });

  it('puts the exact sentences in front of a paraphrase that adds a reason, and keeps it (seen in a real run)', () => {
    const paraphrase =
      'The allergen sheet does not say whether the chocolate mousse contains tree nuts, so I cannot confirm it is safe for you.';
    const result = enforceAllergenRelay(paraphrase, checked);
    expect(result.corrected).toBe(true);
    expect(result.reply).toBe(`${SENTENCE}\n\n${paraphrase}`);
  });

  it('does not say the same thing twice when the model only restated the sheet (seen in a real run)', () => {
    const reply =
      'The allergen sheet for the chocolate mousse does not say whether it contains tree nuts. I would rather pass your question on to the team than guess. ' +
      'Your question has been passed to the team, who will get back to you. Please do not order the chocolate mousse until you have their answer.';
    expect(enforceAllergenRelay(reply, checked)).toEqual({
      reply: `${SENTENCE}\n\nYour question has been passed to the team, who will get back to you. Please do not order the chocolate mousse until you have their answer.`,
      corrected: true,
    });
  });

  it('keeps the model’s other paragraphs, and adds the sheet to a reply that left it out (seen in a real run)', () => {
    expect(enforceAllergenRelay('The team will get back to you.', checked).reply).toBe(`${SENTENCE}\n\nThe team will get back to you.`);
    const reply = 'The allergen sheet for the chocolate mousse does not say whether it contains tree nuts.\n\nCan I check another dessert for you?';
    expect(enforceAllergenRelay(reply, checked).reply).toBe(`${SENTENCE}\n\nCan I check another dessert for you?`);
  });

  it('ignores turns without a successful allergen check', () => {
    expect(enforceAllergenRelay('Bonjour', [{ name: 'find_table', output: { status: 'available' } }]).corrected).toBe(false);
    expect(enforceAllergenRelay('Bonjour', [{ name: 'check_dish', output: { status: 'unknown_dish' } }]).corrected).toBe(false);
  });

  it('compares words, not spaces or quotation marks', () => {
    expect(comparable('Le plat « Confit » ne contient pas de gluten !')).toBe(comparable('Le plat "Confit" ne contient pas de gluten!'));
  });

  it('runs inside the agent and says so in the turn, keeping speech on one line', async () => {
    const h = harness();
    const model = scriptedModel([
      { toolCalls: [{ name: 'check_dish', input: { dishId: 'chocolate-mousse', allergens: ['nuts'] } }] },
      { text: 'I cannot confirm the mousse is nut-free, sorry.' },
    ]);
    const result = await respond(h.engine, model, guest('v1', '+447700900123', 'en', 'voice'), [], 'Any nuts in the mousse?');
    expect(result.corrections).toEqual(['allergen_relay']);
    expect(result.reply.startsWith(SENTENCE)).toBe(true);
    expect(result.reply).not.toContain('\n');
  });
});

describe('the guessed title guard', () => {
  it('takes out a title and name that address the guest, whatever the language (real replies from the web run)', () => {
    const cases: [string, string][] = [
      ['Merci, monsieur Mercier. Pour finaliser la réservation, saisissez votre numéro.', 'Merci. Pour finaliser la réservation, saisissez votre numéro.'],
      ['Je vous en prie, madame Faure. Nous serons ravis de vous accueillir.', 'Je vous en prie. Nous serons ravis de vous accueillir.'],
      // The model hedging with both titles is still a guess, and both go.
      ['Your table is booked, Mr or Ms Clarke. It is for 2 people on Friday.', 'Your table is booked. It is for 2 people on Friday.'],
      ['Gracias, señor o señora Navarro.', 'Gracias.'],
      ['Thank you, Ms Clarke. We look forward to seeing you.', 'Thank you. We look forward to seeing you.'],
      ['De nada, señor Navarro. Le esperamos el viernes en Merrain.', 'De nada. Le esperamos el viernes en Merrain.'],
      ['Mr Clarke, your table is ready.', 'Your table is ready.'],
      ['Merci. Monsieur Mercier, votre table est prête.', 'Merci. Votre table est prête.'],
      ['We look forward to welcoming Mrs Taylor and her guest.', 'We look forward to welcoming Taylor and her guest.'],
      // French abbreviates monsieur to "M." (a real reply from the run of 12 October).
      ['C’est noté, M. Leroy, votre table est réservée pour 21 h 30.', 'C’est noté, votre table est réservée pour 21 h 30.'],
    ];
    for (const [reply, expected] of cases) expect(dropGuessedTitles(reply), reply).toEqual({ reply: expected, corrected: true });
  });

  it('leaves alone a reply with no title before a name, and words that only look like one', () => {
    for (const reply of [
      'Votre réservation est confirmée : une table pour 4 personnes le vendredi 16 octobre à 20 h, au nom de Mercier.',
      'Madame, Monsieur, merci pour votre message.',
      'Su mesa para dos está reservada a nombre de Navarro.',
      'Don’t miss the canelés, they come out of the oven at seven.',
      'Les desserts du Sud-Ouest sont nos préférés.',
      'Your table is at 8 P.M. Merci for booking with us.',
    ]) {
      expect(dropGuessedTitles(reply), reply).toEqual({ reply, corrected: false });
    }
  });

  it('runs inside the agent and says so in the turn', async () => {
    const h = harness();
    const model = scriptedModel([{ text: 'De nada, señor Navarro. Le esperamos el viernes.' }]);
    const result = await respond(h.engine, model, guest('s1', '+33639980023', 'es', 'web'), [], 'Gracias.');
    expect(result.corrections).toEqual(['guessed_title']);
    expect(result.reply).toBe('De nada. Le esperamos el viernes.');
  });
});

describe('the bare name guard', () => {
  it('takes out the booking name when it addresses the guest (real replies from the web run)', () => {
    const cases: [string, string][] = [
      ['Thank you, Clarke. To complete the booking, please enter your phone number in the field.', 'Thank you. To complete the booking, please enter your phone number in the field.'],
      ['Your table is booked, Clarke: a table for 2 on Friday.', 'Your table is booked: a table for 2 on Friday.'],
      ['You are welcome, Clarke. See you on Friday.', 'You are welcome. See you on Friday.'],
      ['De nada, Navarro. Que tenga un buen día.', 'De nada. Que tenga un buen día.'],
      ['Merci. Mercier, votre table est prête.', 'Merci. Votre table est prête.'],
    ];
    for (const [reply, expected] of cases) {
      expect(dropNameVocatives(reply, ['Clarke', 'Navarro', 'Mercier']), reply).toEqual({ reply: expected, corrected: true });
    }
  });

  it('keeps the name where it belongs to the booking', () => {
    for (const reply of [
      'It is for 2 people on Friday 16 October at 8:30 pm, under the name Clarke.',
      'Su reserva está confirmada: una mesa para 2 personas, a nombre de Navarro. La referencia es 34PDUE.',
      'Une table pour 4 personnes au nom de Mercier, le vendredi 16 octobre à 20 h.',
    ]) {
      expect(dropNameVocatives(reply, ['Clarke', 'Navarro', 'Mercier']), reply).toEqual({ reply, corrected: false });
    }
    expect(dropNameVocatives('Thank you, Clarke.', [])).toEqual({ reply: 'Thank you, Clarke.', corrected: false });
  });

  it('runs inside the agent with the name the model booked under', async () => {
    const h = harness();
    const model = scriptedModel([
      { toolCalls: [{ name: 'find_table', input: { day: 'friday', time: '20:30', partySize: 2 } }] },
      { text: 'A table for 2 on Friday at 8:30 pm is available. May I have the name, and any allergies?' },
    ]);
    const first = await respond(h.engine, model, guest('n1', '+447700900201', 'en', 'whatsapp'), [], 'A table for two on Friday at 8:30pm?');
    const booking = scriptedModel([
      { toolCalls: [{ name: 'book_table', input: { holdId: String(first.tools[0]?.output['holdId']), guestName: 'Clarke', allergies: [] } }] },
      { text: 'Thank you, Clarke. Your table is booked for Friday at 8:30 pm.' },
    ]);
    const second = await respond(h.engine, booking, guest('n1', '+447700900201', 'en', 'whatsapp'), first.transcript, 'Clarke, no allergies.');
    expect(second.corrections).toEqual(['name_vocative']);
    expect(second.reply).toBe('Thank you. Your table is booked for Friday at 8:30 pm.');
  });
});
