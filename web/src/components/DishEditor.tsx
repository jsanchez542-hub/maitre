import { ALLERGENS, allergenStatus, localize, messages, type Allergen, type AllergenAnswer, type Dish, type DishCategory, type LocalizedText } from 'maitre';
import { useEffect, useRef, useState } from 'preact/hooks';
import { centsOf, idFor } from '../lib/settings';
import type { PanelApp } from './Panel';
import { EditActions, TrilingualFields, blankText, trimmedText, writtenIn } from './SettingsFields';
import { useSubmit, type EditorProps } from './SettingsEditors';

const CATEGORIES: readonly DishCategory[] = ['starter', 'main', 'side', 'dessert', 'drink'];
const ANSWERS: readonly AllergenAnswer[] = ['contains', 'may_contain', 'free', 'unknown'];

/** A price in cents as the owner writes it back: «12», «12,50», or «12.50» in English. */
function priceText(cents: number, language: PanelApp['language']): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(euros) : `${euros}${language === 'en' ? '.' : ','}${String(rest).padStart(2, '0')}`;
}

/**
 * One dish of the menu, added, changed or removed: its name in each language, its course and price, and what the
 * kitchen's sheet says of each of the fourteen allergens. An allergen left «non renseigné» is one the assistant never
 * answers for: it passes the question to the team. A dish keeps its id when it is renamed.
 */
export function DishEditor({ app, dish, save, refused, onCancel }: Omit<EditorProps, 'onCancel'> & { dish: Dish | null; onCancel: () => void }) {
  const { t, language, config } = app;
  const s = t.panel.settings;
  const words = messages(language);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState<LocalizedText>(() => (dish ? { ...dish.name } : blankText()));
  const [category, setCategory] = useState<DishCategory>(dish?.category ?? 'main');
  const [price, setPrice] = useState(() => (dish?.priceCents === undefined ? '' : priceText(dish.priceCents, language)));
  const [answers, setAnswers] = useState<Record<Allergen, AllergenAnswer>>(
    () => Object.fromEntries(ALLERGENS.map((allergen) => [allergen, dish ? allergenStatus(dish, allergen) : 'unknown'])) as Record<Allergen, AllergenAnswer>,
  );
  const [removing, setRemoving] = useState(false);
  const { tried, busy, submit } = useSubmit(save);
  const answerWord: Record<AllergenAnswer, string> = { contains: s.contains, may_contain: s.traces, free: s.free, unknown: s.unknown };

  // On its title, as the booking sheet: the dish's name field would bring up a phone's keyboard over its allergens.
  useEffect(() => {
    dialog.current?.showModal();
    title.current?.focus();
  }, []);

  const cents = centsOf(price);
  const holds = writtenIn(name) === 'all' && cents !== 'unreadable';
  const menu = (): Dish[] => {
    const made: Dish = {
      id: dish?.id ?? idFor(name.fr, new Set(config.menu.map((other) => other.id)), 'dish'),
      name: trimmedText(name),
      category,
      ...(dish?.description ? { description: dish.description } : {}),
      ...(typeof cents === 'number' ? { priceCents: cents } : {}),
      allergens: Object.fromEntries(ALLERGENS.flatMap((allergen) => (answers[allergen] === 'unknown' ? [] : [[allergen, answers[allergen]]]))),
    };
    return dish ? config.menu.map((other) => (other.id === dish.id ? made : other)) : [...config.menu, made];
  };
  const remove = () => {
    if (!dish) return;
    if (!removing) {
      setRemoving(true);
      return;
    }
    void save({ menu: config.menu.filter((other) => other.id !== dish.id) });
  };

  return (
    <dialog ref={dialog} class="sheet" aria-labelledby="dish-title" onClose={onCancel}>
      <form class="sheet__form" noValidate onSubmit={(event) => void submit(event, holds, () => ({ menu: menu() }))}>
        <h2 class="sheet__title" id="dish-title" tabIndex={-1} ref={title}>
          {dish ? localize(dish.name, language) : s.addDish}
        </h2>
        <TrilingualFields legend={s.dishName} value={name} onChange={setName} />
        {tried && writtenIn(name) !== 'all' && <p class="edit__problem" role="alert">{s.nameMissing}</p>}
        <div class="fields fields--pair">
          <label class="field">
            <span class="field__label">{s.category}</span>
            <select value={category} onInput={(event) => setCategory(event.currentTarget.value as DishCategory)}>
              {CATEGORIES.map((course) => (
                <option key={course} value={course}>
                  {t.site.courses[course]}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">
              {s.price} <span class="field__optional">({t.panel.booking.optional})</span>
            </span>
            <input type="text" inputMode="decimal" maxLength={9} value={price} onInput={(event) => setPrice(event.currentTarget.value)} />
          </label>
        </div>
        {tried && cents === 'unreadable' && <p class="edit__problem" role="alert">{s.priceUnreadable}</p>}
        <fieldset class="allergen-edit">
          <legend class="field__label">{s.allergens}</legend>
          {ALLERGENS.map((allergen) => (
            <fieldset class="allergen-edit__row" key={allergen}>
              <legend class="allergen-edit__name">{words.allergen(allergen)}</legend>
              <div class="segments">
                {ANSWERS.map((answer) => (
                  <label class={`segment segment--${answer}`} key={answer}>
                    <input
                      type="radio"
                      name={`allergen-${allergen}`}
                      checked={answers[allergen] === answer}
                      onChange={() => setAnswers({ ...answers, [allergen]: answer })}
                    />
                    {answerWord[answer]}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </fieldset>
        <EditActions s={s} busy={busy} refused={refused} onCancel={() => dialog.current?.close()} />
        {dish && (
          <button type="button" class="action action--quiet edit__remove" onClick={remove}>
            {removing ? s.removeForGood : s.removeDish}
          </button>
        )}
      </form>
    </dialog>
  );
}
