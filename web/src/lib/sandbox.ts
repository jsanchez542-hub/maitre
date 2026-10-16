import type { ServiceDay } from 'maitre';
import type { Line } from './chat';
import { bookedFrom, callOfferFrom, type Booked, type CallOffer, type Sandbox, type Turn } from './live';

const KEY = 'maitre.sandbox';
/** A restaurant about to expire is not worth a conversation: a new one is opened instead. */
const MARGIN_MS = 5 * 60_000;

/** The visitor's own restaurant, kept in the browser for as long as it lives (24 hours). */
export interface StoredSandbox {
  id: string;
  expiresAt: string;
  /** The restaurant's clock when it opened: everything after it is the visitor's doing. */
  openedAt: string;
  /** Bookings the chat or a call made, oldest first: the panel marks them new and opens on the last one. */
  booked: Booked[];
  /** What the chat or a call did last, for the panel to announce once. */
  news?: 'booked' | 'passed';
  /** The calls the restaurant takes; unknown for one kept from before the demo took calls. */
  calls?: CallOffer | null;
  /** The chat's conversation, kept with its restaurant and gone with it. */
  chat?: StoredChat;
}

/** A conversation of the chat as the visitor left it: a reload, or the panel and back, picks it up there. */
export interface StoredChat {
  session: string;
  lines: Line[];
  /** The assistant asked for the number: its field is open. */
  askingPhone: boolean;
  /** It booked a table or passed a request on: the way to the panel shows. */
  left: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function linesFrom(value: unknown): Line[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line): Line[] => {
    if (!isRecord(line) || typeof line['id'] !== 'number') return [];
    const id = line['id'];
    if ((line['from'] === 'agent' || line['from'] === 'guest') && typeof line['text'] === 'string') return [{ id, from: line['from'], text: line['text'] }];
    if (line['from'] === 'booking' && typeof line['readBack'] === 'string' && typeof line['reference'] === 'string') {
      return [{ id, from: 'booking', readBack: line['readBack'], reference: line['reference'] }];
    }
    if (line['from'] === 'phone' && typeof line['number'] === 'string') return [{ id, from: 'phone', number: line['number'] }];
    return [];
  });
}

function chatFrom(value: unknown): StoredChat | undefined {
  if (!isRecord(value) || typeof value['session'] !== 'string') return undefined;
  const lines = linesFrom(value['lines']);
  if (lines.length === 0) return undefined;
  return { session: value['session'], lines, askingPhone: value['askingPhone'] === true, left: value['left'] === true };
}

function read(): StoredSandbox | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['expiresAt'] !== 'string' || typeof value['openedAt'] !== 'string') return null;
    const chat = chatFrom(value['chat']);
    return {
      id: value['id'],
      expiresAt: value['expiresAt'],
      openedAt: value['openedAt'],
      booked: bookedFrom(value['booked']),
      ...(value['news'] === 'booked' || value['news'] === 'passed' ? { news: value['news'] } : {}),
      ...('calls' in value ? { calls: callOfferFrom(value['calls']) } : {}),
      ...(chat ? { chat } : {}),
    };
  } catch {
    // Storage refused (a private window, blocked site data): the visitor gets a new restaurant each time.
    return null;
  }
}

function write(sandbox: StoredSandbox): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sandbox));
  } catch {
    // Same as above: the restaurant still works for this page, it is just not remembered.
  }
}

/** The visitor's restaurant, unless there is none or it is about to expire: then it goes, its conversation with it. */
export function currentSandbox(now = Date.now()): StoredSandbox | null {
  const stored = read();
  if (!stored) return null;
  if (Date.parse(stored.expiresAt) - MARGIN_MS > now) return stored;
  forgetSandbox();
  return null;
}

export function keepSandbox(sandbox: Sandbox): StoredSandbox {
  const stored: StoredSandbox = { id: sandbox.id, expiresAt: sandbox.expiresAt, openedAt: sandbox.clock, booked: [], calls: sandbox.calls };
  write(stored);
  return stored;
}

/** The restaurant answered that it no longer exists: the next visit opens another. */
export function forgetSandbox(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget without storage.
  }
}

/** The chat's conversation, kept with its restaurant; none, once the visitor starts another. */
export function keepChat(sandbox: string, chat: StoredChat | null): void {
  const stored = read();
  if (!stored || stored.id !== sandbox) return;
  const next: StoredSandbox = { ...stored };
  if (chat) next.chat = chat;
  else delete next.chat;
  write(next);
}

/** What a turn of the chat, or a call, left for the panel: the bookings it made, and a request passed to the team. */
export function recordTurn(sandbox: string, turn: Pick<Turn, 'booked' | 'passedToTeam'>): void {
  const stored = read();
  if (!stored || stored.id !== sandbox || (turn.booked.length === 0 && !turn.passedToTeam)) return;
  const references = new Set(turn.booked.map((booking) => booking.reference));
  write({
    ...stored,
    booked: [...stored.booked.filter((booking) => !references.has(booking.reference)), ...turn.booked],
    news: turn.booked.length > 0 ? 'booked' : 'passed',
  });
}

/**
 * What a call left in the restaurant, read from its days afterwards: the bookings made on the line since it began,
 * oldest first, whichever day they are for, and whether it passed a request to the team.
 */
export function noteOfCall(days: readonly ServiceDay[], since: string): Pick<Turn, 'booked' | 'passedToTeam'> {
  const onTheLine = (entry: { channel: string; createdAt: string }) => entry.channel === 'voice' && entry.createdAt >= since;
  const booked = days
    .flatMap((day) => day.bookings.filter(onTheLine).map((booking) => ({ booking, date: day.date })))
    .sort((a, b) => a.booking.createdAt.localeCompare(b.booking.createdAt))
    .map(({ booking, date }) => ({ reference: booking.reference, date, time: booking.time, partySize: booking.partySize }));
  return { booked, passedToTeam: days.some((day) => day.callbacks.list.some(onTheLine)) };
}

/** The chat's or a call's latest news, once: the panel announces it and it is not announced again. */
export function takeNews(sandbox: string): StoredSandbox['news'] {
  const stored = read();
  if (!stored || stored.id !== sandbox || !stored.news) return undefined;
  const { news, ...rest } = stored;
  write(rest);
  return news;
}
