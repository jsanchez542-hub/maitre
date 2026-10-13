import { describe, expect, it } from 'vitest';
import type { BusinessConfig } from '../src/config.js';
import { DEMO_RESTAURANT } from '../src/demo/restaurant.js';
import { speechKeyterms } from '../src/speech.js';

describe('the words speech recognition expects on the line', () => {
  it('are the restaurant’s name and its dishes, in the call’s language', () => {
    const french = speechKeyterms(DEMO_RESTAURANT, 'fr');
    expect(french[0]).toBe('Merrain');
    expect(french).toContain('Soupe à l’oignon gratinée');
    expect(speechKeyterms(DEMO_RESTAURANT, 'es')).toContain('Sopa de cebolla gratinada');
  });

  it('stay within what Deepgram takes, without repeats', () => {
    const dish = (name: string) => ({ ...DEMO_RESTAURANT.menu[0], id: name, name: { fr: name, en: name, es: name } });
    const crowded: BusinessConfig = {
      ...DEMO_RESTAURANT,
      menu: [...Array.from({ length: 200 }, (_, index) => dish(`Plat du jour numéro ${index}`)), dish('Plat du jour numéro 1'), dish('x'.repeat(80))],
    } as BusinessConfig;
    const terms = speechKeyterms(crowded, 'fr');
    expect(terms.length).toBeLessThanOrEqual(60);
    expect(terms.join('').length).toBeLessThanOrEqual(900);
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms.every((term) => term.length <= 60)).toBe(true);
  });
});
