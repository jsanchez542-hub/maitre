import { addDays, localNow, toMinutes, zonedInstant, type PlainDate } from '../calendar.js';
import type { BusinessConfig } from '../config.js';
import { BookingEngine, type Session } from '../engine.js';
import { formatDate, type Language } from '../i18n/index.js';
import { REFERENCE_ALPHABET, REFERENCE_LENGTH, type IdSource } from '../ids.js';
import { sittingsOn } from '../schedule.js';
import { MemoryStore, type BookingStore } from '../store.js';
import { runTool } from '../tools.js';
import type { ChatOutcome } from './chat.js';
import { DEMO_RESTAURANT } from './restaurant.js';

/** The day of the recorded evening, where the recordings took place. */
export const DEMO_EVENING_DATE = '2026-10-16';

/** Friday 16 October 2026 at 20:05 in Paris, in the middle of dinner: the recorded evening. */
export const DEMO_EVENING_AT = '2026-10-16T18:05:00.000Z';

export interface DemoEvening {
  engine: BookingEngine;
  /** The day of the service the evening is about: the dashboard opens on it. */
  day: PlainDate;
  /** The restaurant's clock. */
  clock: { now(): Date; set(instant: Date): void };
}

export interface DemoEveningOptions {
  /**
   * The conversations the visitor has played in the chat, from `recordingOutcome`.
   * Their bookings are made when the conversation took place, through the same
   * operations as any guest's, so they are on the plan of the evening. They
   * belong to the recorded evening.
   */
  fromChat?: readonly ChatOutcome[];
  /**
   * Where the evening is written: in memory by default, or a store that keeps
   * it, such as the database of a visitor's own restaurant on the server, whose
   * engine then takes the restaurant over.
   */
  store?: BookingStore;
  /**
   * The restaurant lives at this instant, as a real one does: its service is
   * seeded around it, with what came before it done and what comes after it
   * still to come. Without it, the evening is the recorded one, Friday 16
   * October at 20:05.
   */
  now?: Date;
}

/** How long a service goes on after its last seating: the last tables are still at dinner. */
const SERVICE_TAIL_MINUTES = 120;

/**
 * The day of the service a restaurant is about at an instant: today while one
 * of today's services is still going on, otherwise the next day it opens. At
 * 23:45, or on its day off, a restaurant's book is about its next service.
 */
export function serviceDayAt(instant: Date, config: BusinessConfig = DEMO_RESTAURANT): PlainDate {
  const local = localNow(instant, config.timeZone);
  for (let ahead = 0; ahead <= 14; ahead += 1) {
    const date = addDays(local.date, ahead);
    const sittings = sittingsOn(config, date);
    if (sittings.length === 0) continue;
    if (ahead > 0) return date;
    const lastSeating = Math.max(...sittings.map((sitting) => toMinutes(sitting.lastSeating)));
    if (toMinutes(local.time) <= lastSeating + SERVICE_TAIL_MINUTES) return date;
  }
  return local.date;
}

/** A request a visitor can start the conversation with: a table that a guest could book now. */
export interface DemoSuggestion {
  date: PlainDate;
  time: string;
  partySize: number;
}

/** The time of the suggested table: the middle of dinner, free on the plan of the seeded evening. */
const SUGGESTED_TIME = '20:30';
/** How long ahead a table can still be booked, as the restaurant's rules say. */
const NOTICE_MINUTES = 60;

/**
 * The first dinner a guest could still book at an instant, at 20:30 for two:
 * tonight before 19:30, otherwise the next evening the restaurant opens. The
 * site words its examples from it ("ce soir", "demain soir", "vendredi soir"),
 * so none asks for a time already gone or an evening it is closed.
 */
export function demoSuggestion(instant: Date, config: BusinessConfig = DEMO_RESTAURANT): DemoSuggestion {
  const local = localNow(instant, config.timeZone);
  for (let ahead = 0; ahead <= 14; ahead += 1) {
    const date = addDays(local.date, ahead);
    const dinner = sittingsOn(config, date).some(
      (sitting) => sitting.service === 'dinner' && toMinutes(sitting.firstSeating) <= toMinutes(SUGGESTED_TIME) && toMinutes(SUGGESTED_TIME) <= toMinutes(sitting.lastSeating),
    );
    if (dinner && (ahead > 0 || toMinutes(local.time) + NOTICE_MINUTES <= toMinutes(SUGGESTED_TIME))) return { date, time: SUGGESTED_TIME, partySize: 2 };
  }
  return { date: addDays(local.date, 1), time: SUGGESTED_TIME, partySize: 2 };
}

