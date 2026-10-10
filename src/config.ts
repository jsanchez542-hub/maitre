import { ALLERGENS, isAllergenStatus, type Dish } from './allergens.js';
import { assertTimeZone, isPlainDate, isPlainTime, toMinutes, type PlainDate, type PlainTime, type Weekday } from './calendar.js';
import { LANGUAGES, isLanguage, type Language, type LocalizedText } from './i18n/index.js';
import { physicalTables } from './seating.js';

export interface ServiceDefinition {
  /** Stable id used in data, such as "lunch" or "dinner". */
  id: string;
  name: LocalizedText;
}

/** One service on one day: the first and the last time a table can be booked. */
export interface Sitting {
  service: string;
  firstSeating: PlainTime;
  lastSeating: PlainTime;
}

/** A day that does not follow the weekly schedule. No sittings means closed. */
export interface ScheduleException {
  date: PlainDate;
  sittings: readonly Sitting[];
  reason?: LocalizedText;
}

/** Tables of the same size, counted together: "six tables for two". */
export interface TableGroup {
  id: string;
  seats: number;
  count: number;
}

export type TableShape = 'round' | 'square' | 'rect';

/** A part of the room, such as the terrace. */
export interface FloorZone {
  id: string;
  name: LocalizedText;
}

/** One real table, where the staff see it on the plan. */
export interface FloorTable {
  /** What the staff call it: "12". */
  number: string;
  /** The table group it counts in. Each group has as many tables on the plan as its count. */
  group: string;
  shape: TableShape;
  /** A rectangle lies across the plan (0, the default) or along it (90). */
  rotation?: 0 | 90;
  /** Where its centre is on the plan, from 0 to 100 across and down. */
  x: number;
  y: number;
  zone?: string;
}

export interface FloorPlan {
  zones?: readonly FloorZone[];
  tables: readonly FloorTable[];
}

/** Someone who serves on the floor and the tables they look after. Only the name the plan shows. */
export interface Waiter {
  id: string;
  name: string;
  tables: readonly string[];
  /** The services they work; all of them when absent. */
  services?: readonly string[];
}

/** How long a party keeps its table, by size: up to 2 guests for 90 minutes, and so on. */
export interface StayRule {
  upToPartySize: number;
  minutes: number;
}

export interface FaqEntry {
  id: string;
  question: LocalizedText;
  answer: LocalizedText;
}

export interface BusinessConfig {
  id: string;
  name: string;
  /** IANA time zone, such as Europe/Paris. Every date and time of the business is read in it. */
  timeZone: string;
  languages: readonly Language[];
  defaultLanguage: Language;
  services: readonly ServiceDefinition[];
  /** 1 is Monday. An empty list means closed that day. */
  weekly: Readonly<Record<Weekday, readonly Sitting[]>>;
  exceptions: readonly ScheduleException[];
  /** Bookable times are every this many minutes from a service's first seating. */
  slotMinutes: number;
  tables: readonly TableGroup[];
  /** The real tables and where they stand. Without it, the engine numbers the tables of each group itself. */
  floor?: FloorPlan;
  waiters?: readonly Waiter[];
  /** A party never gets a table with more empty seats than this: two guests do not take a table for six. */
  maxEmptySeats: number;
  stays: readonly StayRule[];
  /** How long before a booking it can still be made online. */
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  /** How long a table offered to a guest stays set aside for them. */
  holdMinutes: number;
  /** Larger parties are passed to a person: joining tables is a decision for the floor, not for code. */
  maxPartySize: number;
  menu: readonly Dish[];
  faq: readonly FaqEntry[];
}

