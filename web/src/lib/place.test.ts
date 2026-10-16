import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPlace, takePlace } from './place';

const LEFT = Date.parse('2026-10-16T18:05:00.000Z');
const PLACE = {
  path: '/en/panel/',
  at: LEFT,
  panel: { date: '2026-10-17', service: 'lunch', view: 'plan', table: '5', booking: 'AB12CD', days: 30, scrolled: { '.section__body': 500 } },
} as const;

let items: Map<string, string>;

beforeEach(() => {
  items = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the panel’s place, carried to the panel in another language', () => {
  it('is taken by the page it was left for, within seconds, once', () => {
    keepPlace(PLACE);
    expect(takePlace('/en/panel/', LEFT + 1200)).toEqual(PLACE);
    expect(takePlace('/en/panel/', LEFT + 1300)).toBeNull();
  });

  it('is not taken by another page, nor long after, and is gone either way', () => {
    keepPlace(PLACE);
    expect(takePlace('/es/panel/', LEFT + 1200)).toBeNull();
    expect(takePlace('/en/panel/', LEFT + 1300)).toBeNull();
    keepPlace(PLACE);
    expect(takePlace('/en/panel/', LEFT + 60_000)).toBeNull();
  });

  it('drops what this code never writes: a day that does not exist, another view, a part that does not scroll', () => {
    items.set(
      'maitre.place',
      JSON.stringify({
        path: '/en/panel/',
        at: LEFT,
        panel: { date: '2026-02-30', view: 'grid', table: 5, days: 30, scrolled: { '.section__body': 500, 'body > script': 40, '.side__list': -3 } },
      }),
    );
    expect(takePlace('/en/panel/', LEFT + 1000)?.panel).toEqual({ days: 30, scrolled: { '.section__body': 500 } });
  });

  it('is nothing at all when what is kept is not one', () => {
    items.set('maitre.place', '{"path": "/en/panel/"');
    expect(takePlace('/en/panel/', LEFT)).toBeNull();
    items.set('maitre.place', JSON.stringify({ path: '/en/panel/', at: 'now' }));
    expect(takePlace('/en/panel/', LEFT)).toBeNull();
  });
});