type GuestChannel = 'voice' | 'whatsapp' | 'web';

const PHONE_SOURCES = { voice: 'caller_id', whatsapp: 'whatsapp', web: 'form' } as const;

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

/** Lunch: time, party, channel, name, seated at, left at. */
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
 * The rest of dinner, after the recorded 20:05: the late party sits down, the
 * later ones come, and the tables empty, each a little before its time (90
 * minutes for two, two hours up to four, two and a half up to six). Girard's
 * birthday table stays twenty minutes past its time, as one table does on a
 * real evening: it keeps its table until it leaves. Name, seated at, left at.
 */
const LATER_DINNER: readonly [string, string, string][] = [
  ['Moreau', '20:06', '21:40'],
  ['Petit', '20:09', '21:24'],
  ['Bernard', '20:17', '22:08'],
  ['Roux', '20:32', '21:55'],
  ['Fournier', '20:34', '22:48'],
  ['Girard', '21:02', '22:50'],
  ['Lambert', '21:34', '22:56'],
];

/** When the parties seated before 20:05 leave. */
const FIRST_SITTING_LEAVES: readonly [string, string][] = [
  ['Martin', '20:26'],
  ['Lefèvre', '20:52'],
  ['Dubois', '20:41'],
  ['Garcia', '21:50'],
];

/**
 * A day of service at the demo restaurant: lunch, then dinner, with the first
 * sitting at its tables by 20:05, one party at the door, another late, and two
 * calls to return.
 *
 * It is built through the engine's own operations, as the clock goes round:
 * guests book, move, confirm and cancel on their channels in the days before,
 * and the staff seat and see off each party on the day. Only what has happened
 * by the restaurant's now is done: the recorded evening stops at 20:05 on
 * Friday 16 October, a live restaurant at the real time. Every table, state and
 * history entry is one the engine produced, and the same instant gives the
 * same day on every load. All names and numbers are invented.
 */
