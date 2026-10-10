import { describe, expect, it } from 'vitest';
import { isOnGrid, sittingAt, slotsOn } from '../src/schedule.js';
import { TEST_CONFIG } from './fixtures.js';

describe('schedule', () => {
  it('lists the bookable times of a day in order', () => {
    expect(slotsOn(TEST_CONFIG, '2026-10-18')).toEqual(['12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30', '13:45', '14:00']);
    expect(slotsOn(TEST_CONFIG, '2026-10-19')).toEqual([]);
  });

  it('follows an exception over the weekly schedule', () => {
    expect(slotsOn(TEST_CONFIG, '2026-12-25')).toEqual([]);
    expect(slotsOn(TEST_CONFIG, '2027-01-01')).toEqual(['00:30', '00:45', '01:00']);
  });

  it('finds the sitting of a time and checks the grid', () => {
    const sitting = sittingAt(TEST_CONFIG, '2026-10-16', '20:10');
    expect(sitting?.service).toBe('dinner');
    expect(sitting && isOnGrid(sitting, '20:10', 15)).toBe(false);
    expect(sitting && isOnGrid(sitting, '20:15', 15)).toBe(true);
    expect(sittingAt(TEST_CONFIG, '2026-10-16', '16:00')).toBeUndefined();
  });
});
