import { isPlainDate, type PlainDate } from 'maitre';

/**
 * Where the visitor stands in the panel, carried to the same panel in the language they switch to: the language links
 * lead to the panel's start, and a visitor in the settings, or on Saturday's lunch, would land on today's service. It
 * is kept for the page it is meant for, and taken once, within seconds.
 */
export interface Place {
  /** The page it is for: another page never takes it. */
  path: string;
  /** When it was left. A place older than a few seconds belongs to another visit, not to the switch. */
  at: number;
  panel: PanelPlace;
}

/**
 * The day, its service, how the room is shown, what is open, and how far each part has scrolled. The panel's screens
 * keep it up to date as the visitor moves, and start from it.
 */
export interface PanelPlace {
  date?: PlainDate | undefined;
  service?: string | undefined;
  view?: 'list' | 'plan' | undefined;
  table?: string | null | undefined;
  booking?: string | null | undefined;
  conversation?: string | null | undefined;
  days?: number | undefined;
  scrolled?: Record<string, number> | undefined;
}

const KEY = 'maitre.place';
const FRESH_MS = 15_000;
/** The panel's parts that scroll on their own, on a desk; on a phone the page scrolls, and the language links are at its top. */
const SCROLLERS: readonly string[] = ['.section__body', '.side__list', '.card', '.log__list', '.log__conversation'];
const RESTORE_MS = 2000;

const text = (value: unknown, longest: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= longest ? value : undefined;

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const field = (value: object, key: string): unknown => (Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined);

/** Only what this code writes is taken back: a field of another shape is dropped. */
function panelOf(value: unknown): PanelPlace {
  const place: PanelPlace = {};
  if (typeof value !== 'object' || value === null) return place;
  const date = text(field(value, 'date'), 10);
  if (date && isPlainDate(date)) place.date = date;
  const service = text(field(value, 'service'), 40);
  if (service) place.service = service;
  const view = field(value, 'view');
  if (view === 'list' || view === 'plan') place.view = view;
  const table = text(field(value, 'table'), 20);
  if (table) place.table = table;
  const booking = text(field(value, 'booking'), 40);
  if (booking) place.booking = booking;
  const conversation = text(field(value, 'conversation'), 80);
  if (conversation) place.conversation = conversation;
  const days = count(field(value, 'days'));
  if (days !== undefined) place.days = days;
  const scrolled = field(value, 'scrolled');
  if (typeof scrolled === 'object' && scrolled !== null) {
    place.scrolled = {};
    for (const name of SCROLLERS) {
      const top = count(field(scrolled, name));
      if (top !== undefined && top > 0) place.scrolled[name] = top;
    }
  }
  return place;
}

export function keepPlace(place: Place): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(place));
  } catch {
    // Storage refused, as a private window may: the panel in the other language opens at its start, as before.
  }
}

/** The place left for this page, once: taken, it is gone, whatever page it was for. */
export function takePlace(path: string, now = Date.now()): Place | null {
  let stored: unknown;
  try {
    stored = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) return null;
  const at = count(field(stored, 'at'));
  if (field(stored, 'path') !== path || at === undefined || at > now || now - at > FRESH_MS) return null;
  return { path, at, panel: panelOf(field(stored, 'panel')) };
}

/** How far each of the panel's parts on screen has scrolled. */
export function readScrolled(): Record<string, number> {
  const scrolled: Record<string, number> = {};
  for (const name of SCROLLERS) {
    const top = document.querySelector(name)?.scrollTop ?? 0;
    if (top > 0) scrolled[name] = top;
  }
  return scrolled;
}

/**
 * Each part scrolled back as it was, once its content is there to scroll: the panel reads its day, its conversations and
 * its figures after it opens. Tried on every frame for two seconds, then left as far as it goes.
 */
export function restoreScrolled(scrolled: Record<string, number>): void {
  const started = performance.now();
  const pending = new Map(Object.entries(scrolled));
  const step = () => {
    const late = performance.now() - started > RESTORE_MS;
    for (const [name, top] of pending) {
      const element = document.querySelector(name);
      if (!element) continue;
      const reach = element.scrollHeight - element.clientHeight;
      if (reach < top - 1 && !late) continue;
      element.scrollTop = Math.min(top, reach);
      pending.delete(name);
    }
    if (pending.size > 0 && !late) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
