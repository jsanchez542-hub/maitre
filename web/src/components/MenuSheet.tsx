import { ALLERGENS, allergenStatus, formatPrice, localize, messages, type Allergen, type AllergenAnswer, type Dish, type DishCategory } from 'maitre';
import { useState } from 'preact/hooks';
import { typeset } from '../lib/typography';
import type { PanelApp } from './Panel';

const CATEGORIES: readonly DishCategory[] = ['starter', 'main', 'side', 'dessert', 'drink'];
/** The answers a sheet names one by one; what it does not contain closes the dish, as the rest of the fourteen. */
const NAMED: readonly AllergenAnswer[] = ['contains', 'may_contain', 'unknown'];
/** The answer's mark beside its words, read at a glance on the floor; the words say it to everyone. */
const MARKS: Record<AllergenAnswer, string> = { contains: '●', may_contain: '○', free: '·', unknown: '?' };
/** How many names of a long «non renseigné» line show before «voir tous»: the rest is a press away, in place. */
const FIRST = 3;

/**
 * The menu as its kitchen's sheet reads, dish by dish under its course: what each dish contains, may contain and
 * leaves unstated, in words, and that it contains none of the rest. One allergen can be checked across the menu, the
 * host's own question: «what can a coeliac eat?».
 */
export function MenuSheet({ app, canEdit, onEdit }: { app: PanelApp; canEdit: boolean; onEdit: (dish: Dish) => void }) {
  const { t, language, config } = app;
  const s = t.panel.settings;
  const words = messages(language);
  const [checked, setChecked] = useState<Allergen | ''>('');
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set());
  const word: Record<AllergenAnswer, string> = { contains: s.contains, may_contain: s.mayContain, free: s.free, unknown: s.unknown };
  // One allergen checked: a word for each answer, the unstated one with what the assistant then does.
  const verdict: Record<AllergenAnswer, string> = { contains: s.contains, may_contain: s.traces, free: s.free, unknown: s.unknownCheck };
  const option = (allergen: Allergen) => {
    const name = words.allergen(allergen);
    return name.charAt(0).toLocaleUpperCase(language) + name.slice(1);
  };
  const toggle = (id: string) => setWhole((shown) => new Set(shown.has(id) ? [...shown].filter((other) => other !== id) : [...shown, id]));
  const line = (answer: AllergenAnswer, text: string, more?: { id: string; open: boolean }) => (
    <p class={`dish__line dish__line--${answer}`} key={answer}>
      <span class={`mark mark--${answer}`} aria-hidden="true">
        {MARKS[answer]}
      </span>
      <span>
        {typeset(text)}
        {more && (
          <>
            {' '}
            <button type="button" class="dish__more" aria-expanded={more.open} onClick={() => toggle(more.id)}>
              {more.open ? s.showFewer : s.showAll}
            </button>
          </>
        )}
      </span>
    </p>
  );

  const sheet = (dish: Dish) => {
    const named = (answer: AllergenAnswer) => ALLERGENS.filter((allergen) => allergenStatus(dish, allergen) === answer).map((allergen) => words.allergen(allergen));
    const lines = NAMED.flatMap((answer) => {
      const allergens = named(answer);
      if (allergens.length === 0) return [];
      // Only an unstated list runs long: a new dish starts with all fourteen unstated.
      if (answer !== 'unknown' || allergens.length <= FIRST) return [line(answer, s.sheetLine(word[answer], allergens.join(', ')))];
      const open = whole.has(dish.id);
      const shown = open ? allergens.join(', ') : `${allergens.slice(0, FIRST).join(', ')}…`;
      return [line(answer, s.sheetLine(`${word[answer]} (${allergens.length})`, shown), { id: dish.id, open })];
    });
    const free = named('free').length;
    if (free === ALLERGENS.length) return [line('free', s.freeAll(ALLERGENS.length))];
    return free > 0 ? [...lines, line('free', s.sheetLine(s.free, s.freeRest(ALLERGENS.length)))] : lines;
  };

  return (
    <>
      <fieldset class="filter">
        <legend class="field__label">{s.check}</legend>
        <div class="choices">
          {(['', ...ALLERGENS] as const).map((allergen) => (
            <label class="choice" key={allergen || 'all'}>
              <input
                type="radio"
                name="allergen-check"
                checked={checked === allergen}
                onChange={(event) => {
                  setChecked(allergen);
                  // On the phone the chips run sideways: the one chosen is brought into view.
                  event.currentTarget.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}
              />
              {allergen ? option(allergen) : s.checkAll}
            </label>
          ))}
        </div>
      </fieldset>
      {CATEGORIES.filter((category) => config.menu.some((dish) => dish.category === category)).map((category) => (
        <section class="course" key={category} aria-labelledby={`course-${category}`}>
          <h3 class="course__title" id={`course-${category}`}>
            {t.site.courses[category]}
          </h3>
          <ul class="dishes">
            {config.menu
              .filter((dish) => dish.category === category)
              .map((dish) => {
                const name = localize(dish.name, language);
                const answer = checked ? allergenStatus(dish, checked) : null;
                return (
                  <li class="dish" key={dish.id}>
                    <div class="dish__head">
                      {canEdit ? (
                        <button type="button" class="dish__name dish__edit" id={`dish-${dish.id}`} aria-label={s.editDish(name)} onClick={() => onEdit(dish)}>
                          {name}
                        </button>
                      ) : (
                        <span class="dish__name">{name}</span>
                      )}
                      {dish.priceCents !== undefined && <span class="dish__price">{formatPrice(dish.priceCents, language)}</span>}
                    </div>
                    {answer ? line(answer, verdict[answer]) : sheet(dish)}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </>
  );
}
