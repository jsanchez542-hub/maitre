import { BookingEngine, type Session } from '../engine.js';
import type { Language } from '../i18n/index.js';
import { REFERENCE_ALPHABET, REFERENCE_LENGTH, type IdSource } from '../ids.js';
import { MemoryStore } from '../store.js';
import { runTool } from '../tools.js';
import type { ChatOutcome } from './chat.js';
import { DEMO_RESTAURANT } from './restaurant.js';

/** The day of the demo's dashboard. */
export const DEMO_EVENING_DATE = '2026-10-16';

/** Friday 16 October 2026 at 20:05 in Paris, in the middle of dinner. */
export const DEMO_EVENING_AT = '2026-10-16T18:05:00.000Z';

export interface DemoEvening {
  engine: BookingEngine;
  /** The restaurant's clock. The dashboard can move it on, to show the evening going on. */
  clock: { now(): Date; set(instant: Date): void };
}

export interface DemoEveningOptions {
  /**
   * The conversations the visitor has played in the chat, from `recordingOutcome`.
   * Their bookings are made when the conversation took place, through the same
   * operations as any guest's, so they are on the plan of the evening.
   */
  fromChat?: readonly ChatOutcome[];
}

/** The week of the evening starts here: the conversations played in the chat came before. */
const WEEK_STARTS = '2026-10-14T09:00:00.000Z';

type GuestChannel = 'voice' | 'whatsapp' | 'web';

const PHONE_SOURCES = { voice: 'caller_id', whatsapp: 'whatsapp', web: 'form' } as const;

