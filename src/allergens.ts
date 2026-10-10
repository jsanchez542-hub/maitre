import type { LocalizedText } from './i18n/types.js';

/**
 * The fourteen allergens a restaurant in the European Union must declare
 * (Regulation (EU) No 1169/2011, Annex II).
 */
export const ALLERGENS = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soybeans',
  'milk',
  'nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
] as const;

export type Allergen = (typeof ALLERGENS)[number];

/** What the kitchen has written down for one allergen in one dish. */
export type AllergenStatus = 'contains' | 'may_contain' | 'free';

/** `unknown` is not stored: it is what a missing entry means, and it is never guessed. */
export type AllergenAnswer = AllergenStatus | 'unknown';

const STATUSES: readonly string[] = ['contains', 'may_contain', 'free'];

export type DishCategory = 'starter' | 'main' | 'dessert' | 'drink' | 'side';

export interface Dish {
  id: string;
  name: LocalizedText;
  category: DishCategory;
  description?: LocalizedText;
  /** In cents, so prices never meet floating point. */
  priceCents?: number;
  allergens: Readonly<Partial<Record<Allergen, AllergenStatus>>>;
}

export function isAllergen(value: unknown): value is Allergen {
  return typeof value === 'string' && (ALLERGENS as readonly string[]).includes(value);
}

export function isAllergenStatus(value: unknown): value is AllergenStatus {
  return typeof value === 'string' && STATUSES.includes(value);
}

export function allergenStatus(dish: Dish, allergen: Allergen): AllergenAnswer {
  // hasOwn and not `dish.allergens[allergen] ?? 'unknown'`: data that came from
  // JSON can carry inherited names, and a lookup must never return one.
  if (!Object.hasOwn(dish.allergens, allergen)) return 'unknown';
  const status = dish.allergens[allergen];
  return isAllergenStatus(status) ? status : 'unknown';
}

export interface DishesWithout {
  /** The kitchen has written "free" for every allergen asked about. */
  safe: Dish[];
  /** No allergen asked about is present, but at least one is not documented. */
  undocumented: Dish[];
}

/**
 * Dishes a guest avoiding these allergens could order. A dish with "may contain
 * traces" is left out: for an allergic guest a trace is not safe.
 */
export function dishesWithout(menu: readonly Dish[], allergens: readonly Allergen[]): DishesWithout {
  const safe: Dish[] = [];
  const undocumented: Dish[] = [];
  for (const dish of menu) {
    const answers = allergens.map((allergen) => allergenStatus(dish, allergen));
    if (answers.some((answer) => answer === 'contains' || answer === 'may_contain')) continue;
    if (answers.every((answer) => answer === 'free')) safe.push(dish);
    else undocumented.push(dish);
  }
  return { safe, undocumented };
}