const ALLOWED_SLOT_MINUTES = [5, 10, 15, 20, 30, 60];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isWholeNumber(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function checkLocalized(text: LocalizedText | undefined, where: string, problems: string[]): void {
  if (text === undefined) return;
  for (const language of LANGUAGES) {
    const value = Object.hasOwn(text, language) ? text[language] : undefined;
    if (typeof value !== 'string' || value.trim() === '') problems.push(`${where} has no ${language} text`);
  }
}

function checkUniqueIds(items: readonly { id: string }[], where: string, problems: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!ID_PATTERN.test(item.id)) problems.push(`${where} id "${item.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(item.id)) problems.push(`${where} id "${item.id}" is used twice`);
    seen.add(item.id);
  }
}

function checkSittings(
  sittings: readonly Sitting[],
  where: string,
  serviceIds: ReadonlySet<string>,
  slotMinutes: number,
  problems: string[],
): void {
  const ranges: [number, number][] = [];
  for (const sitting of sittings) {
    if (!serviceIds.has(sitting.service)) problems.push(`${where}: unknown service "${sitting.service}"`);
    if (!isPlainTime(sitting.firstSeating) || !isPlainTime(sitting.lastSeating)) {
      problems.push(`${where}: times must be written HH:mm`);
      continue;
    }
    const first = toMinutes(sitting.firstSeating);
    const last = toMinutes(sitting.lastSeating);
    if (last < first) problems.push(`${where}: last seating ${sitting.lastSeating} is before the first ${sitting.firstSeating}`);
    if ((last - first) % slotMinutes !== 0) {
      problems.push(`${where}: last seating ${sitting.lastSeating} is not on the ${slotMinutes}-minute grid that starts at ${sitting.firstSeating}`);
    }
    ranges.push([first, last]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && current[0] <= previous[1]) problems.push(`${where}: two sittings overlap`);
  }
}

const TABLE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,7}$/;

function checkFloor(config: BusinessConfig, problems: string[]): void {
  if (!config.floor) return;
  const zones = config.floor.zones ?? [];
  checkUniqueIds(zones, 'zone', problems);
  for (const zone of zones) checkLocalized(zone.name, `zone "${zone.id}"`, problems);
  const zoneIds = new Set(zones.map((zone) => zone.id));

  const numbers = new Set<string>();
  const drawn = new Map<string, number>();
  for (const table of config.floor.tables) {
    if (!TABLE_NUMBER.test(table.number)) problems.push(`table number "${table.number}" must be 1 to 8 letters, digits or dashes`);
    if (numbers.has(table.number.toLowerCase())) problems.push(`table number "${table.number}" is used twice`);
    numbers.add(table.number.toLowerCase());
    if (!config.tables.some((group) => group.id === table.group)) problems.push(`table ${table.number}: unknown table group "${table.group}"`);
    drawn.set(table.group, (drawn.get(table.group) ?? 0) + 1);
    if (table.shape !== 'round' && table.shape !== 'square' && table.shape !== 'rect') {
      problems.push(`table ${table.number}: shape must be round, square or rect`);
    }
    if (table.rotation !== undefined && table.rotation !== 0 && table.rotation !== 90) problems.push(`table ${table.number}: rotation must be 0 or 90`);
    for (const [axis, value] of [
      ['x', table.x],
      ['y', table.y],
    ] as const) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        problems.push(`table ${table.number}: ${axis} must be a number from 0 to 100`);
      }
    }
    if (table.zone !== undefined && !zoneIds.has(table.zone)) problems.push(`table ${table.number}: unknown zone "${table.zone}"`);
  }
  for (const group of config.tables) {
    const count = drawn.get(group.id) ?? 0;
    if (count !== group.count) problems.push(`table group "${group.id}" counts ${group.count} tables but the plan has ${count}`);
  }
}

function checkWaiters(config: BusinessConfig, serviceIds: ReadonlySet<string>, problems: string[]): void {
  const waiters = config.waiters ?? [];
  checkUniqueIds(waiters, 'waiter', problems);
  const tableNumbers = new Set(physicalTables(config).map((table) => table.number));
  const sections = new Map<string, string>();
  for (const waiter of waiters) {
    if (typeof waiter.name !== 'string' || waiter.name.trim() === '' || waiter.name.length > 40 || /[\u0000-\u001f\u007f]/.test(waiter.name)) {
      problems.push(`waiter "${waiter.id}" needs a name of 1 to 40 characters`);
    }
    for (const service of waiter.services ?? []) {
      if (!serviceIds.has(service)) problems.push(`waiter "${waiter.id}": unknown service "${service}"`);
    }
    for (const table of waiter.tables) {
      if (!tableNumbers.has(table)) problems.push(`waiter "${waiter.id}": unknown table "${table}"`);
      for (const service of waiter.services ?? [...serviceIds]) {
        const key = `${service} ${table}`;
        const other = sections.get(key);
        if (other) problems.push(`table ${table} is in the sections of both "${other}" and "${waiter.id}" at ${service}`);
        sections.set(key, waiter.id);
      }
    }
  }
}

/** Every problem in a configuration, in plain words. An empty list means it is safe to run. */
export function validateConfig(config: BusinessConfig): string[] {
  const problems: string[] = [];

  if (!ID_PATTERN.test(config.id)) problems.push('id must be lowercase letters, digits and dashes');
  if (config.name.trim() === '') problems.push('name is empty');
  try {
    assertTimeZone(config.timeZone);
  } catch {
    problems.push(`unknown time zone "${config.timeZone}"`);
  }

  if (config.languages.length === 0) problems.push('at least one language is needed');
  for (const language of config.languages) {
    if (!isLanguage(language)) problems.push(`unsupported language "${String(language)}"`);
  }
  if (!config.languages.includes(config.defaultLanguage)) problems.push('the default language is not among the languages');

  if (!ALLOWED_SLOT_MINUTES.includes(config.slotMinutes)) {
    problems.push(`slotMinutes must be one of ${ALLOWED_SLOT_MINUTES.join(', ')}`);
  }

  checkUniqueIds(config.services, 'service', problems);
  for (const service of config.services) checkLocalized(service.name, `service "${service.id}"`, problems);
  const serviceIds = new Set(config.services.map((service) => service.id));
  const slotMinutes = ALLOWED_SLOT_MINUTES.includes(config.slotMinutes) ? config.slotMinutes : 15;

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const sittings = config.weekly[weekday as Weekday];
    if (!Array.isArray(sittings)) {
      problems.push(`weekday ${weekday} has no schedule (use an empty list for closed)`);
      continue;
    }
    checkSittings(sittings, `weekday ${weekday}`, serviceIds, slotMinutes, problems);
  }

  const exceptionDates = new Set<string>();
  for (const exception of config.exceptions) {
    if (!isPlainDate(exception.date)) problems.push(`exception date "${exception.date}" is not a calendar date`);
    if (exceptionDates.has(exception.date)) problems.push(`exception date ${exception.date} appears twice`);
    exceptionDates.add(exception.date);
    checkSittings(exception.sittings, `exception ${exception.date}`, serviceIds, slotMinutes, problems);
    checkLocalized(exception.reason, `exception ${exception.date}`, problems);
  }

  if (config.tables.length === 0) problems.push('at least one table group is needed');
  checkUniqueIds(config.tables, 'table group', problems);
  for (const group of config.tables) {
    if (!isWholeNumber(group.seats, 1, 30)) problems.push(`table group "${group.id}" needs 1 to 30 seats`);
    if (!isWholeNumber(group.count, 1, 200)) problems.push(`table group "${group.id}" needs a count from 1 to 200`);
  }
  if (!isWholeNumber(config.maxEmptySeats, 0, 30)) problems.push('maxEmptySeats must be a whole number from 0 to 30');
  checkFloor(config, problems);
  checkWaiters(config, serviceIds, problems);

  if (!isWholeNumber(config.maxPartySize, 1, 30)) problems.push('maxPartySize must be a whole number from 1 to 30');
  for (let size = 1; size <= config.maxPartySize && size <= 30; size += 1) {
    const fits = config.tables.some((group) => group.seats >= size && group.seats - size <= config.maxEmptySeats);
    if (!fits) problems.push(`no table group suits a party of ${size}`);
  }

  if (config.stays.length === 0) problems.push('at least one stay rule is needed');
  let previousSize = 0;
  for (const rule of config.stays) {
    if (!isWholeNumber(rule.upToPartySize, 1, 30) || rule.upToPartySize <= previousSize) {
      problems.push('stay rules must be ordered by party size, each larger than the one before');
    }
    if (!isWholeNumber(rule.minutes, 15, 480)) problems.push('a stay lasts between 15 and 480 minutes');
    previousSize = rule.upToPartySize;
  }
  if (previousSize < config.maxPartySize) problems.push(`no stay rule covers parties of ${config.maxPartySize}`);

  if (!isWholeNumber(config.minNoticeMinutes, 0, 10_080)) problems.push('minNoticeMinutes must be from 0 to 10080');
  if (!isWholeNumber(config.maxAdvanceDays, 1, 730)) problems.push('maxAdvanceDays must be from 1 to 730');
  if (!isWholeNumber(config.holdMinutes, 1, 30)) problems.push('holdMinutes must be from 1 to 30');

  checkUniqueIds(config.menu, 'dish', problems);
  for (const dish of config.menu) {
    checkLocalized(dish.name, `dish "${dish.id}"`, problems);
    checkLocalized(dish.description, `dish "${dish.id}" description`, problems);
    if (dish.priceCents !== undefined && !isWholeNumber(dish.priceCents, 0, 1_000_000)) {
      problems.push(`dish "${dish.id}" price must be a whole number of cents`);
    }
    for (const [allergen, status] of Object.entries(dish.allergens)) {
      if (!(ALLERGENS as readonly string[]).includes(allergen)) problems.push(`dish "${dish.id}": unknown allergen "${allergen}"`);
      if (!isAllergenStatus(status)) problems.push(`dish "${dish.id}": "${allergen}" must be contains, may_contain or free`);
    }
  }

  checkUniqueIds(config.faq, 'faq entry', problems);
  for (const entry of config.faq) {
    checkLocalized(entry.question, `faq "${entry.id}" question`, problems);
    checkLocalized(entry.answer, `faq "${entry.id}" answer`, problems);
  }

  return problems;
}

/** Throws with every problem listed, so a bad configuration stops the service at startup. */
export function assertValidConfig(config: BusinessConfig): void {
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`Invalid configuration for "${config.id}":\n- ${problems.join('\n- ')}`);
}