/** Paris was on summer time that week. */
function paris(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+02:00`);
}

/** Identifiers that come out the same on every load: the demo and its screenshots show the same references. */
function seededIds(seed: number): IdSource {
  let state = seed >>> 0;
  let count = 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    id: () => `demo-${(count += 1)}`,
    reference: () => Array.from({ length: REFERENCE_LENGTH }, () => REFERENCE_ALPHABET[Math.floor(next() * REFERENCE_ALPHABET.length)]).join(''),
  };
}

const FRIDAY = DEMO_EVENING_DATE;

/** Lunch, long over by 20:05: time, party, channel, name, seated at, left at. */
const LUNCH: readonly [string, number, GuestChannel, string, string, string][] = [
  ['12:00', 2, 'web', 'Laurent', '12:03', '13:20'],
  ['12:00', 4, 'voice', 'Michel', '12:05', '13:40'],
  ['12:15', 2, 'whatsapp', 'David', '12:17', '13:30'],
  ['12:15', 3, 'voice', 'Bertrand', '12:20', '13:45'],
  ['12:30', 2, 'web', 'Morel', '12:32', '13:50'],
  ['12:30', 4, 'whatsapp', 'Fontaine', '12:36', '14:05'],
  ['12:45', 2, 'voice', 'Chevalier', '12:47', '14:00'],
  ['13:00', 3, 'web', 'Robin', '13:02', '14:20'],
  ['13:15', 2, 'whatsapp', 'Masson', '13:16', '14:30'],
];

interface DinnerBooking {
  time: string;
  partySize: number;
  channel: GuestChannel;
  name: string;
  language?: Language;
  allergies?: string[];
  notes?: string;
}

const DINNER: readonly DinnerBooking[] = [
  { time: '19:00', partySize: 2, channel: 'web', name: 'Martin' },
  { time: '19:00', partySize: 4, channel: 'voice', name: 'Lefèvre' },
  { time: '19:15', partySize: 2, channel: 'whatsapp', name: 'Dubois', allergies: ['nuts'] },
  { time: '19:30', partySize: 6, channel: 'voice', name: 'Garcia', language: 'es' },
  { time: '19:45', partySize: 4, channel: 'web', name: 'Moreau' },
  { time: '20:00', partySize: 2, channel: 'whatsapp', name: 'Petit', allergies: ['milk'] },
  { time: '20:15', partySize: 4, channel: 'whatsapp', name: 'Bernard' },
  // Booked for 20:00, moved to 20:30 the day before.
  { time: '20:00', partySize: 2, channel: 'voice', name: 'Roux' },
  { time: '20:30', partySize: 5, channel: 'voice', name: 'Fournier', allergies: ['gluten', 'sulphites'] },
  { time: '21:00', partySize: 2, channel: 'voice', name: 'Girard', notes: 'anniversaire' },
  { time: '21:15', partySize: 4, channel: 'web', name: 'Bonnet' },
  { time: '21:30', partySize: 2, channel: 'web', name: 'Lambert', language: 'en' },
];

/**
 * Friday dinner at the demo restaurant at 20:05: lunch over, the first
 * sitting at its tables, one party at the door, another late, a table being
 * booked online and two calls to return.
 *
 * It is built through the engine's own operations, as the clock goes round:
 * guests book, move, confirm and cancel on their channels during the week,
 * and the staff seat and see off each party on the day. Every table, state and
 * history entry is one the engine produced, and the evening is the same on
 * every load. All names and numbers are invented.
 */
export function demoEvening(options: DemoEveningOptions = {}): DemoEvening {
  let now = new Date(WEEK_STARTS);
  const engine = new BookingEngine(DEMO_RESTAURANT, new MemoryStore(), { now: () => now, ids: seededIds(16_10_2026) });
  const at = (time: string, date = FRIDAY): void => {
    now = paris(date, time);
  };
  const ok = <T extends { status: string }>(result: T, expected: string, what: string): T => {
    if (result.status !== expected) throw new Error(`The demo evening could not ${what}: ${result.status}`);
    return result;
  };

  let guests = 0;
  const guest = (channel: GuestChannel, language: Language = 'fr'): Session => {
    guests += 1;
    return {
      id: `demo-guest-${guests}`,
      channel,
      language,
      phone: { e164: `+3360000${String(guests).padStart(4, '0')}`, source: PHONE_SOURCES[channel] },
    };
  };
  // Booking reminders are answered on WhatsApp, whatever channel the booking came from.
  const onWhatsApp = (session: Session): Session => ({
    ...session,
    channel: 'whatsapp',
    ...(session.phone ? { phone: { e164: session.phone.e164, source: 'whatsapp' as const } } : {}),
  });
  const book = (session: Session, time: string, partySize: number, guestName: string, extra: Partial<DinnerBooking> = {}): string => {
    const found = engine.findTable(session, { date: { kind: 'date', date: FRIDAY }, time, partySize });
    if (found.status !== 'available') throw new Error(`The demo evening could not find a table for ${guestName}: ${found.status}`);
    const booked = engine.book(session, {
      holdId: found.holdId,
      guestName,
      ...(extra.allergies ? { allergies: extra.allergies } : {}),
      ...(extra.notes ? { notes: extra.notes } : {}),
    });
    if (booked.status !== 'booked') throw new Error(`The demo evening could not book ${guestName}: ${booked.status}`);
    return booked.booking.reference;
  };

  // Wednesday morning: the conversations the visitor played in the chat, when they took place.
  const played = [...(options.fromChat ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  for (const outcome of played) {
    if (outcome.at >= WEEK_STARTS) throw new RangeError(`The conversation "${outcome.recording}" took place after the evening's week began`);
    now = new Date(outcome.at);
    const session: Session = {
      id: `chat-${outcome.recording}`,
      channel: outcome.channel,
      language: outcome.language,
      ...(outcome.phone ? { phone: { e164: outcome.phone, source: PHONE_SOURCES[outcome.channel] } } : {}),
    };
    for (const made of outcome.bookings) {
      const found = engine.findTable(session, { date: { kind: 'date', date: made.date }, time: made.time, partySize: made.partySize });
      if (found.status !== 'available') {
        throw new Error(`The booking from the conversation "${outcome.recording}" does not fit in the demo evening: ${found.status}`);
      }
      ok(
        engine.book(session, { holdId: found.holdId, guestName: made.guestName, allergies: made.allergies, ...(made.notes ? { notes: made.notes } : {}) }),
        'booked',
        `book ${made.guestName} from the chat`,
      );
    }
    // And the requests it passed to the team, with the number the guest gave: calls to return tonight.
    for (const passed of outcome.callbacks) {
      ok(engine.requestCallback(session, passed), 'recorded', `pass on the request from the conversation "${outcome.recording}"`);
    }
  }

  // Wednesday: the week's bookings come in.
  now = new Date(WEEK_STARTS);
  const references = new Map<string, string>();
  const sessions = new Map<string, Session>();
  for (const [time, partySize, channel, name] of LUNCH) references.set(name, book(guest(channel), time, partySize, name));
  for (const booking of DINNER) {
    const session = guest(booking.channel, booking.language);
    sessions.set(booking.name, session);
    references.set(booking.name, book(session, booking.time, booking.partySize, booking.name, booking));
  }
  const reference = (name: string): string => references.get(name) ?? '';
  const session = (name: string): Session => sessions.get(name) as Session;

  // Thursday: Roux moves to 20:30, and the reminders are answered.
  at('18:30', '2026-10-15');
  const later = engine.findTable(session('Roux'), { date: { kind: 'date', date: FRIDAY }, time: '20:30', partySize: 2, changing: reference('Roux') });
  if (later.status !== 'available') throw new Error(`The demo evening could not find Roux a later table: ${later.status}`);
  ok(engine.change(session('Roux'), { reference: reference('Roux'), holdId: later.holdId }), 'changed', 'move Roux');
  at('19:10', '2026-10-15');
  for (const name of ['Petit', 'Roux']) ok(engine.confirm(onWhatsApp(session(name))), 'confirmed', `confirm ${name}`);
  at('10:20');
  ok(engine.confirm(onWhatsApp(session('Fournier'))), 'confirmed', 'confirm Fournier');

  // Friday lunch: every party seated, then gone.
  const lunchEvents = LUNCH.flatMap(([, , , name, seated, left]) => [
    { time: seated, run: () => ok(engine.seat(reference(name)), 'done', `seat ${name}`) },
    { time: left, run: () => ok(engine.markLeft(reference(name)), 'done', `see ${name} off`) },
  ]).sort((a, b) => a.time.localeCompare(b.time));
  for (const event of lunchEvents) {
    at(event.time);
    event.run();
  }

  // Friday evening.
  at('18:40');
  ok(engine.cancel(session('Bonnet'), { reference: reference('Bonnet') }), 'cancelled', 'cancel Bonnet');
  for (const [time, name] of [
    ['19:02', 'Martin'],
    ['19:05', 'Lefèvre'],
    ['19:18', 'Dubois'],
    ['19:34', 'Garcia'],
  ] as const) {
    at(time);
    ok(engine.seat(reference(name)), 'done', `seat ${name}`);
  }
  at('19:40');
  ok(
    engine.requestCallback(guest('voice'), { reason: 'large_group', summary: 'Groupe de 9 pour un anniversaire, samedi 17 octobre au soir.' }),
    'recorded',
    'pass on a party of nine',
  );
  at('19:55');
  // Asked on WhatsApp: the sheet says nothing about nuts in the mousse, so the code passes the question on.
  ok(runTool(engine, guest('whatsapp'), 'check_dish', { dishId: 'chocolate-mousse', allergens: ['nuts'] }), 'ok', 'check the mousse');
  at('20:00');
  ok(engine.staffBook({ date: FRIDAY, partySize: 3, walkIn: true }), 'booked', 'seat a party on the spot');
  at('20:03');
  ok(engine.markArrived(reference('Moreau')), 'done', 'greet Moreau');
  // Someone is booking online right now: the table is held until 20:08.
  ok(engine.findTable(guest('web'), { date: { kind: 'date', date: FRIDAY }, time: '21:15', partySize: 4 }), 'available', 'hold a table');
  at('20:05');

  return {
    engine,
    clock: {
      now: () => new Date(now),
      set: (instant: Date) => {
        now = new Date(instant);
      },
    },
  };
}
