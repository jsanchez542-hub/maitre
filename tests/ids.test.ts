import { describe, expect, it } from 'vitest';
import { isReference, randomIds, REFERENCE_ALPHABET } from '../src/ids.js';

describe('booking references', () => {
  it('uses only characters that cannot be mistaken for others', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L', '2', 'Z', '5', 'S', '6', 'G', '8', 'B']) {
      expect(REFERENCE_ALPHABET).not.toContain(confusable);
    }
  });

  it('draws six of them, and a fresh id each time', () => {
    const references = Array.from({ length: 200 }, () => randomIds.reference());
    for (const reference of references) expect(isReference(reference)).toBe(true);
    expect(new Set(references).size).toBeGreaterThan(195);
    expect(randomIds.id()).not.toBe(randomIds.id());
  });
});
