import type { Allergen } from '../allergens.js';
import type { Messages } from './types.js';

// French typography: a narrow no-break space before : ; ! ? and inside « »,
// a no-break space in "20 h 30", and the typographic apostrophe.
const THIN = ' ';
const NBSP = ' ';

const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'] as const;
const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** The name, the name with its article ("du gluten") and after a negation ("pas de gluten"). */
const ALLERGEN_WORDS: Record<Allergen, { name: string; some: string; none: string }> = {
  gluten: { name: 'gluten', some: 'du gluten', none: 'de gluten' },
  crustaceans: { name: 'crustacés', some: 'des crustacés', none: 'de crustacés' },
  eggs: { name: 'œufs', some: 'des œufs', none: 'd’œufs' },
  fish: { name: 'poisson', some: 'du poisson', none: 'de poisson' },
  peanuts: { name: 'arachides', some: 'des arachides', none: 'd’arachides' },
  soybeans: { name: 'soja', some: 'du soja', none: 'de soja' },
  milk: { name: 'lait', some: 'du lait', none: 'de lait' },
  nuts: { name: 'fruits à coque', some: 'des fruits à coque', none: 'de fruits à coque' },
  celery: { name: 'céleri', some: 'du céleri', none: 'de céleri' },
  mustard: { name: 'moutarde', some: 'de la moutarde', none: 'de moutarde' },
  sesame: { name: 'sésame', some: 'du sésame', none: 'de sésame' },
  sulphites: { name: 'sulfites', some: 'des sulfites', none: 'de sulfites' },
  lupin: { name: 'lupin', some: 'du lupin', none: 'de lupin' },
  molluscs: { name: 'mollusques', some: 'des mollusques', none: 'de mollusques' },
};

const quoted = (dish: string): string => `«${THIN}${dish}${THIN}»`;

export const fr: Messages = {
  date({ weekday, day, month, year }) {
    const dayText = day === 1 ? '1er' : String(day);
    const base = `${WEEKDAYS[weekday - 1]} ${dayText} ${MONTHS[month - 1]}`;
    return year === undefined ? base : `${base} ${year}`;
  },
  time(hours, minutes) {
    return minutes === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h${NBSP}${String(minutes).padStart(2, '0')}`;
  },
  dateAtTime(date, time) {
    return `${date} à ${time}`;
  },
  booking(partySize, date, time) {
    const table = partySize === 1 ? 'une table pour 1 personne' : `une table pour ${partySize} personnes`;
    return `${table} le ${date} à ${time}`;
  },
  allergen(allergen) {
    return ALLERGEN_WORDS[allergen].name;
  },
  dishContains(dish, allergen) {
    return `Le plat ${quoted(dish)} contient ${ALLERGEN_WORDS[allergen].some}.`;
  },
  dishMayContain(dish, allergen) {
    return `Le plat ${quoted(dish)} peut contenir des traces ${ALLERGEN_WORDS[allergen].none}.`;
  },
  dishFree(dish, allergen) {
    return `D’après la fiche de la cuisine, le plat ${quoted(dish)} ne contient pas ${ALLERGEN_WORDS[allergen].none}.`;
  },
  dishUnknown(dish, allergen) {
    return (
      `La fiche du plat ${quoted(dish)} ne précise pas s’il contient ${ALLERGEN_WORDS[allergen].some}. ` +
      'Je préfère transmettre votre question à l’équipe plutôt que de deviner.'
    );
  },
  greeting(business, channel) {
    if (channel === 'voice') {
      return (
        `Bonjour, vous êtes bien chez ${business}. Je suis l’assistant vocal de réservation, un programme ` +
        `d’intelligence artificielle, et cet appel peut être enregistré. Que puis-je faire pour vous${THIN}?`
      );
    }
    return (
      `Bonjour et bienvenue chez ${business}. Je suis l’assistant de réservation${THIN}: je peux vous trouver ` +
      `une table et vous renseigner sur la carte et les horaires. Que puis-je faire pour vous${THIN}?`
    );
  },
  failureHandedOver() {
    return 'Je suis désolé, je rencontre un problème technique. J’ai transmis votre demande à l’équipe, qui vous recontactera.';
  },
  failureRetry() {
    return `Je suis désolé, je rencontre un problème technique. Pouvez-vous réessayer dans un instant${THIN}?`;
  },
  emptyMessage() {
    return `Je n’ai pas reçu de message. Que puis-je faire pour vous${THIN}?`;
  },
  walkInGuest() {
    return 'Client sur place';
  },
};
