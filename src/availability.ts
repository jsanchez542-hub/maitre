import type { BusinessConfig, TableGroup } from './config.js';

/**
 * A table group taken over a stretch of time, in minutes from midnight of the
 * day being checked. A stay from the evening before that runs past midnight has
 * a negative start; one that runs into the next day ends after 1440.
 */
export interface Occupation {
  tableGroup: string;
  start: number;
  end: number;
}

/** How long a party of this size keeps its table. */
export function stayMinutes(config: BusinessConfig, partySize: number): number {
  const rule = config.stays.find((candidate) => partySize <= candidate.upToPartySize);
  if (!rule) throw new RangeError(`No stay rule for a party of ${partySize}`);
  return rule.minutes;
}

/** Table groups that suit a party, smallest first, never leaving more than `maxEmptySeats` empty. */
export function suitableGroups(config: BusinessConfig, partySize: number): TableGroup[] {
  return config.tables
    .filter((group) => group.seats >= partySize && group.seats - partySize <= config.maxEmptySeats)
    .sort((a, b) => a.seats - b.seats || a.id.localeCompare(b.id));
}

/**
 * The most tables of one group in use at the same moment within [start, end).
 *
 * Counting every overlapping stay would be wrong: a table freed at 20:00 can be
 * taken again at 20:00. Bookings are intervals, and intervals of one group fit
 * on its tables exactly when this peak stays below the number of tables, so
 * the peak is the right measure, not a cautious estimate.
 */
export function peakUse(occupations: readonly Occupation[], tableGroup: string, start: number, end: number): number {
  const events: [minute: number, change: number][] = [];
  for (const occupation of occupations) {
    if (occupation.tableGroup !== tableGroup) continue;
    if (occupation.end <= start || occupation.start >= end) continue;
    events.push([Math.max(occupation.start, start), 1], [Math.min(occupation.end, end), -1]);
  }
  // At the same minute a table is freed before it is taken: stays are [start, end).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, change] of events) {
    current += change;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** The smallest suitable table group with a table free for the whole stay, if any. */
export function pickTableGroup(
  config: BusinessConfig,
  partySize: number,
  start: number,
  occupations: readonly Occupation[],
): TableGroup | undefined {
  const end = start + stayMinutes(config, partySize);
  return suitableGroups(config, partySize).find((group) => peakUse(occupations, group.id, start, end) < group.count);
}
