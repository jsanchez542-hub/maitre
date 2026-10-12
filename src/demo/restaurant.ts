import type { Dish } from '../allergens.js';
import type { BusinessConfig, Sitting } from '../config.js';

/**
 * The invented restaurant of the demo and of the evaluation: a Bordeaux menu,
 * and allergen sheets left incomplete on purpose, because an assistant that is
 * never asked about an undocumented allergen is never caught guessing one.
 */

const lunch: Sitting = { service: 'lunch', firstSeating: '12:00', lastSeating: '13:45' };
const dinner: Sitting = { service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' };

const dish = (
  id: string,
  category: Dish['category'],
  fr: string,
  en: string,
  es: string,
  priceCents: number,
  allergens: Dish['allergens'],
): Dish => ({ id, category, name: { fr, en, es }, priceCents, allergens });

export const DEMO_MENU: Dish[] = [
  dish('onion-soup', 'starter', 'Soupe à l’oignon gratinée', 'French onion soup', 'Sopa de cebolla gratinada', 900, {
    gluten: 'contains',
    milk: 'contains',
    celery: 'contains',
  }),
  dish('goat-cheese-salad', 'starter', 'Salade de chèvre chaud', 'Warm goat’s cheese salad', 'Ensalada de queso de cabra caliente', 1100, {
    milk: 'contains',
    gluten: 'contains',
    mustard: 'contains',
    nuts: 'may_contain',
    eggs: 'free',
  }),
  dish('oysters', 'starter', 'Huîtres du bassin d’Arcachon', 'Arcachon Bay oysters', 'Ostras de la bahía de Arcachon', 1600, {
    molluscs: 'contains',
    gluten: 'free',
    milk: 'free',
  }),
  dish('duck-confit', 'main', 'Confit de canard, pommes sarladaises', 'Duck confit with Sarlat potatoes', 'Confit de pato con patatas sarladesas', 2400, {
    gluten: 'free',
    milk: 'free',
    eggs: 'free',
    nuts: 'free',
    celery: 'may_contain',
  }),
  dish('entrecote', 'main', 'Entrecôte à la bordelaise', 'Rib-eye steak, Bordelaise sauce', 'Entrecot a la bordelesa', 2900, {
    sulphites: 'contains',
    milk: 'contains',
    gluten: 'free',
    celery: 'free',
    mustard: 'free',
  }),
  dish('mushroom-risotto', 'main', 'Risotto aux cèpes', 'Porcini risotto', 'Risotto de boletus', 2100, {
    milk: 'contains',
    celery: 'contains',
    sulphites: 'contains',
    gluten: 'free',
    eggs: 'free',
    nuts: 'free',
  }),
  dish('caneles', 'dessert', 'Canelés de Bordeaux', 'Bordeaux canelés', 'Canelés de Burdeos', 800, {
    eggs: 'contains',
    milk: 'contains',
    gluten: 'contains',
    nuts: 'free',
  }),
  // Nuts are not on this sheet: asking about them must end with the team, not with a guess.
  dish('chocolate-mousse', 'dessert', 'Mousse au chocolat', 'Chocolate mousse', 'Mousse de chocolate', 900, {
    eggs: 'contains',
    milk: 'contains',
    gluten: 'free',
  }),
];

const text = (fr: string, en: string, es: string) => ({ fr, en, es });

export const DEMO_RESTAURANT: BusinessConfig = {
  id: 'demo',
  name: 'Merrain',
  timeZone: 'Europe/Paris',
  languages: ['fr', 'en', 'es'],
  defaultLanguage: 'fr',
  services: [
    { id: 'lunch', name: text('déjeuner', 'lunch', 'comida') },
    { id: 'dinner', name: text('dîner', 'dinner', 'cena') },
  ],
  weekly: {
    1: [],
    2: [lunch, dinner],
    3: [lunch, dinner],
    4: [lunch, dinner],
    5: [lunch, dinner],
    6: [lunch, dinner],
    7: [{ service: 'lunch', firstSeating: '12:00', lastSeating: '14:00' }],
  },
  exceptions: [],
  slotMinutes: 15,
  tables: [
    { id: 't2', seats: 2, count: 6 },
    { id: 't4', seats: 4, count: 5 },
    { id: 't6', seats: 6, count: 2 },
  ],
  // A Bordeaux bistrot, in percent of the room with the street windows along the top:
  // a banquette down the left wall with the tables for two, the long tables and one
  // more for two at the windows, the tables for four staggered in the middle, the bar
  // down the right wall, the kitchen and the door on the bottom wall. The web draws
  // the walls, the banquette, the bar and its stools around these points.
  floor: {
    zones: [
      { id: 'banquette', name: text('Banquette', 'Banquette', 'Banqueta') },
      { id: 'window', name: text('Fenêtre', 'Window', 'Ventana') },
      { id: 'room', name: text('Salle', 'Main room', 'Sala') },
    ],
    tables: [
      { number: '1', group: 't2', shape: 'round', x: 11, y: 28, zone: 'banquette' },
      { number: '2', group: 't2', shape: 'round', x: 11, y: 40, zone: 'banquette' },
      { number: '3', group: 't2', shape: 'round', x: 11, y: 52, zone: 'banquette' },
      { number: '4', group: 't2', shape: 'round', x: 11, y: 64, zone: 'banquette' },
      { number: '5', group: 't2', shape: 'round', x: 11, y: 76, zone: 'banquette' },
      { number: '6', group: 't2', shape: 'round', x: 78, y: 13, zone: 'window' },
      { number: '7', group: 't4', shape: 'square', x: 32, y: 40, zone: 'room' },
      { number: '8', group: 't4', shape: 'square', x: 51, y: 40, zone: 'room' },
      { number: '9', group: 't4', shape: 'square', x: 32, y: 64, zone: 'room' },
      { number: '10', group: 't4', shape: 'square', x: 51, y: 64, zone: 'room' },
      { number: '11', group: 't4', shape: 'square', x: 68, y: 52, zone: 'room' },
      { number: '12', group: 't6', shape: 'rect', x: 29, y: 13, zone: 'window' },
      { number: '13', group: 't6', shape: 'rect', x: 54, y: 13, zone: 'window' },
    ],
  },
  // Invented, like everything else in this restaurant. One section per side of the room,
  // with about as many seats each: Léa has the banquette and the windows, Hugo the middle.
  waiters: [
    { id: 'lea', name: 'Léa', tables: ['1', '2', '3', '4', '5', '6', '12', '13'], services: ['dinner'] },
    { id: 'hugo', name: 'Hugo', tables: ['7', '8', '9', '10', '11'], services: ['dinner'] },
  ],
  maxEmptySeats: 2,
  stays: [
    { upToPartySize: 2, minutes: 90 },
    { upToPartySize: 4, minutes: 120 },
    { upToPartySize: 6, minutes: 150 },
  ],
  minNoticeMinutes: 60,
  maxAdvanceDays: 60,
  holdMinutes: 5,
  maxPartySize: 6,
  menu: DEMO_MENU,
  faq: [
    {
      id: 'parking',
      question: text('Où se garer ?', 'Where can I park?', '¿Dónde aparcar?'),
      answer: text(
        'Le parking public des Grands-Hommes est à cinq minutes à pied.',
        'The Grands-Hommes public car park is a five-minute walk away.',
        'El aparcamiento público de los Grands-Hommes está a cinco minutos a pie.',
      ),
    },
    {
      id: 'payment',
      question: text('Quels moyens de paiement ?', 'How can I pay?', '¿Qué formas de pago aceptan?'),
      answer: text(
        'Cartes bancaires, espèces et titres-restaurant le midi.',
        'Cards, cash, and meal vouchers at lunch.',
        'Tarjeta, efectivo y tickets restaurante al mediodía.',
      ),
    },
    {
      id: 'access',
      question: text('Le restaurant est-il accessible ?', 'Is the restaurant accessible?', '¿El restaurante es accesible?'),
      answer: text(
        'Oui, la salle est de plain-pied et les toilettes sont adaptées.',
        'Yes, the dining room is step-free and the toilets are adapted.',
        'Sí, la sala está a pie de calle y los aseos están adaptados.',
      ),
    },
    {
      id: 'children',
      question: text('Accueillez-vous les enfants ?', 'Are children welcome?', '¿Aceptan niños?'),
      answer: text(
        'Avec plaisir, nous avons des chaises hautes.',
        'Of course, and we have high chairs.',
        'Por supuesto, tenemos tronas.',
      ),
    },
    {
      id: 'dogs',
      question: text('Les chiens sont-ils acceptés ?', 'Are dogs allowed?', '¿Se admiten perros?'),
      answer: text(
        'Les chiens tenus en laisse sont acceptés en terrasse uniquement.',
        'Dogs on a lead are welcome on the terrace only.',
        'Los perros con correa solo se admiten en la terraza.',
      ),
    },
  ],
};
