import type { Allergen } from '../allergens.js';
import type { Messages } from './types.js';

const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'] as const;
const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const ALLERGEN_NAMES: Record<Allergen, string> = {
  gluten: 'gluten',
  crustaceans: 'crustáceos',
  eggs: 'huevo',
  fish: 'pescado',
  peanuts: 'cacahuetes',
  soybeans: 'soja',
  milk: 'leche',
  nuts: 'frutos de cáscara',
  celery: 'apio',
  mustard: 'mostaza',
  sesame: 'sésamo',
  sulphites: 'sulfitos',
  lupin: 'altramuces',
  molluscs: 'moluscos',
};

export const es: Messages = {
  date({ weekday, day, month, year }) {
    const base = `${WEEKDAYS[weekday - 1]} ${day} de ${MONTHS[month - 1]}`;
    return year === undefined ? base : `${base} de ${year}`;
  },
  time(hours, minutes) {
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  },
  dateAtTime(date, time) {
    // "a la 1:00" but "a las 13:00": the article agrees with the hour.
    return `${date} ${time.startsWith('1:') ? 'a la' : 'a las'} ${time}`;
  },
  booking(partySize, date, time) {
    const table = partySize === 1 ? 'una mesa para 1 persona' : `una mesa para ${partySize} personas`;
    return `${table} el ${es.dateAtTime(date, time)}`;
  },
  allergen(allergen) {
    return ALLERGEN_NAMES[allergen];
  },
  dishContains(dish, allergen) {
    return `El plato «${dish}» contiene ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishMayContain(dish, allergen) {
    return `El plato «${dish}» puede contener trazas de ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishFree(dish, allergen) {
    return `Según la ficha de cocina, el plato «${dish}» no contiene ${ALLERGEN_NAMES[allergen]}.`;
  },
  dishUnknown(dish, allergen) {
    return (
      `La ficha del plato «${dish}» no indica si contiene ${ALLERGEN_NAMES[allergen]}. ` +
      'Prefiero trasladar su pregunta al equipo antes que adivinar.'
    );
  },
  allergenQuestion(dish, allergens) {
    return `Alérgenos que la ficha del plato «${dish}» no indica: ${allergens.map((allergen) => ALLERGEN_NAMES[allergen]).join(', ')}.`;
  },
  greeting(business, channel) {
    if (channel === 'voice') {
      return (
        `Hola, ha llamado a ${business}. Soy el asistente automático de reservas, un programa de inteligencia ` +
        'artificial, y esta llamada puede ser grabada. ¿En qué puedo ayudarle?'
      );
    }
    return (
      `Hola y bienvenido a ${business}. Soy el asistente de reservas: puedo buscarle una mesa y responder ` +
      'a sus preguntas sobre la carta y los horarios. ¿En qué puedo ayudarle?'
    );
  },
  failureHandedOver() {
    return 'Lo siento, tengo un problema técnico. He trasladado su solicitud al equipo, que se pondrá en contacto con usted.';
  },
  failureRetry() {
    return 'Lo siento, tengo un problema técnico. ¿Puede intentarlo de nuevo en un momento?';
  },
  emptyMessage() {
    return 'No he recibido ningún mensaje. ¿En qué puedo ayudarle?';
  },
  walkInGuest() {
    return 'Cliente sin reserva';
  },
};
