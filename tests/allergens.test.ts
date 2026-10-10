import { describe, expect, it } from 'vitest';
import { allergenStatus, dishesWithout, type Dish } from '../src/allergens.js';

const name = (text: string) => ({ fr: text, en: text, es: text });

const confit: Dish = {
  id: 'duck-confit',
  category: 'main',
  name: name('Confit'),
  allergens: { gluten: 'free', milk: 'free', celery: 'may_contain' },
};
const soup: Dish = {
  id: 'onion-soup',
  category: 'starter',
  name: name('Soup'),
  allergens: { gluten: 'contains', milk: 'contains', celery: 'contains' },
};
const mousse: Dish = {
  id: 'chocolate-mousse',
  category: 'dessert',
  name: name('Mousse'),
  allergens: { eggs: 'contains', milk: 'contains', gluten: 'free' },
};
const MENU = [confit, soup, mousse];

describe('allergens', () => {
  it('answers only from what the kitchen wrote down', () => {
    expect(allergenStatus(confit, 'gluten')).toBe('free');
    expect(allergenStatus(confit, 'celery')).toBe('may_contain');
    expect(allergenStatus(soup, 'gluten')).toBe('contains');
    expect(allergenStatus(mousse, 'nuts')).toBe('unknown');
  });

  it('is not fooled by names inherited from Object', () => {
    const fromJson = JSON.parse('{"id":"x","category":"main","name":{"fr":"x","en":"x","es":"x"},"allergens":{}}') as Dish;
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(allergenStatus(fromJson, inherited as never)).toBe('unknown');
    }
  });

  it('separates safe dishes from undocumented ones and leaves out traces', () => {
    const gluten = dishesWithout(MENU, ['gluten']);
    expect(gluten.safe.map((dish) => dish.id)).toEqual(['duck-confit', 'chocolate-mousse']);
    expect(gluten.undocumented).toEqual([]);

    const nuts = dishesWithout(MENU, ['nuts']);
    expect(nuts.safe).toEqual([]);
    expect(nuts.undocumented.map((dish) => dish.id)).toEqual(['duck-confit', 'onion-soup', 'chocolate-mousse']);

    // The confit "may contain" celery: an allergic guest must not be told it is safe.
    expect(dishesWithout(MENU, ['celery']).safe).toEqual([]);
  });
});
