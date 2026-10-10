import type { Allergen } from '../allergens.js';
import type { Messages } from './types.js';

// British English: the restaurant is in France and most English-speaking guests are European.
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const ALLERGEN_NAMES: Record<Allergen, string> = {
  gluten: 'gluten',
  crustaceans: 'crustaceans',
  eggs: 'eggs',
  fish: 'fish',
  peanuts: 'peanuts',
  soybeans: 'soya',
  milk: 'milk',
  nuts: 'tree nuts',
  celery: 'celery',
  mustard: 'mustard',
  sesame: 'sesame',
  sulphites: 'sulphites',
  lupin: 'lupin',
  molluscs: 'molluscs',
};

// Without quotation marks, models "correct" a dish name into "the chocolate mousse",
// and a sentence that must be repeated word for word no longer is.
const quoted = (dish: string): string => `“${dish}”`;

export const en: Messages = {
  date({ weekday, day, month, year }) {
    const base = `${WEEKDAYS[weekday - 1]} ${day} ${MONTHS[month - 1]}`;
    return year === undefined ? base : `${base} ${year}`;
  },
  time(hours, minutes) {
    const suffix = hours < 12 ? 'am' : 'pm';
    const twelveHour = hours % 12 === 0 ? 12 : hours % 12;
    return minutes === 0 ? `${twelveHour} ${suffix}` : `${twelveHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
  },
  dateAtTime(date, time) {
    return `${date} at ${time}`;
  },
  booking(partySize, date, time) {
    const table = partySize === 1 ? 'a table for one' : `a table for ${partySize}`;
    return `${table} on ${date} at ${time}`;
  },
  allergen(allergen) {
    return ALLERGEN_NAMES[allergen];
  },
  dishContains(dish, allergen) {
    return `${quoted(dish)} contains ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishMayContain(dish, allergen) {
    return `${quoted(dish)} may contain traces of ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishFree(dish, allergen) {
    return `According to the kitchen’s allergen sheet, ${quoted(dish)} contains no ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishUnknown(dish, allergen) {
    return (
      `The allergen sheet for ${quoted(dish)} does not say whether it contains ${ALLERGEN_NAMES[allergen]}. ` +
      'I would rather pass your question on to the team than guess.'
    );
  },
  allergenQuestion(dish, allergens) {
    return `Allergens the sheet for ${quoted(dish)} does not cover: ${allergens.map((allergen) => ALLERGEN_NAMES[allergen]).join(', ')}.`;
  },
  greeting(business, channel) {
    if (channel === 'voice') {
      return `Hello, you have reached ${business}. I am the automated booking assistant, an AI, and this call may be recorded. How can I help?`;
    }
    return `Hello and welcome to ${business}. I am the booking assistant: I can find you a table and answer questions about the menu and opening hours. How can I help?`;
  },
  failureHandedOver() {
    return 'I am sorry, something went wrong on my side. I have passed your request on to the team, who will get back to you.';
  },
  failureRetry() {
    return 'I am sorry, something went wrong on my side. Could you try again in a moment?';
  },
  emptyMessage() {
    return 'I did not receive a message. How can I help?';
  },
  walkInGuest() {
    return 'Walk-in guest';
  },
};
