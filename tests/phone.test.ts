import { describe, expect, it } from 'vitest';
import { formatPhone, isE164, normalizePhone } from '../src/phone.js';

describe('phone numbers', () => {
  it('reads French numbers however they are written', () => {
    for (const written of ['06 12 34 56 78', '06.12.34.56.78', '0612345678', '+33 6 12 34 56 78', '+33 (0)6 12 34 56 78', '0033612345678']) {
      expect(normalizePhone(written), written).toBe('+33612345678');
    }
  });

  it('keeps international numbers', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('+262 692 12 34 56')).toBe('+262692123456');
  });

  it('refuses what it cannot read with certainty', () => {
    for (const written of ['', '612345678', '+33 6 12 34 56', '06 12 34 56 7a', '+0612345678', '1'.repeat(40), '+33 6 12 34 56 78 90']) {
      expect(normalizePhone(written), written).toBeUndefined();
    }
  });

  it('formats numbers the way people write them where they come from, and validates E.164', () => {
    expect(formatPhone('+33612345678')).toBe('+33 6 12 34 56 78');
    expect(formatPhone('+447700900123')).toBe('+44 7700 900123');
    expect(formatPhone('+34600000103')).toBe('+34 600 000 103');
    // A British landline, or a country the code does not know, stays in E.164.
    expect(formatPhone('+442079460958')).toBe('+442079460958');
    expect(formatPhone('+12025550123')).toBe('+12025550123');
    expect(isE164('+33612345678')).toBe(true);
    expect(isE164('0612345678')).toBe(false);
  });
});
