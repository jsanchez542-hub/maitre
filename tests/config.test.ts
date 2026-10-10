import { describe, expect, it } from 'vitest';
import { assertValidConfig, validateConfig, type BusinessConfig } from '../src/config.js';
import { TEST_CONFIG } from './fixtures.js';

const broken = (change: Partial<BusinessConfig>): string[] => validateConfig({ ...TEST_CONFIG, ...change });

describe('configuration', () => {
  it('accepts the test bistro', () => {
    expect(validateConfig(TEST_CONFIG)).toEqual([]);
    expect(() => assertValidConfig(TEST_CONFIG)).not.toThrow();
  });

  it('catches the mistakes that would break a service', () => {
    expect(broken({ timeZone: 'Europe/Bordeaux' })).toContain('unknown time zone "Europe/Bordeaux"');
    expect(broken({ slotMinutes: 7 })).toContain('slotMinutes must be one of 5, 10, 15, 20, 30, 60');
    expect(broken({ defaultLanguage: 'es', languages: ['fr', 'en'] })).toContain('the default language is not among the languages');
    expect(broken({ maxPartySize: 8 })).toContain('no table group suits a party of 7');
    expect(broken({ tables: [{ id: 't6', seats: 6, count: 1 }] })).toContain('no table group suits a party of 1');
    expect(broken({ stays: [{ upToPartySize: 4, minutes: 120 }] })).toContain('no stay rule covers parties of 6');
    expect(broken({ holdMinutes: 0 })).toContain('holdMinutes must be from 1 to 30');
  });

  it('catches schedules that overlap, leave the grid or name an unknown service', () => {
    const weekly = { ...TEST_CONFIG.weekly };
    weekly[2] = [
      { service: 'lunch', firstSeating: '12:00', lastSeating: '14:00' },
      { service: 'dinner', firstSeating: '13:45', lastSeating: '21:00' },
    ];
    weekly[3] = [{ service: 'brunch', firstSeating: '10:00', lastSeating: '11:10' }];
    const problems = broken({ weekly });
    expect(problems).toContain('weekday 2: two sittings overlap');
    expect(problems).toContain('weekday 3: unknown service "brunch"');
    expect(problems).toContain('weekday 3: last seating 11:10 is not on the 15-minute grid that starts at 10:00');
  });

  it('catches a menu with an unknown allergen or a missing translation', () => {
    const problems = broken({
      menu: [
        {
          id: 'mystery',
          category: 'main',
          name: { fr: 'Plat', en: '', es: 'Plato' },
          allergens: { peanut: 'contains' } as never,
        },
      ],
    });
    expect(problems).toContain('dish "mystery" has no en text');
    expect(problems).toContain('dish "mystery": unknown allergen "peanut"');
  });

  it('stops at startup with every problem listed', () => {
    expect(() => assertValidConfig({ ...TEST_CONFIG, slotMinutes: 7, holdMinutes: 0 })).toThrow(
      /slotMinutes must be one of[\s\S]*holdMinutes must be from 1 to 30/,
    );
  });
});
