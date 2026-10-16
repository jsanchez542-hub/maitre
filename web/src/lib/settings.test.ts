import { DEMO_RESTAURANT } from 'maitre/demo';
import { describe, expect, it } from 'vitest';
import { centsOf, idFor, largestParty, problemsWith, sittingsProblem, timesOfDay, usualSitting } from './settings';

describe('the settings an owner edits', () => {
  it('offers a service’s times on the restaurant’s own grid', () => {
    const quarters = timesOfDay(15);
    expect(quarters).toHaveLength(96);
    expect(quarters.slice(0, 3)).toEqual(['00:00', '00:15', '00:30']);
    expect(quarters.at(-1)).toBe('23:45');
    expect(timesOfDay(30)).toContain('20:30');
    expect(timesOfDay(30)).not.toContain('20:15');
  });

  it('opens a service on a new day at the times it keeps on the others', () => {
    expect(usualSitting(DEMO_RESTAURANT, 'dinner')).toEqual({ service: 'dinner', firstSeating: '19:00', lastSeating: '21:30' });
    expect(usualSitting({ weekly: { ...DEMO_RESTAURANT.weekly, 2: [], 3: [], 4: [], 5: [], 6: [] } }, 'dinner')).toEqual({ service: 'dinner', firstSeating: '12:00', lastSeating: '14:00' });
  });

  it('says why a day’s services cannot stand: one ending before it starts, or two overlapping', () => {
    expect(sittingsProblem([{ service: 'lunch', firstSeating: '12:00', lastSeating: '13:45' }])).toBeNull();
    expect(sittingsProblem([{ service: 'lunch', firstSeating: '14:00', lastSeating: '12:00' }])).toBe('order');
    expect(
      sittingsProblem([
        { service: 'dinner', firstSeating: '13:30', lastSeating: '21:30' },
        { service: 'lunch', firstSeating: '12:00', lastSeating: '13:45' },
      ]),
    ).toBe('overlap');
  });

  it('checks the changes as the restaurant would, and finds nothing wrong in a closed Tuesday', () => {
    expect(problemsWith(DEMO_RESTAURANT, { weekly: { ...DEMO_RESTAURANT.weekly, 2: [] } })).toEqual([]);
    expect(problemsWith(DEMO_RESTAURANT, { maxAdvanceDays: 0 })).toEqual(['maxAdvanceDays must be from 1 to 730']);
    // A list where a number belongs is not a setting at all.
    expect(problemsWith(DEMO_RESTAURANT, { maxPartySize: [] as unknown as number })).not.toEqual([]);
  });

  it('knows the largest party a table suits and a stay covers', () => {
    expect(largestParty(DEMO_RESTAURANT)).toBe(6);
    expect(largestParty({ ...DEMO_RESTAURANT, stays: [{ upToPartySize: 4, minutes: 120 }] })).toBe(4);
    // Tables of 2 and 6, and no more than two empty seats: a party of 3 has no table, so the online limit is 2.
    expect(largestParty({ tables: [{ id: 'a', seats: 2, count: 4 }, { id: 'b', seats: 6, count: 1 }], maxEmptySeats: 2, stays: DEMO_RESTAURANT.stays })).toBe(2);
  });

  it('gives a new dish an id from its name, as the engine wants ids, unique in the menu', () => {
    expect(idFor('Crème brûlée', new Set(), 'dish')).toBe('creme-brulee');
    expect(idFor('Œufs mimosa', new Set(), 'dish')).toBe('oeufs-mimosa');
    expect(idFor('Soupe à l’oignon', new Set(['soupe-a-l-oignon']), 'dish')).toBe('soupe-a-l-oignon-2');
    expect(idFor('  —  ', new Set(), 'dish')).toBe('dish');
    expect(idFor('a'.repeat(80), new Set(), 'dish')).toHaveLength(37);
  });

  it('reads a price as the owner writes it', () => {
    expect(centsOf('12')).toBe(1200);
    expect(centsOf('12,5')).toBe(1250);
    expect(centsOf('12.50')).toBe(1250);
    expect(centsOf(' ')).toBeNull();
    expect(centsOf('12.555')).toBe('unreadable');
    expect(centsOf('douze')).toBe('unreadable');
    expect(centsOf('1,2,3')).toBe('unreadable');
  });
});
