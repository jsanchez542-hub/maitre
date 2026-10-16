import type {
  Activity,
  BusinessConfig,
  FreeTablesResult,
  Language,
  PlainDate,
  ServiceDay,
  StaffActionResult,
  StaffBookRequest,
  StaffBookResult,
  StaffChangeRequest,
  StaffBookingView,
  StaffChangeResult,
  TableActionResult,
} from 'maitre';
import type { DemoEvening } from 'maitre/demo';
import { conversationsOf, type Conversation } from './conversations';
import {
  completeCallback,
  freeTablesOf,
  readActivity,
  readCalls,
  readConfig,
  readDay,
  readOutsideHours,
  readTurns,
  saveConfig,
  staffAction,
  staffBook,
  staffChange,
  type RestaurantTime,
} from './live';
import type { EditableSettings, SettingsAnswer } from './settings';

/** As much of the log as a few busy days hold: older turns are cut off, never the newest. */
const TURNS = 200;
const CALLS = 50;

/** The day as the panel reads it: one day of service, and the restaurant's clock. */
export interface Reading {
  day: ServiceDay;
  now: Date;
}

/**
 * Where the panel reads the service and sends what the staff do: the visitor's own restaurant on the server, on the
 * real date and time, or the recorded evening in the browser, shown as such while the live demo is paused.
 */
export interface PanelBackend {
  readonly live: boolean;
  read(date: PlainDate, language: Language): Promise<Reading>;
  arrived(reference: string, language: Language): Promise<StaffActionResult>;
  seat(reference: string, table: string, language: Language): Promise<TableActionResult>;
  left(reference: string, language: Language): Promise<StaffActionResult>;
  /** To another table, where the booking is kept: the engine says if it is free for the whole stay. */
  move(reference: string, table: string, language: Language): Promise<TableActionResult>;
  cancel(reference: string, language: Language): Promise<StaffActionResult>;
  noShow(reference: string, language: Language): Promise<StaffActionResult>;
  book(request: StaffBookRequest): Promise<StaffBookResult>;
  /** What the staff changed on a booking, checked as a booking by hand is. */
  change(reference: string, change: StaffChangeRequest): Promise<StaffChangeResult>;
  /** «À confirmer» settled with the guest, on the phone or at the desk. */
  confirm(reference: string, language: Language): Promise<StaffActionResult>;
  /** The other tables that would take a booking for its whole stay. */
  freeTables(reference: string): Promise<FreeTablesResult>;
  /** The bookings still to come that the opening hours leave out: guests who would find the door closed. */
  outsideHours(language: Language): Promise<StaffBookingView[]>;
  /** «Fait» on a request to call back. */
  callbackDone(id: string): Promise<'done' | 'not_found'>;
  /** The restaurant's settings, as its owner keeps them. */
  config(): Promise<BusinessConfig>;
  /**
   * What the assistant said and did, and what it brought in: a live restaurant logs them, the recorded evening does
   * not, and the panel shows only the sections its restaurant can fill.
   */
  conversations?: () => Promise<Conversation[]>;
  activity?: (days: number) => Promise<Activity>;
  /** The owner's changes to the settings: a live restaurant keeps them; the recorded evening has nowhere to. */
  saveSettings?: (changes: EditableSettings, language: Language) => Promise<SettingsAnswer>;
}

export function localBackend(evening: DemoEvening): PanelBackend {
  return {
    live: false,
    read: async (date, language) => ({ day: evening.engine.serviceDay(date, language), now: evening.clock.now() }),
    arrived: async (reference, language) => evening.engine.markArrived(reference, language),
    seat: async (reference, table, language) => evening.engine.seat(reference, table, language),
    left: async (reference, language) => evening.engine.markLeft(reference, language),
    move: async (reference, table, language) => evening.engine.moveTable(reference, table, language),
    cancel: async (reference, language) => evening.engine.staffCancel(reference, language),
    noShow: async (reference, language) => evening.engine.markNoShow(reference, language),
    book: async (request) => evening.engine.staffBook(request),
    change: async (reference, change) => evening.engine.staffChange(reference, change),
    confirm: async (reference, language) => evening.engine.staffConfirm(reference, language),
    freeTables: async (reference) => evening.engine.freeTablesFor(reference),
    outsideHours: async (language) => evening.engine.bookingsOutsideHours(language),
    callbackDone: async (id) => evening.engine.completeCallback(id).status,
    config: async () => evening.engine.config,
  };
}

export function liveBackend(sandbox: string, time: RestaurantTime): PanelBackend {
  // The restaurant's clock is the real one: kept as its distance from the browser's, every read tells the time
  // without asking the restaurant for it again.
  const offset = Date.parse(time.clock) - Date.now();
  return {
    live: true,
    read: async (date, language) => ({ day: await readDay(sandbox, date, language), now: new Date(Date.now() + offset) }),
    arrived: async (reference, language) => (await staffAction(sandbox, reference, 'arrived', language)) as StaffActionResult,
    seat: async (reference, table, language) => staffAction(sandbox, reference, 'seated', language, table),
    left: async (reference, language) => (await staffAction(sandbox, reference, 'left', language)) as StaffActionResult,
    move: (reference, table, language) => staffAction(sandbox, reference, 'table', language, table),
    cancel: async (reference, language) => (await staffAction(sandbox, reference, 'cancel', language)) as StaffActionResult,
    noShow: async (reference, language) => (await staffAction(sandbox, reference, 'no-show', language)) as StaffActionResult,
    book: (request) => staffBook(sandbox, request),
    change: (reference, change) => staffChange(sandbox, reference, change),
    confirm: async (reference, language) => (await staffAction(sandbox, reference, 'confirm', language)) as StaffActionResult,
    freeTables: (reference) => freeTablesOf(sandbox, reference),
    outsideHours: (language) => readOutsideHours(sandbox, language),
    callbackDone: (id) => completeCallback(sandbox, id),
    config: () => readConfig(sandbox),
    conversations: async () => {
      const [turns, calls] = await Promise.all([readTurns(sandbox, TURNS), readCalls(sandbox, CALLS)]);
      return conversationsOf(turns, calls);
    },
    activity: (days) => readActivity(sandbox, days),
    saveSettings: (changes, language) => saveConfig(sandbox, changes, language),
  };
}
