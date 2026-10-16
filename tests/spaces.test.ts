import { describe, expect, it } from 'vitest';
import { isWhitespace, spaceBefore } from '../src/agent/spaces.js';

/** Mulberry32: a small seeded generator, so a failing text can be replayed exactly. */
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

describe('spaces before a mark', () => {
  it('replaces the spaces before a mark and keeps the others', () => {
    expect(spaceBefore('Oui , merci  !', isWhitespace, ',!', '')).toBe('Oui, merci!');
    expect(spaceBefore('Parfait !', (char) => char === ' ', '!', ' ')).toBe('Parfait !');
    expect(spaceBefore('  à vendredi  ', isWhitespace, '!', '')).toBe('  à vendredi  ');
  });

  it('does what the regular expression it replaces does', () => {
    const next = random(20261016);
    const alphabet = [' ', ' ', ' ', ' ', '\t', '\n', 'a', 'é', '.', ',', '!', '?', ':', '"', '…', '🙂'];
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: Math.floor(next() * 30) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      expect(spaceBefore(text, isWhitespace, '.,!?;:…', '')).toBe(text.replace(/\s+([.,!?;:…])/g, '$1'));
    }
  });

  it('reads a long run of spaces with no mark after it once', () => {
    const text = `${' '.repeat(200_000)}a`;
    expect(spaceBefore(text, isWhitespace, '.', '')).toBe(text);
  });
});
