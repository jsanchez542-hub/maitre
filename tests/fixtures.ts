import type { Dish } from '../src/allergens.js';
import type { BusinessConfig, Sitting } from '../src/config.js';
import { BookingEngine, type Session } from '../src/engine.js';
import { REFERENCE_ALPHABET, REFERENCE_LENGTH, type IdSource } from '../src/ids.js';
import type { Language } from '../src/i18n/index.js';
import { MemoryStore, type Channel } from '../src/store.js';

const lunch: Sitting = { service: 'lunch', firstSeating: '12:00', lastSeating: '13:30' };
const dinner: Sitting = { service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' };

export const DISHES: Dish[] = [
  {
    id: 'duck-confit',
    category: 'main',
    name: { fr: 'Confit de canard', en: 'Duck confit', es: 'Confit de pato' },
    priceCents: 2400,
    allergens: { gluten: 'free', milk: 'free', eggs: 'free', celery: 'may_contain' },
  },
  {
    id: 'onion-soup',
    category: 'starter',
    name: { fr: 'Soupe à l’oignon', en: 'Onion soup', es: 'Sopa de cebolla' },
    allergens: { gluten: 'contains', milk: 'contains', celery: 'contains' },
  },
  {
    id: 'chocolate-mousse',
    category: 'dessert',
    name: { fr: 'Mousse au chocolat', en: 'Chocolate mousse', es: 'Mousse de chocolate' },
    // Nuts are deliberately not documented: the engine must say it does not know.
    allergens: { eggs: 'contains', milk: 'contains', gluten: 'free' },
  },
];

/** A small bistro on purpose: few tables, so a test can fill a service and see what happens at the edge. */
export const TEST_CONFIG: BusinessConfig = {
  id: 'test-bistro',
  name: 'Bistro de test',
  timeZone: 'Europe/Paris',
  languages: ['fr', 'en', 'es'],
  defaultLanguage: 'fr',
  services: [
    { id: 'lunch', name: { fr: 'déjeuner', en: 'lunch', es: 'comida' } },
    { id: 'dinner', name: { fr: 'dîner', en: 'dinner', es: 'cena' } },
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
  exceptions: [
    {
      date: '2026-12-25',
      sittings: [],
      reason: { fr: 'Fermé pour Noël', en: 'Closed for Christmas', es: 'Cerrado por Navidad' },
    },
    // New Year's Eve runs late and a sitting starts after midnight, to test stays that cross midnight.
    { date: '2026-12-31', sittings: [{ service: 'dinner', firstSeating: '19:00', lastSeating: '23:30' }] },
    { date: '2027-01-01', sittings: [{ service: 'dinner', firstSeating: '00:30', lastSeating: '01:00' }] },
  ],
  slotMinutes: 15,
  tables: [
    { id: 't2', seats: 2, count: 2 },
    { id: 't4', seats: 4, count: 2 },
    { id: 't6', seats: 6, count: 1 },
  ],
  maxEmptySeats: 2,
  stays: [
    { upToPartySize: 2, minutes: 90 },
    { upToPartySize: 4, minutes: 120 },
    { upToPartySize: 6, minutes: 150 },
  ],
  minNoticeMinutes: 60,
  maxAdvanceDays: 90,
  holdMinutes: 5,
  maxPartySize: 6,
  menu: DISHES,
  faq: [
    {
      id: 'parking',
      question: { fr: 'Où se garer ?', en: 'Where can I park?', es: '¿Dónde aparcar?' },
      answer: { fr: 'Parking public à 200 m.', en: 'Public car park 200 m away.', es: 'Aparcamiento público a 200 m.' },
    },
  ],
};

/** Valid booking references in order, so tests can predict them. */
export function referenceFor(index: number): string {
  let value = index;
  let reference = '';
  for (let position = 0; position < REFERENCE_LENGTH; position += 1) {
    reference = REFERENCE_ALPHABET[value % REFERENCE_ALPHABET.length] + reference;
    value = Math.floor(value / REFERENCE_ALPHABET.length);
  }
  return reference;
}

export function sequentialIds(): IdSource {
  let ids = 0;
  let references = 0;
  return {
    id: () => `id-${(ids += 1)}`,
    reference: () => referenceFor((references += 1)),
  };
}

export interface Harness {
  engine: BookingEngine;
  store: MemoryStore;
  setNow(iso: string): void;
  advanceMinutes(minutes: number): void;
}

/** Wednesday 14 October 2026 at 10:00 in Paris, unless a test says otherwise. */
export function harness(nowIso = '2026-10-14T08:00:00Z', config: BusinessConfig = TEST_CONFIG): Harness {
  let now = new Date(nowIso);
  const store = new MemoryStore();
  const engine = new BookingEngine(config, store, { now: () => now, ids: sequentialIds() });
  return {
    engine,
    store,
    setNow: (iso) => {
      now = new Date(iso);
    },
    advanceMinutes: (minutes) => {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

/** `null` for a guest the channel has no number for: `undefined` would fall back to the default. */
export function guest(
  id: string,
  phone: string | null = '+33612345678',
  language: Language = 'fr',
  channel: Channel = 'whatsapp',
): Session {
  return {
    id,
    channel,
    language,
    ...(phone ? { phone: { e164: phone, source: channel === 'voice' ? 'caller_id' : 'whatsapp' } } : {}),
  };
}

/** Friday 16 October 2026. */
export const FRIDAY = { kind: 'date', date: '2026-10-16' } as const;
