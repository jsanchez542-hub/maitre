import { describe, expect, it } from 'vitest';
import { daysBetween, toMinutes } from '../src/calendar.js';
import type { BookingEngine, Session } from '../src/engine.js';
import { slotsOn } from '../src/schedule.js';
import { isActive, type MemoryStore } from '../src/store.js';
import { TEST_CONFIG, guest, harness } from './fixtures.js';

/** Mulberry32: a small seeded generator, so a failing sequence can be replayed exactly. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const DAYS = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-20'];
const ORIGIN = '2026-10-14';

/**
 * Written without the engine's own code: every booking and live hold becomes an
 * interval in absolute minutes, and at the start of each interval no table group
 * may be in use more times than it has tables.
 */
function capacityViolations(store: MemoryStore, nowMs: number): string[] {
  const { bookings, holds } = store.snapshot();
  const intervals = [
    ...bookings.filter(isActive).map((b) => ({ ...b, kind: 'booking' })),
    ...holds.filter((h) => h.expiresAt > nowMs).map((h) => ({ ...h, kind: 'hold' })),
  ].map((item) => {
    const start = daysBetween(ORIGIN, item.date) * 1440 + toMinutes(item.time);
    return { group: item.tableGroup, start, end: start + item.stayMinutes, label: `${item.kind} ${item.date} ${item.time}` };
  });
  const violations: string[] = [];
  for (const table of TEST_CONFIG.tables) {
    const ofGroup = intervals.filter((interval) => interval.group === table.id);
    for (const moment of ofGroup) {
      const inUse = ofGroup.filter((other) => other.start <= moment.start && moment.start < other.end).length;
      if (inUse > table.count) violations.push(`${table.id}: ${inUse} in use at ${moment.label}, only ${table.count} tables`);
    }
  }
  return violations;
}

function run(seed: number, steps: number): { violations: string[]; booked: number } {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const h = harness();
  const engine: BookingEngine = h.engine;
  const sessions: Session[] = Array.from({ length: 6 }, (_, index) => guest(`s${index}`, `+3361234567${index}`));
  const heldBy = new Map<string, string>();
  const references = new Map<string, string[]>();
  const violations: string[] = [];
  let now = new Date('2026-10-14T08:00:00Z').getTime();

  for (let step = 0; step < steps && violations.length === 0; step += 1) {
    const session = pick(sessions);
    const action = next();
    if (action < 0.45) {
      const date = pick(DAYS);
      const result = engine.findTable(session, {
        date: { kind: 'date', date },
        time: pick(slotsOn(TEST_CONFIG, date)),
        partySize: 1 + Math.floor(next() * 6),
      });
      if (result.status === 'available') heldBy.set(session.id, result.holdId);
    } else if (action < 0.75) {
      const holdId = heldBy.get(session.id);
      if (holdId) {
        const result = engine.book(session, { holdId, guestName: `Guest ${session.id}` });
        if (result.status === 'booked') references.set(session.id, [...(references.get(session.id) ?? []), result.booking.reference]);
      }
    } else if (action < 0.85) {
      const mine = references.get(session.id) ?? [];
      if (mine.length > 0) engine.cancel(session, { reference: pick(mine) });
    } else if (action < 0.92) {
      const mine = references.get(session.id) ?? [];
      const date = pick(DAYS);
      if (mine.length > 0) {
        const reference = pick(mine);
        const found = engine.findTable(session, {
          date: { kind: 'date', date },
          time: pick(slotsOn(TEST_CONFIG, date)),
          partySize: 1 + Math.floor(next() * 6),
          changing: reference,
        });
        if (found.status === 'available') engine.change(session, { reference, holdId: found.holdId });
      }
    } else {
      const minutes = Math.floor(next() * 4);
      h.advanceMinutes(minutes);
      now += minutes * 60_000;
    }
    violations.push(...capacityViolations(h.store, now).map((violation) => `seed ${seed}, step ${step}: ${violation}`));
  }
  return { violations, booked: h.store.snapshot().bookings.filter(isActive).length };
}

describe('capacity under random traffic', () => {
  it('never puts more parties on a table group than it has tables', () => {
    let booked = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = run(seed, 300);
      expect(result.violations).toEqual([]);
      booked += result.booked;
    }
    // Guard against a test that passes because nothing was ever booked.
    expect(booked).toBeGreaterThan(400);
  });

  it('never gives two bookings the same reference', () => {
    const h = harness();
    for (let index = 0; index < 30; index += 1) {
      const session = guest(`r${index}`, `+336123456${String(index).padStart(2, '0')}`);
      const date = DAYS[index % DAYS.length] as string;
      const found = h.engine.findTable(session, { date: { kind: 'date', date }, time: '12:00', partySize: 1 });
      if (found.status === 'available') h.engine.book(session, { holdId: found.holdId, guestName: 'Test' });
    }
    const references = h.store.snapshot().bookings.map((booking) => booking.reference);
    expect(new Set(references).size).toBe(references.length);
  });
});
