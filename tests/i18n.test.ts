import { describe, expect, it } from 'vitest';
import { ALLERGENS } from '../src/allergens.js';
import { LANGUAGES, formatBooking, formatDate, formatDateAtTime, formatTime, messages } from '../src/i18n/index.js';
import type { Language } from '../src/i18n/index.js';

const TODAY = '2026-10-14';
const NBSP = ' ';
const THIN = ' ';

describe('dates in words', () => {
  it('says the weekday, the day and the month', () => {
    expect(formatDate('2026-10-16', 'fr', TODAY)).toBe('vendredi 16 octobre');
    expect(formatDate('2026-10-16', 'en', TODAY)).toBe('Friday 16 October');
    expect(formatDate('2026-10-16', 'es', TODAY)).toBe('viernes 16 de octubre');
  });

  it('writes the first of the month as "1er" in French', () => {
    expect(formatDate('2026-12-01', 'fr', TODAY)).toBe('mardi 1er décembre');
    expect(formatDate('2026-12-01', 'en', TODAY)).toBe('Tuesday 1 December');
  });

  it('adds the year only when it is not this year', () => {
    expect(formatDate('2027-01-02', 'fr', TODAY)).toBe('samedi 2 janvier 2027');
    expect(formatDate('2027-01-02', 'en', TODAY)).toBe('Saturday 2 January 2027');
    expect(formatDate('2027-01-02', 'es', TODAY)).toBe('sábado 2 de enero de 2027');
  });
});

describe('times in words', () => {
  it('follows each language’s convention', () => {
    expect(formatTime('20:00', 'fr')).toBe(`20${NBSP}h`);
    expect(formatTime('20:30', 'fr')).toBe(`20${NBSP}h${NBSP}30`);
    expect(formatTime('09:05', 'fr')).toBe(`9${NBSP}h${NBSP}05`);
    expect(formatTime('20:00', 'en')).toBe('8 pm');
    expect(formatTime('20:30', 'en')).toBe('8:30 pm');
    expect(formatTime('12:00', 'en')).toBe('12 pm');
    expect(formatTime('00:15', 'en')).toBe('12:15 am');
    expect(formatTime('20:30', 'es')).toBe('20:30');
    expect(formatTime('09:00', 'es')).toBe('9:00');
  });

  it('agrees the Spanish article with one o’clock', () => {
    expect(formatDateAtTime('2026-10-16', '13:00', 'es', TODAY)).toBe('viernes 16 de octubre a las 13:00');
    expect(formatDateAtTime('2026-10-16', '01:00', 'es', TODAY)).toBe('viernes 16 de octubre a la 1:00');
  });
});

describe('booking read-back', () => {
  it('reads the booking back the way a person would say it', () => {
    expect(formatBooking(4, '2026-10-16', '20:00', 'fr', TODAY)).toBe(
      `une table pour 4 personnes le vendredi 16 octobre à 20${NBSP}h`,
    );
    expect(formatBooking(4, '2026-10-16', '20:00', 'en', TODAY)).toBe('a table for 4 on Friday 16 October at 8 pm');
    expect(formatBooking(4, '2026-10-16', '20:00', 'es', TODAY)).toBe(
      'una mesa para 4 personas el viernes 16 de octubre a las 20:00',
    );
  });

  it('uses the singular for one guest', () => {
    expect(formatBooking(1, '2026-10-16', '12:30', 'fr', TODAY)).toContain('une table pour 1 personne le');
    expect(formatBooking(1, '2026-10-16', '12:30', 'en', TODAY)).toContain('a table for one on');
    expect(formatBooking(1, '2026-10-16', '12:30', 'es', TODAY)).toContain('una mesa para 1 persona el');
  });
});

describe('allergen sentences', () => {
  it('uses the right article in French', () => {
    const m = messages('fr');
    expect(m.dishContains('Confit de canard', 'gluten')).toBe(`Le plat «${THIN}Confit de canard${THIN}» contient du gluten.`);
    expect(m.dishFree('Tarte fine', 'eggs')).toContain('ne contient pas d’œufs.');
    expect(m.dishMayContain('Tarte fine', 'mustard')).toContain('peut contenir des traces de moutarde.');
    expect(m.dishContains('Tarte fine', 'mustard')).toContain('contient de la moutarde.');
  });

  it('never claims an allergen is absent when the sheet says nothing', () => {
    for (const language of LANGUAGES) {
      const sentence = messages(language).dishUnknown('Plat', 'nuts');
      expect(sentence).not.toMatch(/ne contient pas|contains no|no contiene/);
    }
  });
});

/** Every sentence the engine can produce, in one language, for the typography checks below. */
function everySentence(language: Language): string[] {
  const m = messages(language);
  const sentences = [
    formatBooking(4, '2026-10-16', '20:30', language, TODAY),
    formatBooking(1, '2027-01-01', '12:00', language, TODAY),
    formatDateAtTime('2026-12-01', '09:05', language, TODAY),
  ];
  for (const allergen of ALLERGENS) {
    sentences.push(
      m.allergen(allergen),
      m.dishContains('Plat', allergen),
      m.dishMayContain('Plat', allergen),
      m.dishFree('Plat', allergen),
      m.dishUnknown('Plat', allergen),
    );
  }
  sentences.push(m.allergenQuestion('Plat', ['nuts']), m.allergenQuestion('Plat', ['milk', 'sesame']));
  for (const channel of ['web', 'whatsapp', 'voice', 'staff'] as const) sentences.push(m.greeting('Le Bistro', channel));
  sentences.push(m.failureHandedOver(), m.failureRetry(), m.emptyMessage(), m.walkInGuest());
  return sentences;
}

describe('the first words of a conversation', () => {
  it('say on the phone that the assistant is an AI and that the call may be recorded', () => {
    expect(messages('fr').greeting('Le Bistro', 'voice')).toMatch(/intelligence artificielle[\s\S]*enregistré/);
    expect(messages('en').greeting('Le Bistro', 'voice')).toMatch(/an AI[\s\S]*recorded/);
    expect(messages('es').greeting('Le Bistro', 'voice')).toMatch(/inteligencia artificial[\s\S]*grabada/);
  });

  it('name the business in every language and channel', () => {
    for (const language of LANGUAGES) {
      for (const channel of ['web', 'whatsapp', 'voice', 'staff'] as const) {
        expect(messages(language).greeting('Le Bistro', channel)).toContain('Le Bistro');
      }
    }
  });
});

describe('typography', () => {
  it('never uses an em dash or an en dash', () => {
    for (const language of LANGUAGES) {
      for (const sentence of everySentence(language)) expect(sentence).not.toMatch(/[–—]/);
    }
  });

  it('never leaves a double space or a space before a full stop', () => {
    for (const language of LANGUAGES) {
      for (const sentence of everySentence(language)) {
        expect(sentence).not.toMatch(/ {2}/);
        expect(sentence).not.toMatch(/ \./);
      }
    }
  });

  it('puts a non-breaking space before French double punctuation and inside guillemets', () => {
    for (const sentence of everySentence('fr')) {
      expect(sentence).not.toMatch(/[^  ][;:!?»]/);
      expect(sentence).not.toMatch(/«[^ ]/);
    }
  });

  it('uses the typographic apostrophe in French', () => {
    for (const sentence of everySentence('fr')) expect(sentence).not.toContain("'");
  });

  it('names all fourteen allergens in every language', () => {
    for (const language of LANGUAGES) {
      const names = ALLERGENS.map((allergen) => messages(language).allergen(allergen));
      expect(new Set(names).size).toBe(ALLERGENS.length);
    }
  });
});
