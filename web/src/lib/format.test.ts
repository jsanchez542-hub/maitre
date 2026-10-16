import { describe, expect, it } from 'vitest';
import { dollarsOf, secondsOf } from './format';
import { NNBSP } from './typography';

describe('numbers on the panel', () => {
  it('says a time to the tenth of a second, the unit kept with its figure', () => {
    expect(secondsOf(2400, 'fr')).toBe(`2,4${NNBSP}s`);
    expect(secondsOf(940, 'en')).toBe(`0.9${NNBSP}s`);
    expect(secondsOf(12_000, 'es')).toBe(`12,0${NNBSP}s`);
  });

  it('says a turn’s cost in dollars, to the hundredth of a cent, as each language writes money', () => {
    expect(dollarsOf(0.0011, 'en')).toBe('$0.0011');
    expect(dollarsOf(0.0011, 'fr')).toMatch(/^0,0011[\u202F\u00A0]\$$/);
    expect(dollarsOf(0.0011, 'es')).toMatch(/^0,0011[\u202F\u00A0]\$$/);
  });
});
