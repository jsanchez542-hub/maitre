import { describe, expect, it } from 'vitest';
import { peakUse, pickTableGroup, stayMinutes, suitableGroups } from '../src/availability.js';
import { TEST_CONFIG } from './fixtures.js';

describe('table use', () => {
  it('counts tables in use at the same moment, not overlapping stays', () => {
    const sequential = [
      { tableGroup: 't2', start: 1140, end: 1230 },
      { tableGroup: 't2', start: 1230, end: 1320 },
    ];
    // Both overlap 19:30 to 21:30, yet one table is enough for them.
    expect(peakUse(sequential, 't2', 1170, 1290)).toBe(1);
    const together = [...sequential, { tableGroup: 't2', start: 1200, end: 1290 }];
    expect(peakUse(together, 't2', 1170, 1290)).toBe(2);
    expect(peakUse(together, 't4', 1170, 1290)).toBe(0);
  });

  it('picks the smallest suitable table that is free', () => {
    expect(suitableGroups(TEST_CONFIG, 1).map((group) => group.id)).toEqual(['t2']);
    expect(suitableGroups(TEST_CONFIG, 3).map((group) => group.id)).toEqual(['t4']);
    expect(suitableGroups(TEST_CONFIG, 4).map((group) => group.id)).toEqual(['t4', 't6']);
    const fullT4 = [
      { tableGroup: 't4', start: 1200, end: 1320 },
      { tableGroup: 't4', start: 1200, end: 1320 },
    ];
    expect(pickTableGroup(TEST_CONFIG, 4, 1200, fullT4)?.id).toBe('t6');
    expect(pickTableGroup(TEST_CONFIG, 3, 1200, fullT4)).toBeUndefined();
  });

  it('knows how long each party stays', () => {
    expect(stayMinutes(TEST_CONFIG, 2)).toBe(90);
    expect(stayMinutes(TEST_CONFIG, 3)).toBe(120);
    expect(stayMinutes(TEST_CONFIG, 6)).toBe(150);
    expect(() => stayMinutes(TEST_CONFIG, 7)).toThrow(RangeError);
  });
});
