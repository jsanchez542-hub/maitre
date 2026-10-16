import type { ChatOutcome } from 'maitre/demo/chat';

const KEY = 'maitre.chat';

/** The conversations the visitor played in the chat, oldest first, so the panel can show what they booked. */
export function readPlayed(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-5) : [];
  } catch {
    // Storage can be refused (a private window, blocked site data): the panel then shows the evening as it is.
    return [];
  }
}

export function rememberPlayed(id: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...readPlayed().filter((other) => other !== id), id].slice(-5)));
  } catch {
    // Same as above: without storage the chat still works, the panel just will not show the booking.
  }
}

/** A booking made in the chat, recognised in the evening by its day, time and name. */
export function chatKey(booking: Pick<ChatOutcome['bookings'][number], 'date' | 'time' | 'guestName'>): string {
  return `${booking.date} ${booking.time} ${booking.guestName}`;
}
