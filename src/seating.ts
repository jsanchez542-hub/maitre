import type { BusinessConfig } from './config.js';

/**
 * Real tables, and which party sits at which.
 *
 * Capacity is decided by table group (see availability.ts): a group with six
 * tables can take six parties at once, and that count is exact. This module
 * comes after it and gives every booking a real table, so the staff can see
 * the floor. It never changes whether a party can be booked, except in the one
 * case capacity cannot see: tables the staff have fixed by hand.
 */

/** A table as the plan shows it: drawn by the restaurant, or numbered by the engine when there is no plan. */
export interface PhysicalTable {
  number: string;
  group: string;
  seats: number;
}

/** "2" before "10", the way people read table numbers. */
export function compareTableNumbers(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function physicalTables(config: BusinessConfig): PhysicalTable[] {
  const seats = new Map(config.tables.map((group) => [group.id, group.seats]));
  const tables = config.floor
    ? config.floor.tables.map((table) => ({ number: table.number, group: table.group, seats: seats.get(table.group) ?? 0 }))
    : config.tables.flatMap((group) =>
        Array.from({ length: group.count }, (_, index) => ({ number: `${group.id}-${index + 1}`, group: group.id, seats: group.seats })),
      );
  return tables.sort((a, b) => compareTableNumbers(a.number, b.number));
}

/** A stay to put on a table, in minutes on the clock of the day being planned. */
export interface Stay {
  id: string;
  start: number;
  end: number;
  /** Where it is now, if anywhere. */
  table?: string;
  /** Seated, or placed by the staff: it never moves. */
  fixed: boolean;
  /** Breaks ties between stays that start together: the older booking goes first. */
  order: string;
}

const SEARCH_LIMIT = 50_000;

function overlaps(a: Stay, b: Stay): boolean {
  return a.start < b.end && b.start < a.end;
}

function byStart(a: Stay, b: Stay): number {
  return a.start - b.start || a.order.localeCompare(b.order) || a.id.localeCompare(b.id);
}

class Floor {
  readonly #tables: readonly string[];
  readonly #onTable = new Map<string, Stay[]>();
  readonly placed = new Map<string, string>();

  constructor(tables: readonly string[]) {
    this.#tables = tables;
    for (const table of tables) this.#onTable.set(table, []);
  }

  fits(stay: Stay, table: string): boolean {
    const there = this.#onTable.get(table);
    return there !== undefined && there.every((other) => !overlaps(stay, other));
  }

  put(stay: Stay, table: string): void {
    this.#onTable.get(table)?.push(stay);
    this.placed.set(stay.id, table);
  }

  remove(stay: Stay): void {
    const table = this.placed.get(stay.id);
    if (table === undefined) return;
    const there = this.#onTable.get(table) ?? [];
    there.splice(there.indexOf(stay), 1);
    this.placed.delete(stay.id);
  }

  firstFree(stay: Stay): string | undefined {
    return this.#tables.find((table) => this.fits(stay, table));
  }
}

function withFixed(stays: readonly Stay[], tables: readonly string[]): Floor | undefined {
  const floor = new Floor(tables);
  for (const stay of stays) {
    if (!stay.fixed) continue;
    if (stay.table === undefined || !floor.fits(stay, stay.table)) return undefined;
    floor.put(stay, stay.table);
  }
  return floor;
}

/**
 * Puts every stay of one table group on one of `tables` (ordered, lowest
 * number first), so that no two stays share a table at the same moment.
 *
 * Fixed stays keep their tables. The others keep theirs when they still fit,
 * so the plan the staff see changes as little as possible, and the rest take
 * the lowest-numbered table free for their whole stay. If that leaves a stay
 * without a table, the stays that are not fixed are placed again from scratch
 * in order of arrival. With nothing fixed this always works when capacity
 * allowed the bookings: intervals placed by start time never need more tables
 * than the most stays at one moment. Fixed stays can break that, so a short
 * search then tries the other arrangements.
 *
 * Returns the table of every stay, or undefined when no arrangement exists.
 */
export function planGroup(stays: readonly Stay[], tables: readonly string[]): Map<string, string> | undefined {
  const loose = stays.filter((stay) => !stay.fixed).sort(byStart);

  const kept = withFixed(stays, tables);
  if (!kept) return undefined;
  const waiting: Stay[] = [];
  for (const stay of loose) {
    if (stay.table !== undefined && kept.fits(stay, stay.table)) kept.put(stay, stay.table);
    else waiting.push(stay);
  }
  if (waiting.every((stay) => placeFirstFree(kept, stay))) return kept.placed;

  const fresh = withFixed(stays, tables);
  if (fresh && loose.every((stay) => placeFirstFree(fresh, stay))) return fresh.placed;

  return search(stays, loose, tables);
}

function placeFirstFree(floor: Floor, stay: Stay): boolean {
  const table = floor.firstFree(stay);
  if (table === undefined) return false;
  floor.put(stay, table);
  return true;
}

function search(stays: readonly Stay[], loose: readonly Stay[], tables: readonly string[]): Map<string, string> | undefined {
  const floor = withFixed(stays, tables);
  if (!floor) return undefined;
  let steps = 0;
  const place = (index: number): boolean => {
    const stay = loose[index];
    if (!stay) return true;
    for (const table of tables) {
      steps += 1;
      if (steps > SEARCH_LIMIT) return false;
      if (!floor.fits(stay, table)) continue;
      floor.put(stay, table);
      if (place(index + 1)) return true;
      floor.remove(stay);
    }
    return false;
  };
  return place(0) ? floor.placed : undefined;
}