export function demoEvening(options: DemoEveningOptions = {}): DemoEvening {
  const recorded = options.now === undefined;
  if (!recorded && options.fromChat?.length) throw new RangeError('The conversations played in the chat belong to the recorded evening');
  const until = options.now ?? new Date(DEMO_EVENING_AT);
  const timeZone = DEMO_RESTAURANT.timeZone;
  const day = recorded ? DEMO_EVENING_DATE : serviceDayAt(until);
  const dayBefore = addDays(day, -1);
  // Two days before, the week's bookings come in: the conversations played in the chat came before.
  const weekStarts = zonedInstant(addDays(day, -2), '11:00', timeZone);
  const services = new Set(sittingsOn(DEMO_RESTAURANT, day).map((sitting) => sitting.service));

  let now = new Date(weekStarts);
  const engine = new BookingEngine(DEMO_RESTAURANT, options.store ?? new MemoryStore(), { now: () => now, ids: seededIds(16_10_2026) });
  /** Something that happens at a time of the day, once that time has come. */
  const when = (time: string, run: () => void, date = day): void => {
    const instant = zonedInstant(date, time, timeZone);
    if (instant.getTime() > until.getTime()) return;
    now = instant;
    run();
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
    const found = engine.findTable(session, { date: { kind: 'date', date: day }, time, partySize });
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

  // The conversations the visitor played in the chat, when they took place.
  const played = [...(options.fromChat ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  for (const outcome of played) {
    if (Date.parse(outcome.at) >= weekStarts.getTime()) throw new RangeError(`The conversation "${outcome.recording}" took place after the evening's week began`);
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

  // The week's bookings come in, for the services the day has.
  now = new Date(weekStarts);
  const references = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const lunch = services.has('lunch') ? LUNCH : [];
  const dinner = services.has('dinner') ? DINNER : [];
  for (const [time, partySize, channel, name] of lunch) references.set(name, book(guest(channel), time, partySize, name));
  for (const booking of dinner) {
    const session = guest(booking.channel, booking.language);
    sessions.set(booking.name, session);
    references.set(booking.name, book(session, booking.time, booking.partySize, booking.name, booking));
  }
  const reference = (name: string): string => references.get(name) ?? '';
  const session = (name: string): Session => sessions.get(name) as Session;

  if (dinner.length > 0) {
    // The day before: Roux moves to 20:30, and the reminders are answered.
    when(
      '18:30',
      () => {
        const later = engine.findTable(session('Roux'), { date: { kind: 'date', date: day }, time: '20:30', partySize: 2, changing: reference('Roux') });
        if (later.status !== 'available') throw new Error(`The demo evening could not find Roux a later table: ${later.status}`);
        ok(engine.change(session('Roux'), { reference: reference('Roux'), holdId: later.holdId }), 'changed', 'move Roux');
      },
      dayBefore,
    );
    when('19:10', () => {
      for (const name of ['Petit', 'Roux']) ok(engine.confirm(onWhatsApp(session(name))), 'confirmed', `confirm ${name}`);
    }, dayBefore);
    when('10:20', () => ok(engine.confirm(onWhatsApp(session('Fournier'))), 'confirmed', 'confirm Fournier'));
  }

  // Lunch: every party seated, then gone.
  const lunchEvents = lunch
    .flatMap(([, , , name, seated, left]) => [
      { time: seated, run: () => ok(engine.seat(reference(name)), 'done', `seat ${name}`) },
      { time: left, run: () => ok(engine.markLeft(reference(name)), 'done', `see ${name} off`) },
    ])
    .sort((a, b) => a.time.localeCompare(b.time));
  for (const event of lunchEvents) when(event.time, event.run);

  // Dinner.
  if (dinner.length > 0) {
    let walkIn = '';
    const evening: { time: string; run: () => void }[] = [
      { time: '18:40', run: () => ok(engine.cancel(session('Bonnet'), { reference: reference('Bonnet') }), 'cancelled', 'cancel Bonnet') },
      ...(
        [
          ['19:02', 'Martin'],
          ['19:05', 'Lefèvre'],
          ['19:18', 'Dubois'],
          ['19:34', 'Garcia'],
        ] as const
      ).map(([time, name]) => ({ time, run: () => void ok(engine.seat(reference(name)), 'done', `seat ${name}`) })),
      {
        time: '19:40',
        run: () =>
          ok(
            engine.requestCallback(guest('voice'), {
              reason: 'large_group',
              summary: `Groupe de 9 pour un anniversaire, ${formatDate(addDays(day, 1), 'fr', day)} au soir.`,
            }),
            'recorded',
            'pass on a party of nine',
          ),
      },
      {
        time: '19:55',
        // Asked on WhatsApp: the sheet says nothing about nuts in the mousse, so the code passes the question on.
        run: () => ok(runTool(engine, guest('whatsapp'), 'check_dish', { dishId: 'chocolate-mousse', allergens: ['nuts'] }), 'ok', 'check the mousse'),
      },
      {
        time: '20:00',
        run: () => {
          const placed = engine.staffBook({ date: day, partySize: 3, walkIn: true });
          if (placed.status !== 'booked') throw new Error(`The demo evening could not seat a party on the spot: ${placed.status}`);
          walkIn = placed.booking.reference;
        },
      },
      { time: '20:03', run: () => ok(engine.markArrived(reference('Moreau')), 'done', 'greet Moreau') },
      // In the recorded evening someone is booking online right now: the table is held until 20:08.
      ...(recorded
        ? [{ time: '20:03', run: () => ok(engine.findTable(guest('web'), { date: { kind: 'date', date: day }, time: '21:15', partySize: 4 }), 'available', 'hold a table') }]
        : []),
      ...LATER_DINNER.flatMap(([name, seated, left]) => [
        { time: seated, run: () => void ok(engine.seat(reference(name)), 'done', `seat ${name}`) },
        { time: left, run: () => void ok(engine.markLeft(reference(name)), 'done', `see ${name} off`) },
      ]),
      ...FIRST_SITTING_LEAVES.map(([name, left]) => ({ time: left, run: () => void ok(engine.markLeft(reference(name)), 'done', `see ${name} off`) })),
      { time: '21:38', run: () => void ok(engine.markLeft(walkIn), 'done', 'see the party on the spot off') },
    ];
    // In the order of the clock; what happens at the same minute, in the order written.
    const ordered = evening.map((event, index) => ({ ...event, index })).sort((a, b) => a.time.localeCompare(b.time) || a.index - b.index);
    for (const event of ordered) when(event.time, event.run);
  }

  now = new Date(until);
  return {
    engine,
    day,
    clock: {
      now: () => new Date(now),
      set: (instant: Date) => {
        now = new Date(instant);
      },
    },
  };
}
