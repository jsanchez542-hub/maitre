import { describe, expect, it } from 'vitest';
import { compareTableNumbers, physicalTables, planGroup, type Stay } from '../src/seating.js';
import { TEST_CONFIG } from './fixtures.js';

const stay = (id: string, start: number, end: number, extra: Partial<Stay> = {}): Stay => ({ id, start, end, fixed: false, order: id, ...extra });
const hours = (h: number): number => h * 60;

describe('real tables', () => {
  it('are numbered by the engine when the restaurant has no plan, in the order people read them', () => {
    expect(physicalTables(TEST_CONFIG).map((table) => table.number)).toEqual(['t2-1', 't2-2', 't4-1', 't4-2', 't6-1']);
    expect(['10', '2', '1', 'B', 'a'].sort(compareTableNumbers)).toEqual(['1', '2', '10', 'a', 'B']);
  });
});

describe('the plan of one table group', () => {
  it('gives each stay the lowest-numbered table free for all of it, and reuses a table the moment it is free', () => {
    const plan = planGroup([stay('x', hours(19), hours(21)), stay('y', hours(19), hours(21)), stay('z', hours(21), hours(23))], ['A', 'B']);
    expect(Object.fromEntries(plan ?? [])).toEqual({ x: 'A', y: 'B', z: 'A' });
  });

  it('leaves stays where they are when they still fit, so the plan the staff see moves as little as possible', () => {
    const plan = planGroup([stay('x', hours(19), hours(21), { table: 'B' }), stay('y', hours(20), hours(22))], ['A', 'B']);
    expect(Object.fromEntries(plan ?? [])).toEqual({ x: 'B', y: 'A' });
  });

  it('moves stays that are not fixed when a new one only fits that way', () => {
    // x sits at A until 20:00 and z at B from 21:00: y, from 19:30 to 21:30, needs z to move to A.
    const stays = [stay('x', hours(18), hours(20), { table: 'A' }), stay('z', hours(21), hours(23), { table: 'B' }), stay('y', 1170, 1290)];
    expect(Object.fromEntries(planGroup(stays, ['A', 'B']) ?? [])).toEqual({ x: 'A', y: 'B', z: 'A' });
  });

  it('never moves a fixed stay, and says when nothing fits around them', () => {
    const fixed = [stay('x', hours(18), hours(20), { table: 'A', fixed: true }), stay('z', hours(21), hours(23), { table: 'B', fixed: true })];
    expect(planGroup([...fixed, stay('y', 1170, 1290)], ['A', 'B'])).toBeUndefined();
    expect(planGroup([...fixed, stay('y', hours(20), hours(21))], ['A', 'B'])?.get('y')).toBe('A');
  });

  it('finds the arrangement that taking the lowest free table misses', () => {
    // p would take A, and q, longer, would find B blocked by f from 19:00. Putting p at B before f leaves A to q.
    const stays = [stay('f', hours(19), hours(20), { table: 'B', fixed: true }), stay('p', hours(18), hours(19)), stay('q', hours(18), hours(22))];
    expect(Object.fromEntries(planGroup(stays, ['A', 'B']) ?? [])).toEqual({ f: 'B', p: 'B', q: 'A' });
  });

  it('refuses fixed stays that overlap on one table', () => {
    const clash = [stay('x', hours(19), hours(21), { table: 'A', fixed: true }), stay('y', hours(20), hours(22), { table: 'A', fixed: true })];
    expect(planGroup(clash, ['A', 'B'])).toBeUndefined();
  });
});
