import { allergenStatus, dishesWithout, type Allergen, type AllergenAnswer, type DishCategory } from './allergens.js';
import type { BusinessConfig } from './config.js';
import { localize, messages, type Language } from './i18n/index.js';

export interface MenuItemView {
  id: string;
  name: string;
  category: DishCategory;
  description?: string;
  price?: string;
}

export interface AllergenFinding {
  allergen: Allergen;
  answer: AllergenAnswer;
  /** The sentence to say, word for word. */
  sentence: string;
}

export type DishCheck =
  | {
      status: 'ok';
      dish: string;
      findings: AllergenFinding[];
      /** At least one allergen is not documented: the question goes to the team. */
      passToTeam: boolean;
    }
  | { status: 'unknown_dish' };

const NBSP = ' ';

/** "24 €" and "24,50 €" in French and Spanish, "€24" and "€24.50" in English. */
export function formatPrice(cents: number, language: Language): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  if (language === 'en') return rest === 0 ? `€${euros}` : `€${euros}.${String(rest).padStart(2, '0')}`;
  return rest === 0 ? `${euros}${NBSP}€` : `${euros},${String(rest).padStart(2, '0')}${NBSP}€`;
}

export function menuView(config: BusinessConfig, language: Language, category?: DishCategory): MenuItemView[] {
  return config.menu
    .filter((dish) => category === undefined || dish.category === category)
    .map((dish) => ({
      id: dish.id,
      name: localize(dish.name, language),
      category: dish.category,
      ...(dish.description ? { description: localize(dish.description, language) } : {}),
      ...(dish.priceCents === undefined ? {} : { price: formatPrice(dish.priceCents, language) }),
    }));
}

/** What the kitchen's sheet says about some allergens in one dish, as sentences to repeat exactly. */
export function checkDish(config: BusinessConfig, language: Language, dishId: string, allergens: readonly Allergen[]): DishCheck {
  const dish = config.menu.find((candidate) => candidate.id === dishId);
  if (!dish) return { status: 'unknown_dish' };
  const name = localize(dish.name, language);
  const words = messages(language);
  const findings = allergens.map((allergen): AllergenFinding => {
    const answer = allergenStatus(dish, allergen);
    const sentence =
      answer === 'contains'
        ? words.dishContains(name, allergen)
        : answer === 'may_contain'
          ? words.dishMayContain(name, allergen)
          : answer === 'free'
            ? words.dishFree(name, allergen)
            : words.dishUnknown(name, allergen);
    return { allergen, answer, sentence };
  });
  return { status: 'ok', dish: name, findings, passToTeam: findings.some((finding) => finding.answer === 'unknown') };
}

/** Dish names a guest avoiding these allergens could order, and those the sheet does not cover. */
export function safeDishes(
  config: BusinessConfig,
  language: Language,
  allergens: readonly Allergen[],
): { safe: string[]; undocumented: string[] } {
  const { safe, undocumented } = dishesWithout(config.menu, allergens);
  return {
    safe: safe.map((dish) => localize(dish.name, language)),
    undocumented: undocumented.map((dish) => localize(dish.name, language)),
  };
}
