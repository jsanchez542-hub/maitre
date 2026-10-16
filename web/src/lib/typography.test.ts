import { describe, expect, it } from 'vitest';
import { NNBSP, typeset } from './typography';

describe('numbers and their units', () => {
  it('keeps a number with the word after it', () => {
    expect(typeset('une table pour 4 personnes le vendredi 16 octobre à 20 h')).toBe(
      `une table pour 4${NNBSP}personnes le vendredi 16${NNBSP}octobre à 20${NNBSP}h`,
    );
    expect(typeset('a table for 2 on Saturday 24 October at 8 pm')).toBe(`a table for 2${NNBSP}on Saturday 24${NNBSP}October at 8${NNBSP}pm`);
  });

  it('keeps a French time whole, and gives the word after its minutes an ordinary space', () => {
    expect(typeset('une table à 21 h 30 est disponible')).toBe(`une table à 21${NNBSP}h${NNBSP}30 est disponible`);
    expect(typeset(`à 21${NNBSP}h 30 est disponible`)).toBe(`à 21${NNBSP}h${NNBSP}30 est disponible`);
    expect(typeset('una mesa a las 21:30 está libre')).toBe('una mesa a las 21:30 está libre');
  });

  it('keeps am and pm with the time they belong to', () => {
    expect(typeset('a table at 8:30 pm is free')).toBe(`a table at 8:30${NNBSP}pm is free`);
  });

  it('keeps a price with its sign', () => {
    expect(typeset('25 € par personne')).toBe(`25${NNBSP}€ par personne`);
  });

  it('leaves alone what is not a number and its unit', () => {
    for (const text of ['+33 6 39 98 00 10', 'Référence VKFUUU', 'à 20:00, puis 21:30', 'octobre 2026']) {
      expect(typeset(text)).toBe(text);
    }
  });
});

describe('apostrophes', () => {
  it('sets an apostrophe inside a word as the typographic one', () => {
    expect(typeset("est-ce que l'un de vos convives")).toBe('est-ce que l’un de vos convives');
    expect(typeset("please don't order the chocolate mousse")).toBe('please don’t order the chocolate mousse');
  });

  it('leaves alone quotation marks and apostrophes already set', () => {
    for (const text of ["the 'house' wine", "rock 'n' roll", 'à rappeler par l’équipe']) {
      expect(typeset(text)).toBe(text);
    }
  });
});
