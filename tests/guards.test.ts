import { describe, expect, it } from 'vitest';
import { respond } from '../src/agent/agent.js';
import { comparable, enforceAllergenRelay } from '../src/agent/guards.js';
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
